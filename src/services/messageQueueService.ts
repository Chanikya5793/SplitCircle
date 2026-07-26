// Firebase Realtime Database Message Queue Service
// WhatsApp-style temporary message storage
// Messages are cached in Firebase until delivered, then deleted
// Local storage is the primary message store (AsyncStorage)

import {
  get,
  getDatabase,
  onChildAdded,
  onChildChanged,
  onValue,
  ref,
  remove,
  set,
  update,
  type DataSnapshot,
} from 'firebase/database';
import type { ChatMessage, MessageType } from '@/models';
import { downloadMedia } from '@/services/mediaService';
import { decryptMessageEnvelope, encryptMessageForRecipient } from '@/services/messageEnvelope';
import { getOrCreateInstallationId } from '@/services/notificationService';

// Get Realtime Database instance
const rtdb = getDatabase();

// Type for receipt data structure
export interface ReceiptData {
  delivered?: boolean;
  deliveredAt?: number;
  read?: boolean;
  readAt?: number;
  recipientId: string;
}

interface PersistedReceiptData {
  delivered: boolean;
  deliveredAt: number;
  read?: boolean;
  readAt?: number;
  recipientId: string;
}

// Type for group receipt structure (per-user receipts)
interface GroupReceiptData {
  [recipientId: string]: ReceiptData;
}

interface QueueMessagePayload {
  senderId: string;
  chatId: string;
  requestId?: string;
  content: string;
  type: MessageType;
  timestamp: number;
  mediaUrl?: string | null;
  thumbnailUrl?: string | null;
  isGroupChat?: boolean;
  mediaMetadata?: ChatMessage['mediaMetadata'];
  replyTo?: ChatMessage['replyTo'];
  location?: ChatMessage['location'];
  forwardedFrom?: ChatMessage['forwardedFrom'];
  expenseRef?: ChatMessage['expenseRef'];
}

const isReceiptData = (value: unknown): value is ReceiptData => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const data = value as Partial<ReceiptData>;
  return typeof data.recipientId === 'string';
};

/**
 * Normalize receipts to per-recipient map format.
 * Supports:
 * - Legacy direct-chat shape: { delivered, deliveredAt, recipientId, ... }
 * - Current unified shape: { recipientIdA: { ... }, recipientIdB: { ... } }
 */
const normalizeReceiptMap = (messageReceipts: unknown): GroupReceiptData => {
  if (isReceiptData(messageReceipts)) {
    return { [messageReceipts.recipientId]: messageReceipts };
  }

  if (!messageReceipts || typeof messageReceipts !== 'object') {
    return {};
  }

  const mapped: GroupReceiptData = {};
  for (const [recipientId, receiptValue] of Object.entries(messageReceipts as Record<string, unknown>)) {
    if (isReceiptData(receiptValue)) {
      mapped[recipientId] = receiptValue;
    }
  }
  return mapped;
};

const normalizeTimestamp = (value: unknown): number => {
  if (typeof value === 'number') {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const parseQueuePayload = (value: unknown): QueueMessagePayload | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const senderId = typeof payload.senderId === 'string' ? payload.senderId : '';
  const chatId = typeof payload.chatId === 'string' ? payload.chatId : '';
  const content = typeof payload.content === 'string' ? payload.content : '';
  const type = typeof payload.type === 'string' ? payload.type as MessageType : 'text';

  if (!senderId || !chatId || !type) {
    return null;
  }

  return {
    senderId,
    chatId,
    requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
    content,
    type,
    timestamp: normalizeTimestamp(payload.timestamp),
    mediaUrl: typeof payload.mediaUrl === 'string' ? payload.mediaUrl : null,
    thumbnailUrl: typeof payload.thumbnailUrl === 'string' ? payload.thumbnailUrl : null,
    isGroupChat: typeof payload.isGroupChat === 'boolean' ? payload.isGroupChat : false,
    mediaMetadata: payload.mediaMetadata as ChatMessage['mediaMetadata'] | undefined,
    replyTo: payload.replyTo as ChatMessage['replyTo'] | undefined,
    location: payload.location as ChatMessage['location'] | undefined,
    forwardedFrom: payload.forwardedFrom as ChatMessage['forwardedFrom'] | undefined,
    expenseRef: payload.expenseRef as ChatMessage['expenseRef'] | undefined,
  };
};

const getReceiptFingerprint = (
  status: 'delivered' | 'read',
  allDelivered: string[],
  allRead: string[]
): string => {
  const deliveredSorted = [...allDelivered].sort();
  const readSorted = [...allRead].sort();
  return `${status}|d:${deliveredSorted.join(',')}|r:${readSorted.join(',')}`;
};

/**
 * Send a message to recipient's queue in Realtime Database
 * Message will be temporarily stored until delivered
 */
export const queueMessage = async (
  recipientId: string,
  message: ChatMessage,
  isGroupChat: boolean = false
): Promise<void> => {
  try {
    const messageQueueRef = ref(rtdb, `messageQueue/${recipientId}/${message.id}`);

    const messageData: Record<string, unknown> = {
      senderId: message.senderId,
      chatId: message.chatId,
      requestId: message.requestId,
      content: message.content,
      type: message.type,
      timestamp: message.timestamp,
      mediaUrl: message.mediaUrl || null,
      thumbnailUrl: message.thumbnailUrl || null,
      isGroupChat,
    };

    if (message.mediaMetadata) {
      const m = message.mediaMetadata;
      messageData.mediaMetadata = {
        ...(m.fileName && { fileName: m.fileName }),
        ...(m.fileSize && { fileSize: m.fileSize }),
        ...(m.mimeType && { mimeType: m.mimeType }),
        ...(m.width && { width: m.width }),
        ...(m.height && { height: m.height }),
        ...(m.duration && { duration: m.duration }),
        ...(m.aspectRatio && { aspectRatio: m.aspectRatio }),
        ...(m.thumbnailUri && { thumbnailUri: m.thumbnailUri }),
        // Album fields — without these the receiver renders each item as a
        // separate bubble instead of grouping the multi-pick batch into one
        // album bubble. `albumIndex` can legitimately be 0, so guard on
        // `!== undefined` rather than truthiness.
        ...(m.albumId && { albumId: m.albumId }),
        ...(m.albumIndex !== undefined && { albumIndex: m.albumIndex }),
        ...(m.albumSize && { albumSize: m.albumSize }),
        // Source (pre-process) details + EXIF — surfaced on the receiver's
        // info panel so both sides see identical, accurate numbers.
        ...(m.sourceWidth && { sourceWidth: m.sourceWidth }),
        ...(m.sourceHeight && { sourceHeight: m.sourceHeight }),
        ...(m.sourceFileSize && { sourceFileSize: m.sourceFileSize }),
        ...(m.cameraMake && { cameraMake: m.cameraMake }),
        ...(m.cameraModel && { cameraModel: m.cameraModel }),
        ...(m.takenAt && { takenAt: m.takenAt }),
      };
      console.log('📎 Queuing message with mediaMetadata:', m.fileName || message.type);
    }

    if (message.replyTo && message.replyTo.messageId) {
      messageData.replyTo = {
        messageId: message.replyTo.messageId,
        senderId: message.replyTo.senderId,
        senderName: message.replyTo.senderName,
        content: message.replyTo.content,
      };
      console.log('📎 Queuing message with replyTo:', message.replyTo.messageId);
    }

    if (message.location) {
      messageData.location = {
        latitude: message.location.latitude,
        longitude: message.location.longitude,
        address: message.location.address,
      };
      console.log('📍 Queuing message with location');
    }

    if (message.forwardedFrom) {
      messageData.forwardedFrom = {
        senderName: message.forwardedFrom.senderName || null,
        hopCount: message.forwardedFrom.hopCount,
      };
      console.log('↪️ Queuing message with forwardedFrom');
    }

    // Money-in-chat card pointer (ai_layer/docs/21). Serialized field-by-field
    // so no `undefined` ever reaches RTDB (it rejects undefined values).
    if (message.expenseRef) {
      const r = message.expenseRef;
      messageData.expenseRef = {
        kind: r.kind,
        groupId: r.groupId,
        refId: r.refId,
        ...(r.occurrenceAt !== undefined ? { occurrenceAt: r.occurrenceAt } : {}),
        snapshot: {
          title: r.snapshot.title,
          amount: r.snapshot.amount,
          currency: r.snapshot.currency,
          payerName: r.snapshot.payerName,
          payerId: r.snapshot.payerId,
          participantCount: r.snapshot.participantCount,
          ...(r.snapshot.category ? { category: r.snapshot.category } : {}),
          ...(r.snapshot.toName ? { toName: r.snapshot.toName } : {}),
          ...(r.snapshot.toUserId ? { toUserId: r.snapshot.toUserId } : {}),
          ...(r.snapshot.recurrenceSummary ? { recurrenceSummary: r.snapshot.recurrenceSummary } : {}),
          ...(r.snapshot.variable ? { variable: true } : {}),
        },
      };
    }

    // E2E encryption (doc 31 §3.3). Encrypt the fields §3.3 scopes as private
    // — content, and the replyTo/location snippets that quote it — once per
    // recipient device, since every paired device is its own Signal endpoint
    // with its own session. Left plaintext, deliberately and per §3.3: chatId,
    // senderId, timestamp, type, delivery bookkeeping and expenseRef, which
    // points at a Firestore doc that is not itself E2E'd.
    //
    // ALL-OR-NOTHING per message: if any one of the recipient's devices can't
    // be encrypted for, the whole message goes plaintext. A partial send would
    // silently drop the message on that device (it would receive an envelope
    // it cannot open, or none at all), which is worse than the status quo.
    // This fallback is a ROLLOUT measure, not the end state — it means an
    // attacker who can suppress key publication can force plaintext, so it
    // must be removed once every client publishes keys (doc 31 §5 Phase 3).
    const encrypted = await encryptMessageForRecipient(recipientId, {
      content: message.content,
      replyToContent: message.replyTo?.content,
      location: message.location,
    });

    if (encrypted) {
      messageData.envelopes = encrypted.envelopes;
      messageData.senderSignalDeviceId = encrypted.senderSignalDeviceId;
      messageData.encrypted = true;
      // Blank the plaintext copies now that ciphertext carries them. Not
      // deleted outright: the receive path and every existing consumer expect
      // these keys to exist, and RTDB treats undefined as "remove field".
      messageData.content = '';
      if (messageData.replyTo && typeof messageData.replyTo === 'object') {
        (messageData.replyTo as Record<string, unknown>).content = '';
      }
      if (messageData.location) {
        messageData.location = null;
      }
    }

    await set(messageQueueRef, messageData);
    console.log('✅ Message queued for:', recipientId, encrypted ? '(encrypted)' : '(plaintext)');
  } catch (error) {
    console.error('❌ Error queuing message:', error);
    throw error;
  }
};

/**
 * Mirrors a message the user just sent to their OWN other devices (doc 31
 * §3.3: "each recipient device — and each of the sender's own other devices —
 * gets its own ciphertext").
 *
 * Called ONCE per message, never once per recipient: in a group chat
 * queueMessage runs per participant, and doing this inside it would mirror the
 * same message to our own devices N times.
 *
 * `originDeviceId` travels in the payload so fanOutQueuedMessage can skip the
 * device that sent it — without that, this device would receive its own
 * message straight back.
 */
export const queueMessageToOwnDevices = async (
  senderId: string,
  message: ChatMessage,
  isGroupChat: boolean = false
): Promise<void> => {
  try {
    const originDeviceId = await getOrCreateInstallationId();

    const encrypted = await encryptMessageForRecipient(
      senderId,
      {
        content: message.content,
        replyToContent: message.replyTo?.content,
        location: message.location,
      },
      // Never encrypt to ourselves — a device cannot hold a Signal session
      // with its own identity.
      originDeviceId,
    );

    // No other device of ours has published keys (single-device account, or
    // the others haven't synced yet) — nothing to mirror, and falling back to
    // plaintext here would put our own message content in transit for no
    // benefit, since there is no device waiting to read it.
    if (!encrypted || Object.keys(encrypted.envelopes).length === 0) {
      return;
    }

    const messageData: Record<string, unknown> = {
      senderId: message.senderId,
      chatId: message.chatId,
      requestId: message.requestId,
      content: '',
      type: message.type,
      timestamp: message.timestamp,
      mediaUrl: message.mediaUrl || null,
      thumbnailUrl: message.thumbnailUrl || null,
      isGroupChat,
      originDeviceId,
      // The sending device's own view of the message, so the mirrored copy
      // doesn't have to invent one.
      status: message.status ?? 'sent',
      envelopes: encrypted.envelopes,
      senderSignalDeviceId: encrypted.senderSignalDeviceId,
      encrypted: true,
    };

    if (message.mediaMetadata) messageData.mediaMetadata = message.mediaMetadata;
    if (message.replyTo?.messageId) {
      messageData.replyTo = { ...message.replyTo, content: '' };
    }
    if (message.forwardedFrom) messageData.forwardedFrom = message.forwardedFrom;
    if (message.expenseRef) messageData.expenseRef = message.expenseRef;

    await set(ref(rtdb, `messageQueue/${senderId}/${message.id}`), messageData);
  } catch (error) {
    // Never fail the send because self-sync failed: the message already
    // reached its actual recipients, and the user's other devices catching up
    // is a convenience, not a delivery guarantee.
    console.warn('⚠️ Failed to mirror message to own devices:', error);
  }
};

/**
 * Register the current user as a permitted receipt reader for a chat.
 * This is used by RTDB rules to scope receipt reads.
 */
export const registerReceiptParticipant = async (chatId: string, userId: string): Promise<void> => {
  try {
    await set(ref(rtdb, `receipts/${chatId}/__participants/${userId}`), true);
  } catch (error) {
    console.error('❌ Error registering receipt participant:', error);
    throw error;
  }
};

/**
 * Listen for receipt updates for a single message.
 * This includes per-recipient delivery/read timestamps from RTDB.
 */
export const listenForMessageReceipts = (
  chatId: string,
  messageId: string,
  onReceiptsChanged: (receipts: Record<string, ReceiptData>) => void
): (() => void) => {
  const receiptRef = ref(rtdb, `receipts/${chatId}/${messageId}`);

  const unsubscribe = onValue(
    receiptRef,
    (snapshot) => {
      const normalized = normalizeReceiptMap(snapshot.val());
      onReceiptsChanged(normalized);
    },
    (error) => {
      console.error('❌ Error listening for message receipts:', error);
      onReceiptsChanged({});
    }
  );

  return () => {
    unsubscribe();
  };
};

/**
 * Shared body for listenForMessages (legacy, per-user path) and
 * listenForMessagesOnDevice (doc 31 §3.1/§5 Phase 2, per-device path) — both
 * run concurrently in ChatContext.tsx during the migration window (see that
 * file's comment): a recipient without a confirmed pairedDevices row yet
 * still gets messages via the legacy path (fanOutQueuedMessage leaves it
 * untouched when it finds zero confirmed devices), while a recipient who
 * has one gets them via the fanned-out per-device path instead.
 * saveMessageLocally dedupes by message id, so a message the transition
 * window's rare race delivers via both paths is a harmless double-write,
 * not a duplicate message.
 */
const attachQueueListener = (
  queuePath: string,
  deletePath: (messageId: string) => string,
  userId: string,
  onMessageReceived: (message: ChatMessage) => Promise<void>
): (() => void) => {
  const queueRef = ref(rtdb, queuePath);
  const processingMessageIds = new Set<string>();

  const processMessageSnapshot = async (snapshot: DataSnapshot): Promise<void> => {
    const messageId = snapshot.key;
    if (!messageId) {
      return;
    }

    if (processingMessageIds.has(messageId)) {
      return;
    }

    const raw = snapshot.val();

    // An `envelopes` MAP means this is the shared relay node
    // (messageQueue/{userId}/{id}) that fanOutQueuedMessage hasn't processed
    // yet — its content is blanked and the per-device ciphertext hasn't been
    // split out. The legacy dual-listen subscription sees that node too, so
    // without this guard it would race the trigger and save the message with
    // EMPTY content, blanking a message that is about to arrive properly.
    // A correctly fanned-out payload carries a singular `envelope` and no map.
    if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).envelopes) {
      return;
    }

    const payload = parseQueuePayload(raw);
    if (!payload) {
      console.warn('⚠️ Invalid queue message payload, skipping:', messageId);
      return;
    }

    // E2E decrypt (doc 31 §3.3). fanOutQueuedMessage hands each device only
    // its OWN envelope, so `envelope` here is already the one addressed to us.
    // On failure we keep going with whatever plaintext the payload carried:
    // dropping the message would make a dead session (peer reinstalled, new
    // identity) look like permanent message loss.
    const envelope = raw?.envelope as { t?: number; b?: string } | undefined;
    const senderSignalDeviceId = Number(raw?.senderSignalDeviceId);
    if (envelope?.b != null && envelope?.t != null && Number.isFinite(senderSignalDeviceId)) {
      const decrypted = await decryptMessageEnvelope(payload.senderId, senderSignalDeviceId, {
        t: envelope.t,
        b: envelope.b,
      });
      if (decrypted) {
        if (typeof decrypted.content === 'string') payload.content = decrypted.content;
        if (payload.replyTo && typeof decrypted.replyToContent === 'string') {
          payload.replyTo.content = decrypted.replyToContent;
        }
        if (decrypted.location) payload.location = decrypted.location;
      } else if (!payload.content && payload.type === 'text') {
        // THE "PLAINTEXT FALLBACK" ABOVE IS A FICTION FOR ENCRYPTED MESSAGES.
        // The sender blanks `content` precisely because it encrypted it, so
        // when decryption fails there is nothing left to fall back TO — the
        // message saved with an empty string and rendered as an empty bubble.
        // That is what "messages appear blank on the other device" was.
        //
        // Say so instead. A visible failure is recoverable (the user can ask
        // for a resend, and the identity-change repair in
        // ensureSessionWithDevice fixes the next one); a blank bubble looks
        // like the sender sent nothing, and silently loses real content.
        payload.content = '⚠️ Couldn’t decrypt this message';
      }
    }

    // Our own message arriving via the self-sync mirror (doc 31 §3.3), as
    // opposed to a message from someone else. Several behaviours below differ.
    const isSelfAuthored = payload.senderId === userId;

    processingMessageIds.add(messageId);

    try {
      let localMediaPath: string | undefined;
      let mediaDownloaded = false;
      const hasMedia =
        payload.type !== 'text' && payload.type !== 'system' && payload.type !== 'location' && payload.type !== 'expense';

      if (hasMedia && payload.mediaUrl) {
        try {
          const fileName = payload.mediaMetadata?.fileName || `${messageId}.${payload.type === 'image' ? 'jpg' : 'dat'}`;
          const result = await downloadMedia(payload.mediaUrl, payload.chatId, messageId, fileName);
          if (result && result.localPath) {
            localMediaPath = result.localPath;
            mediaDownloaded = true;
            console.log('📥 Media downloaded and saved:', localMediaPath);
          }
        } catch (error) {
          console.error('❌ Error downloading media:', error);
        }
      }

      const message: ChatMessage = {
        id: messageId,
        messageId,
        requestId: payload.requestId ?? messageId,
        chatId: payload.chatId,
        senderId: payload.senderId,
        content: payload.content,
        type: payload.type,
        timestamp: payload.timestamp,
        createdAt: payload.timestamp,
        mediaUrl: payload.mediaUrl ?? undefined,
        ...(localMediaPath ? { localMediaPath, mediaDownloaded } : {}),
        mediaMetadata: payload.mediaMetadata,
        replyTo: payload.replyTo,
        location: payload.location,
        forwardedFrom: payload.forwardedFrom,
        expenseRef: payload.expenseRef,
        // A message we authored, arriving here via the self-sync mirror
        // (doc 31 §3.3), is NOT "delivered to us" — that would claim the real
        // recipient received it. Carry the sending device's own status
        // instead, defaulting to 'sent'.
        status: isSelfAuthored
          ? ((typeof raw?.status === 'string' ? raw.status : 'sent') as ChatMessage['status'])
          : 'delivered',
        // Left false even for our own mirrored messages, deliberately: this
        // flag drives MEDIA resolution (useResolvedMediaUri / AlbumBubble),
        // and the mirroring device genuinely does not hold the local file, so
        // it must download like any receiver. Bubble alignment does not depend
        // on it — MessageBubble derives that from senderId.
        isFromMe: false,
        deliveredTo: [],
        readBy: [],
      };

      await onMessageReceived(message);
      // Never acknowledge our OWN message. A delivery receipt is keyed by the
      // acknowledging user, so self-sync would write the sender's own id into
      // deliveredTo — making a message look delivered to a recipient purely
      // because the sender has a second device.
      if (!isSelfAuthored) {
        await sendDeliveryReceipt(payload.chatId, messageId, userId, payload.isGroupChat ?? false);
      }
      await remove(ref(rtdb, deletePath(messageId)));
      console.log('✅ Message delivered and removed from queue:', messageId);
    } catch (error) {
      console.error('❌ Error processing message:', error);
    } finally {
      processingMessageIds.delete(messageId);
    }
  };

  const unsubscribeAdded = onChildAdded(queueRef, (snapshot) => {
    void processMessageSnapshot(snapshot);
  });

  const unsubscribeChanged = onChildChanged(queueRef, (snapshot) => {
    void processMessageSnapshot(snapshot);
  });

  return () => {
    unsubscribeAdded();
    unsubscribeChanged();
  };
};

/**
 * Listen for incoming messages in current user's LEGACY (per-user, not
 * per-device) queue. Kept as a dual-listen fallback (see
 * attachQueueListener's comment) for any recipient without a confirmed
 * pairedDevices row yet — new code should prefer listenForMessagesOnDevice.
 */
export const listenForMessages = (
  userId: string,
  onMessageReceived: (message: ChatMessage) => Promise<void>
): (() => void) =>
  attachQueueListener(
    `messageQueue/${userId}`,
    (messageId) => `messageQueue/${userId}/${messageId}`,
    userId,
    onMessageReceived
  );

/**
 * Listen for incoming messages on THIS device's own fanned-out queue
 * (doc 31 §3.1/§5 Phase 2) — messageQueueDevices/{userId}/{deviceId},
 * populated server-side by functions/src/messageFanout.ts's
 * fanOutQueuedMessage trigger, never written to directly by any client.
 */
export const listenForMessagesOnDevice = (
  userId: string,
  deviceId: string,
  onMessageReceived: (message: ChatMessage) => Promise<void>
): (() => void) =>
  attachQueueListener(
    `messageQueueDevices/${userId}/${deviceId}`,
    (messageId) => `messageQueueDevices/${userId}/${deviceId}/${messageId}`,
    userId,
    onMessageReceived
  );

/**
 * Send delivery receipt to sender (supports both 1:1 and group chats)
 * For group chats, stores per-user receipt under the messageId
 */
export const sendDeliveryReceipt = async (
  chatId: string,
  messageId: string,
  recipientId: string,
  _isGroupChat: boolean = false
): Promise<void> => {
  try {
    const receiptRef = ref(rtdb, `receipts/${chatId}/${messageId}/${recipientId}`);
    await update(receiptRef, {
      delivered: true,
      deliveredAt: Date.now(),
      recipientId,
    });

    console.log('✅ Delivery receipt sent for:', messageId);
  } catch (error) {
    console.error('❌ Error sending delivery receipt:', error);
  }
};

/**
 * Send read receipt (supports both 1:1 and group chats)
 */
export const sendReadReceipt = async (
  chatId: string,
  messageId: string,
  recipientId: string,
  _isGroupChat: boolean = false
): Promise<void> => {
  const receiptRef = ref(rtdb, `receipts/${chatId}/${messageId}/${recipientId}`);
  const now = Date.now();

  try {
    const existingSnapshot = await get(receiptRef);
    const existingValue = existingSnapshot.val() as Partial<ReceiptData> | null;
    const deliveredAt = typeof existingValue?.deliveredAt === 'number' ? existingValue.deliveredAt : now;

    // Always write a complete receipt object to satisfy strict RTDB validation.
    await update(receiptRef, {
      delivered: true,
      deliveredAt,
      recipientId,
      read: true,
      readAt: now,
    });
    console.log('✅ Read receipt sent for:', messageId);
  } catch (error) {
    console.error('❌ Error sending read receipt:', error);
  }
};

/**
 * Send read receipts for multiple messages at once using a single multi-path update.
 */
export const sendBulkReadReceipts = async (
  chatId: string,
  messageIds: string[],
  recipientId: string,
  isGroupChat: boolean = false
): Promise<void> => {
  try {
    if (messageIds.length === 0) {
      return;
    }

    const now = Date.now();
    const updates: Record<string, PersistedReceiptData> = {};

    await Promise.all(
      messageIds.map(async (messageId) => {
        const receiptRef = ref(rtdb, `receipts/${chatId}/${messageId}/${recipientId}`);
        const existingSnapshot = await get(receiptRef);
        const existingValue = existingSnapshot.val() as Partial<ReceiptData> | null;
        const deliveredAt = typeof existingValue?.deliveredAt === 'number' ? existingValue.deliveredAt : now;

        updates[`receipts/${chatId}/${messageId}/${recipientId}`] = {
          delivered: true,
          deliveredAt,
          recipientId,
          read: true,
          readAt: now,
        };
      })
    );

    await update(ref(rtdb), updates);
    console.log(`✅ Bulk read receipts sent for ${messageIds.length} messages`);
  } catch (error) {
    console.error('❌ Error sending bulk read receipts:', error);
    if (messageIds.length > 0) {
      await Promise.all(messageIds.map((messageId) => sendReadReceipt(chatId, messageId, recipientId, isGroupChat)));
    }
  }
};

/**
 * Listen for delivery and read receipts.
 * Uses child listeners to process only changed message receipts.
 */
export const listenForReceipts = (
  chatId: string,
  onReceiptReceived: (
    messageId: string,
    status: 'delivered' | 'read',
    recipientId?: string,
    allDelivered?: string[],
    allRead?: string[]
  ) => void,
  isGroupChat: boolean = false,
  onError?: (error: Error) => void,
): (() => void) => {
  const receiptsRef = ref(rtdb, `receipts/${chatId}`);
  const fingerprints = new Map<string, string>();

  const processReceiptSnapshot = (snapshot: DataSnapshot): void => {
    const messageId = snapshot.key;
    if (!messageId || messageId === '__participants') {
      return;
    }

    const receiptMap = normalizeReceiptMap(snapshot.val());
    const allDelivered = Object.entries(receiptMap)
      .filter(([, receipt]) => receipt.delivered)
      .map(([recipientId]) => recipientId)
      .sort();
    const allRead = Object.entries(receiptMap)
      .filter(([, receipt]) => receipt.read)
      .map(([recipientId]) => recipientId)
      .sort();

    const status: 'delivered' | 'read' | null = allRead.length > 0
      ? 'read'
      : allDelivered.length > 0
        ? 'delivered'
        : null;

    if (!status) {
      fingerprints.delete(messageId);
      return;
    }

    const fingerprint = getReceiptFingerprint(status, allDelivered, allRead);
    if (fingerprints.get(messageId) === fingerprint) {
      return;
    }

    fingerprints.set(messageId, fingerprint);

    if (isGroupChat) {
      onReceiptReceived(messageId, status, undefined, allDelivered, allRead);
      return;
    }

    const recipientId = status === 'read' ? allRead[0] : allDelivered[0];
    if (recipientId) {
      onReceiptReceived(messageId, status, recipientId);
    }
  };

  const unsubscribeAdded = onChildAdded(
    receiptsRef,
    processReceiptSnapshot,
    (error: Error) => {
      console.warn('⚠️ Receipt listener (added) cancelled:', error);
      onError?.(error);
    }
  );
  const unsubscribeChanged = onChildChanged(
    receiptsRef,
    processReceiptSnapshot,
    (error: Error) => {
      console.warn('⚠️ Receipt listener (changed) cancelled:', error);
      onError?.(error);
    }
  );

  return () => {
    unsubscribeAdded();
    unsubscribeChanged();
    fingerprints.clear();
  };
};
