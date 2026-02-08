import { db } from '@/firebase';
import type { ChatMessage, ChatParticipant, ChatThread, MediaMetadata, MessageType } from '@/models';
import {
  collection,
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
  getChatMessages,
  initMessageDB,
  markMessagesRead,
  saveMessageLocally,
  subscribeToLocalMessages,
  updateMessageStatus,
  waitForChatWrites,
} from '@/services/localMessageStorage';
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
}

interface ChatContextValue {
  threads: ChatThread[];
  loading: boolean;
  sendMessage: (payload: SendMessagePayload) => Promise<void>;
  subscribeToMessages: (chatId: string, onData: (messages: ChatMessage[]) => void) => () => void;
  ensureGroupThread: (groupId: string, participants: ChatParticipant[]) => Promise<string>;
  markChatAsRead: (chatId: string) => Promise<void>;
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

      pendingLoadTimer = setTimeout(() => {
        pendingLoadTimer = null;
        void loadLocalMessages();
      }, 75);
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
      unsubscribeLocal();
    };
  }, [getRecipientCount, getThreadByChatId]);

  const sendMessage = useCallback(
    async ({ chatId, content, type = 'text', mediaUri, mediaMetadata, groupId, replyTo, location }: SendMessagePayload) => {
      if (!user) {
        throw new Error('Missing user for chat send');
      }

      const msgId = uuid();
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
        chatId,
        senderId: user.userId,
        type,
        content,
        ...(localMediaPath ? { localMediaPath, mediaDownloaded: true } : {}),
        ...(mediaMetadata ? { mediaMetadata } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(location ? { location } : {}),
        status: 'sending',
        createdAt: now,
        timestamp: now,
        isFromMe: true,
        deliveredTo: [],
        readBy: [],
      };

      await saveMessageLocally(message);

      (async () => {
        try {
          let mediaUrl: string | undefined;
          let permanentLocalPath: string | undefined;

          if (mediaUri && type !== 'text') {
            const fileName = mediaMetadata?.fileName || `${type}_${msgId}`;
            const mimeType = mediaMetadata?.mimeType || 'application/octet-stream';

            console.log('📤 Uploading media to Firebase Storage...');

            const uploadResult = await uploadMedia(
              localMediaPath || mediaUri,
              chatId,
              msgId,
              fileName,
              mimeType,
              (progress) => {
                console.log(`📤 Upload progress: ${progress.toFixed(1)}%`);
              }
            );

            mediaUrl = uploadResult.downloadUrl;
            permanentLocalPath = uploadResult.localPath;

            console.log('✅ Media uploaded successfully:', mediaUrl);

            message.mediaUrl = mediaUrl;
            message.localMediaPath = permanentLocalPath;
            message.mediaDownloaded = true;
          }

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
        } catch (error) {
          console.error('Send failed', error);
          message.status = 'failed';
          await saveMessageLocally(message);
        }
      })();
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

  const value = useMemo(
    () => ({ threads, loading, sendMessage, subscribeToMessages, ensureGroupThread, markChatAsRead }),
    [ensureGroupThread, loading, markChatAsRead, sendMessage, subscribeToMessages, threads],
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
