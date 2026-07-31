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
import NetInfo from '@react-native-community/netinfo';
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
import {
  discardNearbyAttachment,
  prepareNearbyAttachment,
} from '../../modules/splitcircle-mesh';
import { normalizeAllowedMediaMimeType } from '@/services/mediaPolicy';
import { getCurrentDeviceId } from '@/services/pairingService';
import {
  listenForMessages,
  listenForMessagesOnDevice,
  listenForReceipts,
  queueMessage,
  queueMessageToOwnDevices,
  registerReceiptParticipant,
  sendBulkReadReceipts,
  sendUndecryptableReceipt,
} from '@/services/messageQueueService';
import {
  answerGapRequest,
  checkForGapsAndRequestFill,
  claimGapRequest,
  subscribeToGapRequests,
} from '@/services/syncGapService';
import { useAuth } from '@/context/AuthContext';
import { dismissNotificationsForEntity } from '@/utils/notifications';
import { resolveDisplayName } from '@/utils/identity';
import { diffRemovedChatIds } from '@/utils/notificationEntityMatch';
import { loadCachedChatThreads, persistChatThreads } from '@/services/chatThreadCache';
import {
  reconcileChatAudience,
  requestChatAudienceRepair,
} from '@/services/chatAudienceRepairService';
import {
  buildMeshMessageBody,
  decryptMeshPayloadForDevice,
  parseSignedMeshEnvelope,
  resolveMeshThreadAudience,
  signMeshMessageBody,
  verifyMeshEnvelopeForThread,
} from '@/services/meshMessageProtocol';
import {
  claimMeshMessageProcessing,
  enqueueMeshMessage,
  releaseMeshMessageProcessing,
  type MeshMessageOperation,
} from '@/services/meshMessageQueue';
import {
  broadcastQueuedNearbyMessages,
  reportNearbyMessageEvent,
  setNearbyTrustedPeers,
  startNearbyMessaging,
} from '@/services/nearbyMessageService';
import {
  registerIncomingNearbyAttachment,
  startNearbyAttachmentHandling,
} from '@/services/nearbyAttachmentService';
import { flushMeshCloudRelay } from '@/services/meshCloudRelay';
import {
  prepareSignalSessionsForUser,
  refreshSignalDeviceDirectory,
} from '@/services/signalCryptoService';
import { buildNearbyTrustedPeers } from '@/services/nearbyTrustService';

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

  // Prime every participant's public Signal device directory while online.
  // Nearby verification must not discover for the first time, after the
  // network is gone, that this installation never cached a peer identity.
  useEffect(() => {
    if (!user || threads.length === 0) return () => undefined;
    let disposed = false;
    let seeded = false;
    const seedWhenOnline = (
      state: { isConnected: boolean | null; isInternetReachable: boolean | null },
    ) => {
      if (
        disposed
        || seeded
        || !state.isConnected
        || state.isInternetReachable !== true
      ) {
        return;
      }
      seeded = true;
      const participantIds = [...new Set(
        threads.flatMap((thread) =>
          resolveMeshThreadAudience(thread) ?? thread.participantIds,
        )
          .filter((participantId) => participantId !== user.userId),
      )];
      void Promise.allSettled(
        participantIds.map(async (participantId) => {
          await refreshSignalDeviceDirectory(participantId);
          await prepareSignalSessionsForUser(participantId);
        }),
      );
    };

    void NetInfo.fetch().then(seedWhenOnline);
    const unsubscribe = NetInfo.addEventListener(seedWhenOnline);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [threads, user?.userId]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Keep the native admission allowlist synchronized with the durable
  // conversation + Signal caches. Unknown ManaSplit installations remain
  // radio-visible to iOS but are never invited into our MCSession.
  useEffect(() => {
    if (!user || loading) return;
    let disposed = false;
    void (async () => {
      const currentDeviceId = await getCurrentDeviceId();
      const trustedPeers = await buildNearbyTrustedPeers(
        threads,
        user.userId,
        currentDeviceId,
      );
      if (!disposed) setNearbyTrustedPeers(trustedPeers);
    })().catch((error) => {
      console.warn('Nearby trust directory refresh failed', error);
      if (!disposed) setNearbyTrustedPeers([]);
    });
    return () => {
      disposed = true;
    };
  }, [loading, threads, user?.userId]);

  // Nearby receiver + bounded gossip. The native transport can discover peers
  // with no Internet; every payload is still identity-signed and authorized
  // against the locally cached thread membership before it touches storage.
  useEffect(() => {
    if (!user || loading) return () => undefined;
    let disposed = false;
    let stop: (() => void) | undefined;
    let stopAttachments: (() => void) | undefined;

    const onEnvelope = (raw: string, sourcePeerDeviceId: string) => {
      void (async () => {
        const parsed = parseSignedMeshEnvelope(raw);
        if (!parsed) {
          reportNearbyMessageEvent({
            type: 'rejected',
            detail: 'A nearby message was rejected because its envelope was invalid.',
          });
          return;
        }
        const thread = threadsRef.current.find(
          (candidate) => candidate.chatId === parsed.body.message.chatId,
        );
        if (!thread) {
          reportNearbyMessageEvent({
            type: 'rejected',
            detail: 'A nearby message belongs to a conversation not cached on this phone.',
            chatId: parsed.body.message.chatId,
          });
          return;
        }
        // Direct messages are never relayed. Bind the signed origin
        // installation to the actual trusted carrier peer so a device that
        // merely spoofs another installation id cannot inject or observe a
        // one-to-one conversation. Groups retain signed bounded gossip.
        if (
          thread.type === 'direct'
          && parsed.body.originDeviceId !== sourcePeerDeviceId
        ) {
          reportNearbyMessageEvent({
            type: 'rejected',
            detail: 'A direct message arrived through the wrong nearby device.',
            chatId: parsed.body.message.chatId,
          });
          return;
        }

        const body = await verifyMeshEnvelopeForThread(raw, thread, user.userId);
        if (!body || disposed) {
          if (!disposed) {
            reportNearbyMessageEvent({
              type: 'rejected',
              detail: 'A nearby sender or chat membership could not be verified.',
              chatId: parsed.body.message.chatId,
            });
          }
          return;
        }

        const operationId = `${body.originUserId}:${body.message.id}`;
        const claimed = await claimMeshMessageProcessing(operationId);
        if (!claimed) return;

        try {
          const currentDeviceId = await getCurrentDeviceId();
          const decryptedPayload = await decryptMeshPayloadForDevice(body, currentDeviceId);
          if (!decryptedPayload) {
            reportNearbyMessageEvent({
              type: 'rejected',
              detail: 'A verified nearby message could not be decrypted on this phone.',
              chatId: parsed.body.message.chatId,
            });
            // Doc 32 §5c / Scenario C. This envelope already PASSED signature
            // and audience verification above — it is authentic and we are a
            // legitimate recipient; we simply cannot open it (dead ratchet, or
            // an HPKE fallback whose identity key was never seeded). Dropping
            // it silently was the worst outcome available: the receiver saw
            // nothing at all, and the sender had already flipped the message to
            // 'sent' off the transport ack, so NOBODY could tell it was lost.
            //
            // Leave the same visible placeholder the online path has always
            // left, and tell the sender so it can show a real failure. An
            // envelope that fails verification is still discarded in silence
            // further up — acknowledging that one would confirm receipt to an
            // unverified sender.
            await saveMessageLocally({
              ...body.message,
              content: '⚠️ Couldn’t decrypt this nearby message',
              isFromMe: false,
              status: 'delivered',
              deliveredTo: [],
              readBy: [],
            });
            void sendUndecryptableReceipt(
              parsed.body.message.chatId,
              body.message.id,
              user.userId,
            );
            return;
          }
          const { message: decryptedMessage, attachment } = decryptedPayload;

          const isNew = await enqueueMeshMessage({
            id: operationId,
            message: decryptedMessage,
            chatType: body.chatType,
            ...(body.groupId ? { groupId: body.groupId } : {}),
            participantIds: body.audienceUserIds,
            recipientDeviceIds: Object.keys(body.encryptedForDevices),
            originUserId: body.originUserId,
            originOwned: false,
            // Only the origin's signed-outbox copy uploads to Firebase. A relay
            // cannot safely impersonate the origin in today's Signal/RTDB wire
            // format; its copy exists solely for nearby gossip.
            cloudRelay: false,
            wireEnvelope: raw,
            ...(attachment
              ? {
                  nearbyAttachment: {
                    transferId: attachment.manifest.transferId,
                    chunkCount: attachment.manifest.chunkCount,
                    fileName: attachment.manifest.fileName,
                    mimeType: attachment.manifest.mimeType,
                  },
                }
              : {}),
            createdAt: body.createdAt,
          });
          if (!isNew) return;

          await saveMessageLocally({
            ...decryptedMessage,
            isFromMe: body.originUserId === user.userId,
            status: attachment ? 'sending' : 'delivered',
            deliveredTo: [
              ...new Set([...(decryptedMessage.deliveredTo ?? []), user.userId]),
            ],
          });
          if (attachment) {
            await registerIncomingNearbyAttachment({
              message: {
                ...decryptedMessage,
                isFromMe: body.originUserId === user.userId,
                status: 'sending',
              },
              manifest: attachment.manifest,
              secret: attachment.secret,
              originDeviceId: body.originDeviceId,
              ownerUserId: user.userId,
            });
          }
          reportNearbyMessageEvent({
            type: 'received',
            detail: 'Nearby message verified, decrypted, and saved in this chat.',
            chatId: parsed.body.message.chatId,
          });
          // Re-broadcasting a newly seen signed envelope lets B bridge A and C
          // even when A and C cannot directly discover one another. The inbox
          // claim above rejects repeats BEFORE they touch the Signal ratchet.
          void broadcastQueuedNearbyMessages();
        } finally {
          releaseMeshMessageProcessing(operationId);
        }
      })().catch((error) => {
        console.warn('Nearby message processing failed', error);
        reportNearbyMessageEvent({
          type: 'rejected',
          detail: 'A nearby message could not be processed on this phone.',
        });
      });
    };

    void startNearbyAttachmentHandling(user.userId, () => {
      void broadcastQueuedNearbyMessages();
    }).then((cleanup) => {
      if (disposed) cleanup();
      else stopAttachments = cleanup;
    });

    void (async () => {
      const currentDeviceId = await getCurrentDeviceId();
      const trustedPeers = await buildNearbyTrustedPeers(
        threadsRef.current,
        user.userId,
        currentDeviceId,
      );
      if (disposed) return;
      setNearbyTrustedPeers(trustedPeers);
      const cleanup = await startNearbyMessaging(
        user.userId,
        resolveDisplayName(user, 'ManaSplit user'),
        onEnvelope,
      );
      if (disposed) cleanup();
      else stop = cleanup;
    })().catch((error) => {
      console.warn('Nearby messaging unavailable', error);
    });

    return () => {
      disposed = true;
      stop?.();
      stopAttachments?.();
    };
  }, [loading, user?.userId]);

  // Group messages created over the mesh are also regular cloud messages once
  // Internet returns. Direct nearby messages intentionally stay device-local.
  useEffect(() => {
    if (!user) return () => undefined;
    const flushIfOnline = (
      state: { isConnected: boolean | null; isInternetReachable: boolean | null },
    ) => {
      if (state.isConnected && state.isInternetReachable === true) {
        void flushMeshCloudRelay(user.userId);
      }
    };
    void NetInfo.fetch().then(flushIfOnline);
    const unsubscribe = NetInfo.addEventListener(flushIfOnline);
    return () => unsubscribe();
  }, [user?.userId]);

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

    let active = true;
    const uid = user.userId;

    // The Firestore JS SDK is memory-only on native. Restore the thread list
    // from disk before attaching the live listener so local messages remain
    // navigable after a killed-app, network-free launch.
    void loadCachedChatThreads(uid).then((cached) => {
      if (!active) return;
      if (cached) {
        setThreads((previous) => (previous.length ? previous : cached));
      }
      setLoading(false);
    });

    const chatsRef = collection(db, 'chats');
    const q = query(chatsRef, where('participantIds', 'array-contains', uid));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (snapshot.empty && snapshot.metadata.fromCache) {
        // Do not let Firestore's empty in-memory native cache erase the
        // durable thread list restored above during a network-free boot.
        setLoading(false);
        return;
      }
      const divergedChatIds: string[] = [];
      const payload = snapshot.docs.map((docSnap) => {
        const data = docSnap.data() as ChatThread & { lastMessage?: ChatMessage };
        // Doc 32 §5d. This used to be `data.participantIds ?? data.participants
        // .map(...)`, which only covered participantIds being ENTIRELY absent.
        // When both arrays exist but disagree — old clients did not keep them
        // in lockstep — the stale one won, and for a direct chat that made
        // resolveMeshThreadAudience return null (it demands exactly 2), so
        // every nearby message for that thread was rejected on both send and
        // receive with no UI feedback at all.
        //
        // Union them instead. Every device applies the identical union to the
        // same doc, so they agree without needing a write. The write-back
        // below still matters for the case a union cannot reach: a user
        // missing from `participantIds` never matches the `array-contains`
        // query above, so that device never receives the doc to repair.
        const { participantIds, diverged } = reconcileChatAudience(data);
        if (diverged) {
          divergedChatIds.push(data.chatId);
        }
        return {
          ...data,
          participantIds,
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
      void persistChatThreads(uid, payload);
      // Ask the server to make the union above the stored truth (doc 32 §5d).
      // Throttled per chat inside the service, and deliberately not awaited:
      // this device is already correct thanks to the local union, so nothing
      // here depends on the repair landing.
      if (divergedChatIds.length > 0) {
        void requestChatAudienceRepair(divergedChatIds);
      }
    }, (error) => {
      // Without this handler a rules rejection (e.g. permission-denied)
      // becomes an uncaught snapshot error and a full-screen dev crash.
      console.warn('Chat threads subscription failed.', error);
      setLoading(false);
    });

    return () => {
      active = false;
      unsubscribe();
    };
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

  // Cross-device history reconciliation, detection half (doc 31 §8.1).
  //
  // Runs on every threads update rather than once per device lifetime — that
  // one-shot-ness is exactly what left the Phase 6 handoff unable to repair a
  // device that fell behind AFTER pairing. The threads snapshot is the right
  // trigger because it is also what fires on reconnect, so a device coming back
  // online re-checks itself without any additional network listener.
  useEffect(() => {
    if (!user || threads.length === 0) {
      return () => undefined;
    }

    let cancelled = false;
    void getCurrentDeviceId().then((deviceId) => {
      if (cancelled) return;
      void checkForGapsAndRequestFill(user.userId, deviceId, threads).catch((error) => {
        console.warn('Gap detection pass failed', error);
      });
    });

    return () => {
      cancelled = true;
    };
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
    let unsubscribeGapRequests: (() => void) | undefined;
    let cancelled = false;
    void getCurrentDeviceId().then((deviceId) => {
      if (cancelled) return;
      unsubscribeDevice = listenForMessagesOnDevice(user.userId, deviceId, onMessage);

      // Cross-device history reconciliation, responder half (doc 31 §8.1).
      // Lives here rather than in its own effect so it shares this effect's
      // "always active while authenticated" lifetime and its resolved deviceId
      // — a gap request is most often written while THIS device was closed, so
      // the subscription has to be up whenever the app is, not only while some
      // particular screen is mounted.
      unsubscribeGapRequests = subscribeToGapRequests(user.userId, deviceId, (request) => {
        void (async () => {
          try {
            if (!(await claimGapRequest(user.userId, request.requestId, deviceId))) {
              return; // Another device is serving it.
            }
            // threadsRef, not `threads`: reading the state directly would make
            // this effect depend on it and tear the listener down on every
            // snapshot.
            const thread = threadsRef.current.find(
              (candidate) => candidate.chatId === request.chatId,
            );
            await answerGapRequest(user.userId, request, thread?.type === 'group');
          } catch (error) {
            console.warn('Gap-fill response failed', error);
          }
        })();
      });
    });

    return () => {
      cancelled = true;
      unsubscribeLegacy();
      unsubscribeDevice?.();
      unsubscribeGapRequests?.();
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

            if (status === 'undecryptable') {
              // The recipient proved this message authentic but could not open
              // it (doc 32 §5c). It is NOT delivered in any useful sense, and
              // this message had already been flipped to 'sent' by a transport
              // ack — so show a real failure the user can act on by resending,
              // rather than leaving a confident tick on unreadable content.
              await updateMessageStatus(chatId, messageId, 'failed');
              return;
            }

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
      let mediaCopyError: unknown;

      if (mediaUri && type !== 'text') {
        try {
          const fileName = mediaMetadata?.fileName || `${type}_${msgId}`;
          localMediaPath = await copyToLocalStorage(mediaUri, chatId, msgId, fileName);
        } catch (error) {
          mediaCopyError = error;
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

      let preparedNearbyTransferId: string | undefined;
      try {
        const network = await NetInfo.fetch();
        const internetAvailable = Boolean(
          network.isConnected && network.isInternetReachable === true,
        );
        const latestThread = getThreadByChatId(chatId);

        if (!internetAvailable) {
          if (!latestThread) {
            throw new Error('This conversation is not available in the offline cache yet.');
          }

          const originDeviceId = await getCurrentDeviceId();
          let attachment:
            | {
                manifest: {
                  v: 1;
                  transferId: string;
                  fileName: string;
                  mimeType: string;
                  fileSize: number;
                  chunkSize: number;
                  chunkCount: number;
                  chunkHashes: string[];
                  encryptedChunkSizes: number[];
                };
                secret: {
                  transferId: string;
                  keyBase64: string;
                  nonceSeedBase64: string;
                };
              }
            | undefined;
          let nearbyAttachment: MeshMessageOperation['nearbyAttachment'];

          if (type === 'location') {
            throw new Error('Live location cannot be shared without internet.');
          }
          if (mediaUri && type !== 'text') {
            if (mediaCopyError) throw mediaCopyError;
            const fileName = (
              mediaMetadata?.fileName || `${type}_${msgId}`
            ).slice(0, 255);
            const mimeType = normalizeAllowedMediaMimeType((
              mediaMetadata?.mimeType || 'application/octet-stream'
            ).slice(0, 128));
            onStageChange?.('preparing', { message: `Encrypting ${getMessageTypeLabel(type)}…` });
            setSendProgress(msgId, {
              stage: 'uploading',
              fraction: 0,
            });
            const prepared = await prepareNearbyAttachment(
              localMediaPath || mediaUri,
              msgId,
            );
            preparedNearbyTransferId = prepared.transferId;
            attachment = {
              manifest: {
                v: 1,
                transferId: prepared.transferId,
                fileName,
                mimeType,
                fileSize: prepared.fileSize,
                chunkSize: prepared.chunkSize,
                chunkCount: prepared.chunkCount,
                chunkHashes: prepared.chunkHashes,
                encryptedChunkSizes: prepared.encryptedChunkSizes,
              },
              secret: {
                transferId: prepared.transferId,
                keyBase64: prepared.keyBase64,
                nonceSeedBase64: prepared.nonceSeedBase64,
              },
            };
            nearbyAttachment = {
              transferId: prepared.transferId,
              chunkCount: prepared.chunkCount,
              localPath: localMediaPath || mediaUri,
              fileName,
              mimeType,
            };
          }

          const body = await buildMeshMessageBody({
            message,
            thread: latestThread,
            originUserId: user.userId,
            originDeviceId,
            attachment: attachment?.manifest,
            attachmentSecret: attachment?.secret,
          });

          let wireEnvelope: string | undefined;
          try {
            if (!body) {
              reportNearbyMessageEvent({
                type: 'blocked',
                detail: 'Secure nearby delivery is not ready for this chat; the message remains local.',
                chatId,
              });
              throw new Error('No nearby participant has an established secure session.');
            }
            wireEnvelope = await signMeshMessageBody(body);
          } catch (error) {
            // BOTH chat types now have a durable cloud path on reconnect
            // (doc 32 §5a), so a missing nearby envelope is no longer fatal
            // for a DM — flushMeshCloudRelay delivers it once Internet
            // returns, over the same RTDB path a DM already uses whenever it
            // is sent online.
            //
            // The one genuinely unrecoverable case is a thread whose
            // membership cannot be resolved at all: with no audience there is
            // nobody to address the message TO on EITHER path, so failing
            // visibly is correct rather than accepting a message that can
            // never be delivered (doc 32 §3 Scenario E; the repair is §5d).
            if (!resolveMeshThreadAudience(latestThread)) throw error;
          }

          const operation: MeshMessageOperation = {
            id: `${user.userId}:${message.id}`,
            message,
            chatType: latestThread.type,
            ...(latestThread.groupId ? { groupId: latestThread.groupId } : {}),
            participantIds:
              body?.audienceUserIds
              ?? resolveMeshThreadAudience(latestThread)
              ?? latestThread.participantIds,
            ...(body
              ? { recipientDeviceIds: Object.keys(body.encryptedForDevices) }
              : {}),
            originUserId: user.userId,
            originOwned: true,
            // Doc 32 §5a. This was `latestThread.type === 'group'`, which meant
            // an offline DM had exactly ONE delivery route — physical mesh
            // proximity — and was silently discarded at the 7-day TTL if the
            // two phones never met again, even though both had been online for
            // days. That was never a privacy property: a DM sent while online
            // already goes through this same RTDB path (see the online branch
            // below, which calls the identical queueMessage). `originOwned`
            // above is the guard that actually prevents a relay device from
            // impersonating someone else's message — chat type never was.
            cloudRelay: true,
            ...(wireEnvelope ? { wireEnvelope } : {}),
            ...(nearbyAttachment ? { nearbyAttachment } : {}),
            createdAt: now,
          };
          await enqueueMeshMessage(operation);
          if (!wireEnvelope && preparedNearbyTransferId) {
            // There is no nearby route for this operation. The stable
            // plaintext is still retained for cloud convergence; encrypted
            // staging has no consumer and should not occupy disk for seven
            // days.
            discardNearbyAttachment(preparedNearbyTransferId);
          }
          if (wireEnvelope) {
            await broadcastQueuedNearbyMessages();
          }
          // Every offline operation is now queued for cloud sync regardless of
          // chat type (doc 32 §5a), so the copy no longer promises a DM only a
          // nearby route — that was the wording for a message that could be
          // lost outright if the phones never met again.
          onStageChange?.(nearbyAttachment ? 'uploading' : 'complete', {
            message: wireEnvelope
              ? nearbyAttachment
                ? 'Sending nearby; queued for cloud sync.'
                : 'Saved nearby and queued for cloud sync.'
              : 'Saved locally and queued for cloud sync.',
          });
          if (!nearbyAttachment) clearSendProgress(msgId);
          return;
        }

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
        if (preparedNearbyTransferId) {
          discardNearbyAttachment(preparedNearbyTransferId);
        }
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
