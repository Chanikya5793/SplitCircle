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
import { Platform } from 'react-native';
import { v4 as uuid } from 'uuid';
import {
  applyRemoteMessageState,
  deleteMessageLocally,
  getChatMessages,
  getChatMessagesPaginated,
  initMessageDB,
  markMessagesRead,
  saveMessageLocally,
  subscribeToLocalMessages,
  updateMessageStatus,
  waitForChatWrites,
} from '@/services/localMessageStorage';
import {
  clearSendProgress,
  setSendFraction,
  setSendProgress,
} from '@/services/mediaSendProgress';
import { subscribeToMessageStates } from '@/services/messageStateService';
import {
  copyToLocalStorage,
  initMediaDirectory,
  uploadMedia,
} from '@/services/mediaService';
import { getCurrentDeviceId } from '@/services/pairingService';
import {
  listenForMessages,
  listenForMessagesOnDevice,
  listenForReceipts,
  queueMessage,
  queueMessageToOwnDevices,
  registerReceiptParticipant,
  sendBulkReadReceipts,
} from '@/services/messageQueueService';
import { useAuth } from '@/context/AuthContext';
import { dismissNotificationsForEntity } from '@/utils/notifications';
import { resolveDisplayName } from '@/utils/identity';
import { diffRemovedChatIds } from '@/utils/notificationEntityMatch';

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
  loadMoreMessages: (chatId: string, before: number) => Promise<{ messages: ChatMessage[]; hasMore: boolean }>;
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

  // Chat ids from the previous snapshot. When a chat vanishes between
  // snapshots (deleted by another participant, or this user removed), we
  // withdraw delivered message/missed-call notifications on THIS device that
  // deep-link to it. null until the first snapshot arrives so an initial load
  // never looks like a mass deletion.
  const knownChatIdsRef = useRef<Set<string> | null>(null);

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
        // Drain any pending message state mutations from prior offline sessions
        const { drain } = await import('@/services/pendingStateQueue');
        await drain();
      } catch (error) {
        console.error('❌ Failed to initialize database:', error);
      }
    };

    void initDB();
  }, []);

  // Drain pending state queue on network reconnect
  useEffect(() => {
    let wasOffline = false;
    const NetInfo = require('@react-native-community/netinfo').default;
    const unsubscribe = NetInfo.addEventListener((state: { isConnected: boolean | null; isInternetReachable: boolean | null }) => {
      // On web, `isInternetReachable` stays `null` while the reachability
      // probe is pending — only treat an explicit `false` as offline there.
      // Native platforms keep the original stricter check unchanged.
      const online =
        Platform.OS === 'web'
          ? Boolean(state.isConnected) && state.isInternetReachable !== false
          : Boolean(state.isConnected && state.isInternetReachable);
      if (online && wasOffline) {
        void import('@/services/pendingStateQueue').then(({ drain }) => drain());
      }
      wasOffline = !online;
    });
    return () => unsubscribe();
  }, []);

  // Firestore chat thread subscription
  useEffect(() => {
    if (!user) {
      setThreads([]);
      setLoading(false);
      knownChatIdsRef.current = null;
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

      // Withdraw delivered notifications for any chat deleted since the last
      // snapshot (direct chat deleted by the other side, user removed from a
      // group chat, …). Best-effort: dismissal failures never break the feed.
      const currentChatIds = new Set(payload.map((thread) => thread.chatId));
      if (knownChatIdsRef.current) {
        for (const filter of diffRemovedChatIds(knownChatIdsRef.current, currentChatIds)) {
          void dismissNotificationsForEntity(filter);
        }
      }
      knownChatIdsRef.current = currentChatIds;

      setThreads(payload);
      setLoading(false);
    }, (error) => {
      // Without this handler a rules rejection (e.g. permission-denied)
      // becomes an uncaught snapshot error and a full-screen dev crash.
      console.warn('Chat threads subscription failed.', error);
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

  // Singleton queue listener (always active while authenticated). Doc 31
  // §3.1/§5 Phase 2: dual-listens on BOTH the legacy per-user path and this
  // device's fanned-out per-device path during the migration window — a
  // recipient without a confirmed pairedDevices row yet (syncNotificationDeviceRecord
  // backfills one on next app-launch sync, but that's not instant/guaranteed
  // before a message could arrive) still gets messages via the legacy path,
  // since fanOutQueuedMessage leaves it untouched when it finds zero
  // confirmed devices. saveMessageLocally dedupes by message id, so the rare
  // race where both paths deliver the same message is a harmless no-op
  // re-save, not a duplicate.
  useEffect(() => {
    if (!user) {
      return () => undefined;
    }

    const onMessage = async (message: ChatMessage) => {
      await saveMessageLocally(message);

      if (activeChatIdsRef.current.has(message.chatId)) {
        await markChatAsRead(message.chatId);
      }
    };

    const unsubscribeLegacy = listenForMessages(user.userId, onMessage);

    let unsubscribeDevice: (() => void) | undefined;
    let cancelled = false;
    void getCurrentDeviceId().then((deviceId) => {
      if (cancelled) return;
      unsubscribeDevice = listenForMessagesOnDevice(user.userId, deviceId, onMessage);
    });

    return () => {
      cancelled = true;
      unsubscribeLegacy();
      unsubscribeDevice?.();
    };
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
          updatedAt: state.updatedAt,
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

  const loadMoreMessages = useCallback(
    async (chatId: string, before: number) => {
      await waitForChatWrites(chatId);
      return getChatMessagesPaginated(chatId, { limit: 30, before });
    },
    [],
  );

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

          setSendProgress(msgId, { stage: 'uploading', fraction: 0 });

          const uploadResult = await uploadMedia(
            localMediaPath || mediaUri,
            chatId,
            msgId,
            fileName,
            mimeType,
            (progress, bytes) => {
              onStageChange?.('uploading', {
                progress,
                message: `Uploading ${typeLabel}… ${Math.round(progress)}%`,
              });
              setSendFraction(
                msgId,
                progress / 100,
                bytes ? { sent: bytes.sent, total: bytes.total } : undefined,
              );
            },
            (cancel) => {
              setSendProgress(msgId, { stage: 'uploading', cancel });
            },
          );

          mediaUrl = uploadResult.downloadUrl;
          permanentLocalPath = uploadResult.localPath;

          console.log('✅ Media uploaded successfully:', mediaUrl);

          message.mediaUrl = mediaUrl;
          message.localMediaPath = permanentLocalPath;
          message.mediaDownloaded = true;
        }

        onStageChange?.('sending', { message: `Sending ${typeLabel}…` });
        // Past the point of no return: the bytes are on Storage and the fan-out
        // below is what makes the message real. Dropping the cancel handle here
        // is deliberate — offering "Cancel" during fan-out would imply an undo
        // we cannot honour once a recipient has the message.
        setSendProgress(msgId, { stage: 'sending', fraction: null, cancel: undefined });
        message.status = 'sent';
        await saveMessageLocally(message);

        const latestThread = getThreadByChatId(chatId);
        const participants = latestThread?.participants || [];
        const isGroupChat = latestThread?.type === 'group';
        const recipientIds = participants
          .map((participant) => participant.userId)
          .filter((participantId) => participantId !== user.userId);

        // Attempt EVERY recipient before failing. queueMessage can now throw
        // rather than silently downgrading to plaintext when a recipient has
        // keys we can't fully encrypt for (EncryptionRequiredError), and in a
        // group an early throw would starve every recipient after the failing
        // one. Collect instead, then fail the message as a whole so the user
        // retries — retry is safe because the message id is stable, so a
        // re-send overwrites the same queue node rather than duplicating.
        const sendFailures: unknown[] = [];
        for (const recipientId of recipientIds) {
          try {
            await queueMessage(recipientId, message, isGroupChat);
          } catch (error) {
            sendFailures.push(error);
          }
        }
        if (sendFailures.length > 0) {
          throw sendFailures[0];
        }

        // Mirror to this user's OWN other devices (doc 31 §3.3). Once per
        // message, deliberately outside the loop above — inside it, a group
        // chat would mirror the same message to our devices once per
        // participant. No-ops on a single-device account.
        await queueMessageToOwnDevices(user.userId, message, isGroupChat);

        console.log(`✅ ${type} message sent and queued`);

        await updateDoc(doc(db, 'chats', chatId), {
          groupId: groupId ?? null,
          updatedAt: Date.now(),
          lastMessage: {
            messageId: message.messageId,
            senderId: message.senderId,
            type: message.type,
            content: type !== 'text' ? getMessageTypeLabel(type) : content,
            createdAt: message.createdAt,
          },
        });

        onStageChange?.('complete');
        clearSendProgress(msgId);
      } catch (error) {
        console.error('Send failed', error);
        const wasCancelled =
          error instanceof Error &&
          (error.name === 'MediaUploadCancelledError' || error.name === 'MediaSendCancelledError');

        clearSendProgress(msgId);

        if (wasCancelled) {
          // A cancelled send leaves no trace: the bubble is removed rather
          // than parked as "failed", because a failed bubble invites a retry
          // and the user's whole intent was to stop this item.
          await deleteMessageLocally(chatId, msgId);
          onStageChange?.('failed', { message: 'Cancelled' });
          throw error;
        }

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
        displayName: resolveDisplayName(user, 'You'),
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

      // Cross-device broadcast via Firestore messageState. Every chat client
      // subscribes to messageStates on chat open and applies the flag locally,
      // so recipients see the deletion the next time they're online with this
      // chat — both for currently-open sessions and for sessions that opened
      // the chat after the deletion happened.
      //
      // We intentionally do NOT also push a tombstone via the RTDB
      // messageQueue: queueMessage's payload schema has no deletedForEveryone
      // field (and the RTDB rules wouldn't accept an arbitrary tombstone
      // overwrite), which used to ship the recipient an empty-content
      // "normal" message and trigger PERMISSION_DENIED for queue overwrites.
      const { publishMessageState } = await import('@/services/messageStateService');
      try {
        await publishMessageState(chatId, messageId, { deletedForEveryone: true });
      } catch (error) {
        console.warn('⚠️ Failed to broadcast delete-for-everyone state; local copy already updated.', error);
      }
    },
    [user],
  );

  const setTyping = useCallback(
    async (chatId: string, isTyping: boolean) => {
      if (!user) return;
      const { getDatabase, ref, set, remove } = await import('firebase/database');
      const rtdb = getDatabase();
      const typingRef = ref(rtdb, `typing/${chatId}/${user.userId}`);
      try {
        if (isTyping) {
          await set(typingRef, Date.now());
        } else {
          await remove(typingRef);
        }
      } catch (error) {
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
      loadMoreMessages,
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
      loadMoreMessages,
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
