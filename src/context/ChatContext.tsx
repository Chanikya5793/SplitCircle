import { db } from '@/firebase';
import type { ChatMessage, ChatParticipant, ChatThread, ForwardedFrom, MediaMetadata, MessageType, PinnedMessageRef } from '@/models';
import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteField,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import {
  applyRemoteMessageState,
  getChatMessages,
  initMessageDB,
  markMessagesRead,
  saveMessageLocally,
  subscribeToLocalMessages,
  updateMessageStatus,
  waitForChatWrites,
} from '@/services/localMessageStorage';
import { subscribeToMessageStates } from '@/services/messageStateService';
import {
  copyToLocalStorage,
  initMediaDirectory,
  uploadMedia,
} from '@/services/mediaService';
import {
  listenForMessages,
  listenForReceipts,
  queueMessage,
  registerReceiptParticipant,
  sendBulkReadReceipts,
} from '@/services/messageQueueService';
import { useAuth } from '@/context/AuthContext';

interface SendMessagePayload {
  chatId: string;
  requestId?: string;
  content: string;
  type?: MessageType;
  mediaUri?: string;
  mediaMetadata?: MediaMetadata;
  groupId?: string;
  replyTo?: {
    messageId: string;
    senderId: string;
    senderName: string;
    content: string;
    type?: MessageType;
  };
  location?: {
    latitude: number;
    longitude: number;
    address?: string;
  };
  forwardedFrom?: ForwardedFrom;
  mentions?: string[];
  onStageChange?: (
    stage: 'preparing' | 'uploading' | 'sending' | 'complete' | 'failed',
    details?: { progress?: number; message?: string },
  ) => void;
}

interface ChatContextValue {
  threads: ChatThread[];
  loading: boolean;
  sendMessage: (payload: SendMessagePayload) => Promise<void>;
  subscribeToMessages: (chatId: string, onData: (messages: ChatMessage[]) => void) => () => void;
  ensureGroupThread: (groupId: string, participants: ChatParticipant[]) => Promise<string>;
  ensureDirectThread: (otherParticipant: ChatParticipant) => Promise<string>;
  markChatAsRead: (chatId: string) => Promise<void>;
  togglePinMessage: (chatId: string, message: ChatMessage) => Promise<void>;
  deleteMessageForEveryone: (chatId: string, messageId: string) => Promise<void>;
  setTyping: (chatId: string, isTyping: boolean) => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

const normalizeTimestamp = (value: unknown): number => {
  if (!value) return Date.now();
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null) {
    const maybeTimestamp = value as { toMillis?: () => number; seconds?: number; nanoseconds?: number };
    if (maybeTimestamp.toMillis) {
      return maybeTimestamp.toMillis();
    }
    if (typeof maybeTimestamp.seconds === 'number') {
      return maybeTimestamp.seconds * 1000;
    }
  }
  return Date.now();
};

const removeUndefined = <T extends Record<string, unknown>>(obj: T): Partial<T> => {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    const value = obj[key];
    if (value !== undefined) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = removeUndefined(value as Record<string, unknown>) as T[keyof T];
      } else {
        result[key] = value;
      }
    }
  }
  return result;
};

const sortMessagesForUi = (messages: ChatMessage[]): ChatMessage[] => {
  return [...messages].sort((a, b) => b.createdAt - a.createdAt);
};

const getMessageTypeLabel = (type: MessageType): string => {
  switch (type) {
    case 'image':
      return 'photo';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'file':
      return 'document';
    case 'location':
      return 'location';
    default:
      return 'message';
  }
};

export const ChatProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { user } = useAuth();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [loading, setLoading] = useState(true);

  const threadsRef = useRef<ChatThread[]>([]);
  const userRef = useRef<typeof user | null>(null);
  const activeChatIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const getThreadByChatId = useCallback((chatId: string): ChatThread | undefined => {
    return threadsRef.current.find((thread) => thread.chatId === chatId);
  }, []);

  const getRecipientCount = useCallback((thread: ChatThread | undefined, fallbackUserId?: string): number | undefined => {
    if (!thread) {
      return undefined;
    }

    const currentUserId = fallbackUserId ?? userRef.current?.userId;
    if (!currentUserId) {
      return undefined;
    }

    if (Array.isArray(thread.participants) && thread.participants.length > 0) {
      const recipients = thread.participants.filter((participant) => participant.userId !== currentUserId).length;
      return Math.max(recipients, 1);
    }

    if (Array.isArray(thread.participantIds) && thread.participantIds.length > 0) {
      const recipients = thread.participantIds.filter((participantId) => participantId !== currentUserId).length;
      return Math.max(recipients, 1);
    }

    return undefined;
  }, []);

  const markChatAsRead = useCallback(async (chatId: string) => {
    const currentUser = userRef.current;
    if (!currentUser) {
      return;
    }

    await waitForChatWrites(chatId);

    const thread = getThreadByChatId(chatId);
    const isGroupChat = thread?.type === 'group';
    const recipientCount = getRecipientCount(thread, currentUser.userId);

    const messages = await getChatMessages(chatId);
    const unreadMessageIds = messages
      .filter((msg) =>
        msg.senderId !== currentUser.userId &&
        (!msg.readBy || !msg.readBy.includes(currentUser.userId))
      )
      .map((msg) => msg.id);

    if (unreadMessageIds.length === 0) {
      return;
    }

    console.log(`📖 Marking ${unreadMessageIds.length} messages as read`);

    await markMessagesRead(chatId, unreadMessageIds, currentUser.userId, recipientCount);
    await sendBulkReadReceipts(chatId, unreadMessageIds, currentUser.userId, isGroupChat);

    console.log('✅ Read receipts sent');
  }, [getRecipientCount, getThreadByChatId]);

  // Initialize local message DB and media storage once
  useEffect(() => {
    const initDB = async () => {
      try {
        await initMessageDB();
        await initMediaDirectory();
        console.log('✅ Message and media storage initialized');
      } catch (error) {
        console.error('❌ Failed to initialize database:', error);
      }
    };

    void initDB();
  }, []);

  // Firestore chat thread subscription
  useEffect(() => {
    if (!user) {
      setThreads([]);
      setLoading(false);
      return () => undefined;
    }

    const chatsRef = collection(db, 'chats');
    const q = query(chatsRef, where('participantIds', 'array-contains', user.userId));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const payload = snapshot.docs.map((docSnap) => {
        const data = docSnap.data() as ChatThread & { lastMessage?: ChatMessage };
        return {
          ...data,
          participantIds: data.participantIds ?? data.participants.map((participant) => participant.userId),
          lastMessage: data.lastMessage
            ? { ...data.lastMessage, createdAt: normalizeTimestamp(data.lastMessage.createdAt) }
            : undefined,
          updatedAt: data.updatedAt ? normalizeTimestamp(data.updatedAt) : undefined,
        } satisfies ChatThread;
      });

      setThreads(payload);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user?.userId]);

  // Register the current user as a receipt participant for all known chats.
  useEffect(() => {
    if (!user) {
      return;
    }

    const registerAll = async () => {
      await Promise.allSettled(
        threads.map((thread) => registerReceiptParticipant(thread.chatId, user.userId))
      );
    };

    void registerAll();
  }, [threads, user?.userId]);

  // Singleton queue listener (always active while authenticated).
  useEffect(() => {
    if (!user) {
      return () => undefined;
    }

    const unsubscribe = listenForMessages(user.userId, async (message) => {
      await saveMessageLocally(message);

      if (activeChatIdsRef.current.has(message.chatId)) {
        await markChatAsRead(message.chatId);
      }
    });

    return () => unsubscribe();
  }, [markChatAsRead, user?.userId]);

  const subscribeToMessages = useCallback((chatId: string, onData: (messages: ChatMessage[]) => void) => {
    const currentUser = userRef.current;
    if (!currentUser) {
      return () => undefined;
    }

    activeChatIdsRef.current.add(chatId);

    let disposed = false;
    let pendingLoadTimer: ReturnType<typeof setTimeout> | null = null;
    let receiptRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribeReceipts: (() => void) | null = null;
    let isStartingReceiptListener = false;

    const loadLocalMessages = async () => {
      await waitForChatWrites(chatId);
      const localMessages = await getChatMessages(chatId);

      if (disposed) {
        return;
      }

      onData(sortMessagesForUi(localMessages));
    };

    const scheduleLocalLoad = (immediate: boolean = false) => {
      if (disposed) {
        return;
      }

      if (immediate) {
        void loadLocalMessages();
        return;
      }

      if (pendingLoadTimer) {
        return;
      }

      // 16ms ≈ one display frame: fast enough that local mutations
      // (reaction toggle, star, edit) feel instant, while still coalescing
      // bursts so we don't reload AsyncStorage per char on rapid typing.
      pendingLoadTimer = setTimeout(() => {
        pendingLoadTimer = null;
        void loadLocalMessages();
      }, 16);
    };

    const clearReceiptRetryTimer = () => {
      if (!receiptRetryTimer) {
        return;
      }
      clearTimeout(receiptRetryTimer);
      receiptRetryTimer = null;
    };

    const scheduleReceiptListenerRetry = () => {
      if (disposed || receiptRetryTimer) {
        return;
      }

      receiptRetryTimer = setTimeout(() => {
        receiptRetryTimer = null;
        void startReceiptListener();
      }, 600);
    };

    const startReceiptListener = async () => {
      if (disposed || unsubscribeReceipts || isStartingReceiptListener) {
        return;
      }

      isStartingReceiptListener = true;

      try {
        await registerReceiptParticipant(chatId, currentUser.userId);
        if (disposed) {
          return;
        }

        unsubscribeReceipts = listenForReceipts(
          chatId,
          async (messageId, status, recipientId, allDelivered, allRead) => {
            const latestThread = getThreadByChatId(chatId);
            const recipientCount = getRecipientCount(latestThread, currentUser.userId);

            const deliveredUsers = allDelivered ?? (recipientId ? [recipientId] : []);
            const readUsers = allRead ?? (status === 'read' && recipientId ? [recipientId] : []);

            await updateMessageStatus(
              chatId,
              messageId,
              status,
              deliveredUsers,
              readUsers,
              recipientCount,
            );
          },
          true,
          (error) => {
            const errorMessage = String(error?.message ?? error).toLowerCase();
            if (errorMessage.includes('permission_denied')) {
              console.warn('⚠️ Receipt listener permission denied; retrying after participant registration.');
            } else {
              console.warn('⚠️ Receipt listener cancelled; scheduling retry.', error);
            }

            if (unsubscribeReceipts) {
              unsubscribeReceipts();
              unsubscribeReceipts = null;
            }

            scheduleReceiptListenerRetry();
          },
        );
      } catch (error) {
        console.warn('⚠️ Failed to register receipt participant; scheduling retry.', error);
        scheduleReceiptListenerRetry();
      } finally {
        isStartingReceiptListener = false;
      }
    };

    scheduleLocalLoad(true);
    void startReceiptListener();

    // Cross-device mutation sync — reactions, edits, delete-for-everyone all
    // flow through chats/{chatId}/messageState. Each event is applied locally
    // (which fires notifyMessageListeners → schedules a UI reload).
    const unsubscribeMessageStates = subscribeToMessageStates(
      chatId,
      ({ messageId, state }) => {
        void applyRemoteMessageState(chatId, messageId, {
          reactions: state.reactions,
          deletedForEveryone: state.deletedForEveryone,
          editedContent: state.editedContent,
          editedAt: state.editedAt,
        });
      },
      (error) => {
        console.warn('⚠️ messageState listener error', error);
      },
    );

    const unsubscribeLocal = subscribeToLocalMessages(chatId, () => {
      scheduleLocalLoad(false);
    });

    return () => {
      disposed = true;
      activeChatIdsRef.current.delete(chatId);

      if (pendingLoadTimer) {
        clearTimeout(pendingLoadTimer);
      }

      clearReceiptRetryTimer();
      if (unsubscribeReceipts) {
        unsubscribeReceipts();
        unsubscribeReceipts = null;
      }
      unsubscribeMessageStates();
      unsubscribeLocal();
    };
  }, [getRecipientCount, getThreadByChatId]);

  const sendMessage = useCallback(
    async ({ chatId, requestId, content, type = 'text', mediaUri, mediaMetadata, groupId, replyTo, location, forwardedFrom, mentions, onStageChange }: SendMessagePayload) => {
      if (!user) {
        throw new Error('Missing user for chat send');
      }

      const msgId = requestId ?? uuid();
      const now = Date.now();

      let localMediaPath = mediaUri;

      if (mediaUri && type !== 'text') {
        try {
          const fileName = mediaMetadata?.fileName || `${type}_${msgId}`;
          localMediaPath = await copyToLocalStorage(mediaUri, chatId, msgId, fileName);
        } catch (error) {
          console.warn('Failed to copy media locally, using original URI', error);
        }
      }

      const message: ChatMessage = {
        id: msgId,
        messageId: msgId,
        requestId: requestId ?? msgId,
        chatId,
        senderId: user.userId,
        type,
        content,
        ...(localMediaPath ? { localMediaPath, mediaDownloaded: true } : {}),
        ...(mediaMetadata ? { mediaMetadata } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(location ? { location } : {}),
        ...(forwardedFrom ? { forwardedFrom } : {}),
        ...(mentions && mentions.length ? { mentions } : {}),
        status: 'sending',
        createdAt: now,
        timestamp: now,
        isFromMe: true,
        deliveredTo: [],
        readBy: [],
      };

      await saveMessageLocally(message);

      try {
        let mediaUrl: string | undefined;
        let permanentLocalPath: string | undefined;
        const typeLabel = getMessageTypeLabel(type);

        if (mediaUri && type !== 'text') {
          const fileName = mediaMetadata?.fileName || `${type}_${msgId}`;
          const mimeType = mediaMetadata?.mimeType || 'application/octet-stream';

          onStageChange?.('preparing', { message: `Preparing ${typeLabel} upload…` });
          console.log('📤 Uploading media to Firebase Storage...');

          const uploadResult = await uploadMedia(
            localMediaPath || mediaUri,
            chatId,
            msgId,
            fileName,
            mimeType,
            (progress) => {
              console.log(`📤 Upload progress: ${progress.toFixed(1)}%`);
              onStageChange?.('uploading', {
                progress,
                message: `Uploading ${typeLabel}… ${Math.round(progress)}%`,
              });
            }
          );

          mediaUrl = uploadResult.downloadUrl;
          permanentLocalPath = uploadResult.localPath;

          console.log('✅ Media uploaded successfully:', mediaUrl);

          message.mediaUrl = mediaUrl;
          message.localMediaPath = permanentLocalPath;
          message.mediaDownloaded = true;
        }

        onStageChange?.('sending', { message: `Sending ${typeLabel}…` });
        message.status = 'sent';
        await saveMessageLocally(message);

        const latestThread = getThreadByChatId(chatId);
        const participants = latestThread?.participants || [];
        const isGroupChat = latestThread?.type === 'group';
        const recipientIds = participants
          .map((participant) => participant.userId)
          .filter((participantId) => participantId !== user.userId);

        for (const recipientId of recipientIds) {
          await queueMessage(recipientId, message, isGroupChat);
        }

        console.log(`✅ ${type} message sent and queued`);

        const threadMessage = { ...message };
        delete (threadMessage as { localMediaPath?: string }).localMediaPath;
        const cleanMessage = removeUndefined({ ...threadMessage, createdAt: serverTimestamp() });

        await updateDoc(doc(db, 'chats', chatId), {
          lastMessage: cleanMessage,
          groupId: groupId ?? null,
          updatedAt: Date.now(),
        });

        onStageChange?.('complete');
      } catch (error) {
        console.error('Send failed', error);
        message.status = 'failed';
        await saveMessageLocally(message);
        onStageChange?.('failed', {
          message: error instanceof Error ? error.message : 'Failed to send message',
        });
        throw error;
      }
    },
    [getThreadByChatId, user],
  );

  const ensureGroupThread = useCallback(
    async (groupId: string, participants: ChatParticipant[]) => {
      if (!user) {
        throw new Error('Missing user context');
      }

      const existing = threads.find((thread) => thread.groupId === groupId);
      if (existing) {
        return existing.chatId;
      }

      const chatId = uuid();
      await setDoc(doc(db, 'chats', chatId), {
        chatId,
        type: 'group',
        participantIds: participants.map((participant) => participant.userId),
        participants,
        groupId,
        unreadCount: 0,
        updatedAt: Date.now(),
      } satisfies Partial<ChatThread>);

      return chatId;
    },
    [threads, user],
  );

  const ensureDirectThread = useCallback(
    async (otherParticipant: ChatParticipant) => {
      if (!user) {
        throw new Error('Missing user context');
      }
      if (!otherParticipant?.userId || otherParticipant.userId === user.userId) {
        throw new Error('Invalid direct-thread participant');
      }

      // Deterministic ID so both sides always reach the same thread doc.
      const [a, b] = [user.userId, otherParticipant.userId].sort();
      const chatId = `direct_${a}_${b}`;

      const existing = threads.find((thread) => thread.chatId === chatId);
      if (existing) return chatId;

      const me: ChatParticipant = {
        userId: user.userId,
        displayName: user.displayName ?? 'You',
        photoURL: user.photoURL ?? undefined,
        status: 'online',
      };
      const participants: ChatParticipant[] = [me, otherParticipant];

      // setDoc with merge: tolerates both sides racing on first open.
      await setDoc(
        doc(db, 'chats', chatId),
        {
          chatId,
          type: 'direct',
          participantIds: [a, b],
          participants,
          unreadCount: 0,
          updatedAt: Date.now(),
        } satisfies Partial<ChatThread>,
        { merge: true },
      );

      return chatId;
    },
    [threads, user],
  );

  const togglePinMessage = useCallback(
    async (chatId: string, message: ChatMessage) => {
      if (!user) return;
      const chatDoc = doc(db, 'chats', chatId);
      const thread = getThreadByChatId(chatId);
      const existing = thread?.pinnedMessages?.find((p) => p.messageId === message.messageId);

      if (existing) {
        await updateDoc(chatDoc, {
          pinnedMessages: arrayRemove(existing),
        });
        return;
      }

      const ref: PinnedMessageRef = {
        messageId: message.messageId,
        pinnedBy: user.userId,
        pinnedAt: Date.now(),
        contentPreview: message.content?.slice(0, 140),
        type: message.type,
        senderId: message.senderId,
      };
      await updateDoc(chatDoc, {
        pinnedMessages: arrayUnion(ref),
      });
    },
    [getThreadByChatId, user],
  );

  const deleteMessageForEveryone = useCallback(
    async (chatId: string, messageId: string) => {
      if (!user) return;
      // Local fast path — UI updates as soon as this returns.
      const { saveMessageLocally, getChatMessages } = await import('@/services/localMessageStorage');
      const messages = await getChatMessages(chatId);
      const target = messages.find((m) => m.id === messageId || m.messageId === messageId);
      if (!target) return;

      await saveMessageLocally({
        ...target,
        deletedForEveryone: true,
        content: '',
      });

      // Realtime broadcast via messageState sub-collection — every other open
      // chat session will pick this up via its onSnapshot listener.
      const { publishMessageState } = await import('@/services/messageStateService');
      await publishMessageState(chatId, messageId, { deletedForEveryone: true });

      // Also push via the message queue so recipients who are offline (and thus
      // not subscribed to the messageState onSnapshot) will see the deletion
      // when they come back online and process their queue.
      const thread = getThreadByChatId(chatId);
      if (thread) {
        const recipientIds = thread.participants
          .map((p) => p.userId)
          .filter((id) => id !== user.userId);

        const tombstone: ChatMessage = {
          ...target,
          deletedForEveryone: true,
          content: '',
        };

        const isGroupChat = thread.type === 'group';
        for (const recipientId of recipientIds) {
          await queueMessage(recipientId, tombstone, isGroupChat);
        }
      }
    },
    [getThreadByChatId, user],
  );

  const setTyping = useCallback(
    async (chatId: string, isTyping: boolean) => {
      if (!user) return;
      const chatDoc = doc(db, 'chats', chatId);
      try {
        if (isTyping) {
          await updateDoc(chatDoc, {
            [`typing.${user.userId}`]: Date.now(),
          });
        } else {
          await updateDoc(chatDoc, {
            [`typing.${user.userId}`]: deleteField(),
          });
        }
      } catch (error) {
        // Typing presence is best-effort — non-blocking.
        console.warn('setTyping failed', error);
      }
    },
    [user],
  );

  const value = useMemo(
    () => ({
      threads,
      loading,
      sendMessage,
      subscribeToMessages,
      ensureGroupThread,
      ensureDirectThread,
      markChatAsRead,
      togglePinMessage,
      deleteMessageForEveryone,
      setTyping,
    }),
    [
      ensureGroupThread,
      ensureDirectThread,
      loading,
      markChatAsRead,
      sendMessage,
      subscribeToMessages,
      threads,
      togglePinMessage,
      deleteMessageForEveryone,
      setTyping,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used inside ChatProvider');
  }
  return context;
};
