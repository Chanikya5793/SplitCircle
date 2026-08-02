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
import {
  consumeLastDecryptError,
  decryptMessageEnvelope,
  encryptMessageForRecipient,
} from '@/services/messageEnvelope';
import { getOrCreateInstallationId } from '@/services/notificationService';
import { getCachedSignalDeviceId } from '@/services/signalCryptoService';

// Get Realtime Database instance
const rtdb = getDatabase();

// Type for receipt data structure
export interface ReceiptData {
  delivered?: boolean;
  deliveredAt?: number;
  read?: boolean;
  readAt?: number;
  /**
   * The recipient received these bytes and proved they were authentic, but
   * could not open them (doc 32 §5c) — a dead Signal session, or an HPKE
   * fallback whose identity key was never seeded. Distinct from `delivered`
   * on purpose: the message physically arrived, and the sender's transport
   * ack already said so, but the content is unreadable and re-sending is the
   * only repair. Without this the sender was told "sent" for a message that
   * was silently discarded on the other phone.
   */
  undecryptable?: boolean;
  undecryptableAt?: number;
  /**
   * libsignal device id of the device that could not decrypt. The sender needs
   * it to repair the EXACT session: a user can have several devices, and
   * rebuilding all of them on one device's failure would needlessly reset
   * healthy ratchets.
   */
  undecryptableDeviceId?: number;
  recipientId: string;
}

interface PersistedReceiptData {
  delivered: boolean;
  deliveredAt: number;
  read?: boolean;
  readAt?: number;
  undecryptable?: boolean;
  undecryptableAt?: number;
  undecryptableDeviceId?: number;
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
  status: 'delivered' | 'read' | 'undecryptable',
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
      'network-preferred',
      // BEST-EFFORT PER DEVICE, NOT ALL-OR-NOTHING. The default 'all-devices'
      // policy THROWS EncryptionRequiredError when even one device can't be
      // encrypted for, and the catch below swallows it — so a single sibling
      // with an unestablishable session (ensureSessionWithDevice returns false
      // silently on any claim failure) stopped the message reaching EVERY
      // other device of ours, healthy ones included. That is the wrong trade
      // here: strict coverage exists to stop a downgrade-to-plaintext attack
      // on a REAL recipient, but self-sync never falls back to plaintext and
      // is explicitly "a convenience, not a delivery guarantee" (see below),
      // so delivering to the reachable devices strictly beats delivering to
      // none. Confirmed against production logs: fanOutQueuedMessage recorded
      // skippedOrigin:true (the self-mirror) exactly once across a whole
      // session of sending, while peer fan-outs to the same 3-device account
      // succeeded continuously. See ai_layer/docs/32 §10.
      'available-devices',
    );

    // No other device of ours has published keys (single-device account, or
    // the others haven't synced yet) — nothing to mirror, and falling back to
    // plaintext here would put our own message content in transit for no
    // benefit, since there is no device waiting to read it.
    //
    // LOUD, not silent. 'available-devices' (above) turns "no sibling could be
    // encrypted for" into an empty map rather than a throw, so on a
    // multi-device account this branch is indistinguishable from a successful
    // send at every layer: the message reaches its real recipients, the UI
    // shows 'sent', and nothing is ever written to RTDB — so there is no
    // fanOutQueuedMessage log either. That is precisely how self-sync can be
    // dead for days while every observable signal looks healthy.
    if (!encrypted) {
      return;
    }
    // Distinct from the null case above, and the only one worth shouting about:
    // null means there was nobody to mirror to (a genuinely single-device
    // account — normal, and logging it would cry wolf on every message those
    // users send). An empty map means siblings DO exist and not one of them
    // could be encrypted for.
    //
    // LOUD, because 'available-devices' (above) turns that into an empty map
    // rather than a throw, making it indistinguishable from success at every
    // layer: the message reaches its real recipients, the UI shows 'sent', and
    // nothing is written to RTDB — so there is no fanOutQueuedMessage log
    // either. That is how self-sync can be dead for days while every
    // observable signal looks healthy.
    if (Object.keys(encrypted.envelopes).length === 0) {
      console.error(
        '⚠️ Self-sync produced no envelopes — could not encrypt to ANY sibling '
        + 'device. Their sessions are likely stale (reinstall/restore); they will '
        + 'not receive this message.',
        { messageId: message.id, chatId: message.chatId },
      );
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

    // SANITIZED, exactly like queueGapFillMessage below and for the same
    // reason. This function was written for the online send path, where the
    // message is built field-by-field moments earlier and every optional field
    // is either set or absent. flushMeshCloudRelay (doc 32 §5a) also calls it,
    // with an `operation.message` reconstructed from the on-disk mesh queue —
    // "arbitrary local history", where an optional field can round-trip as an
    // explicit `undefined`. RTDB rejects `undefined` outright, so one such
    // field made `set` throw into the catch below, which swallows it: the
    // message reached its real recipients over the mesh, the sender showed
    // 'sent', and the user's own other devices silently never received it.
    // Note the raw spreads above (mediaMetadata/replyTo/forwardedFrom/
    // expenseRef) copy stored objects wholesale, so this is not hypothetical.
    await set(
      ref(rtdb, `messageQueue/${senderId}/${message.id}`),
      stripUndefinedDeep(messageData),
    );
  } catch (error) {
    // Never fail the send because self-sync failed: the message already
    // reached its actual recipients, and the user's other devices catching up
    // is a convenience, not a delivery guarantee.
    //
    // console.ERROR, not warn: a Release bundle's console.warn never reaches
    // the device log (CLAUDE.md), which is exactly why this swallow hid a
    // total self-sync outage — every send looked fine and no phone could show
    // otherwise. Keep this the loudest thing a non-fatal path can do.
    // Carries the ids: "failed to mirror" with no message id cannot be matched
    // against the one message a user reports missing on their other phone,
    // which is the only way this path is ever observed from the outside.
    console.error(
      '⚠️ Failed to mirror message to own devices:',
      error,
      { messageId: message.id, chatId: message.chatId, type: message.type },
    );
  }
};

/**
 * RTDB rejects `undefined` outright. Local messages can legitimately carry
 * undefined optional fields (a locally-composed `mediaMetadata` is built with
 * spread-conditionals, and older stored messages predate fields added since),
 * so a gap-fill replay of arbitrary local history has to sanitize where the
 * normal send path could rely on building its payload field-by-field.
 *
 * Plain data only — unlike GroupContext's `stripUndefinedDeep` (see CLAUDE.md)
 * this never sees a Firestore FieldValue sentinel, because nothing here writes
 * to Firestore.
 */
const stripUndefinedDeep = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefinedDeep(entry)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = stripUndefinedDeep(entry);
    }
    return out as unknown as T;
  }
  return value;
};

/**
 * Replays ONE already-stored message to this account's other devices, to fill a
 * gap another device reported (doc 31 §8.1 / `syncGapService.ts`).
 *
 * Deliberately a sibling of `queueMessageToOwnDevices` rather than an option on
 * it: that function is on the hot send path and mirrors only messages THIS
 * device just authored, where `message.senderId === ownerUserId` always holds.
 * Gap-fill replays history in both directions, so it must carry a message whose
 * author is a PEER — which changes two things that would silently corrupt the
 * self-mirror path if folded into it:
 *
 * 1. `envelopeSenderId`. The receiver names its Signal session by the sender's
 *    USER id, but a replayed peer message is encrypted by one of the owner's
 *    OWN devices. Without this field the receiver would look up a session keyed
 *    to the original peer and fail to decrypt every replayed message. It is the
 *    identity that signed the ciphertext; `senderId` stays the message's true
 *    author, which is what the UI attributes it to.
 * 2. `gapFill`. Suppresses the delivery receipt on the receive side — a replay
 *    is not a fresh delivery, and re-acknowledging an old message would rewrite
 *    its receipt with a misleading new `deliveredAt`.
 *
 * Coverage is deliberately `available-devices`, NOT the send path's strict
 * `all-devices`: a stale sibling device that never published keys must not be
 * able to block repairing a different, healthy device (that strictness exists
 * to stop an attacker forcing plaintext on a real SEND — there is no such
 * downgrade here, since a device we cannot encrypt for is simply skipped and
 * stays behind until it publishes).
 *
 * Returns whether anything was actually queued.
 */
export const queueGapFillMessage = async (
  ownerUserId: string,
  message: ChatMessage,
  isGroupChat: boolean = false,
): Promise<boolean> => {
  const originDeviceId = await getOrCreateInstallationId();

  const encrypted = await encryptMessageForRecipient(
    ownerUserId,
    {
      content: message.content,
      replyToContent: message.replyTo?.content,
      location: message.location,
    },
    originDeviceId,
    'network-preferred',
    'available-devices',
  );

  // No other device of ours can be encrypted for. Skipping matches
  // queueMessageToOwnDevices' rule: putting our own history in transit buys
  // nothing when no device is able to read it.
  if (!encrypted || Object.keys(encrypted.envelopes).length === 0) {
    return false;
  }

  const messageData: Record<string, unknown> = {
    // The true author, preserved — this is what the receiving device attributes
    // the message to, and it is NOT necessarily this account.
    senderId: message.senderId,
    envelopeSenderId: ownerUserId,
    gapFill: true,
    chatId: message.chatId,
    requestId: message.requestId ?? message.id,
    content: '',
    type: message.type,
    timestamp: message.createdAt ?? message.timestamp,
    mediaUrl: message.mediaUrl || null,
    thumbnailUrl: message.thumbnailUrl || null,
    isGroupChat,
    originDeviceId,
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

  // The relay node's KEY must stay the message id — fanOutQueuedMessage
  // forwards it as the per-device key and the receiver reads `snapshot.key` as
  // the message id, so any other key would land as a NEW message instead of
  // deduping against the copy the requester may already hold.
  //
  // Hence the delete first. `fanOutQueuedMessage` is an onValueCreated trigger,
  // so a plain `set` over a node that still exists is an UPDATE and fires
  // nothing — and a node does linger whenever a previous fan-out threw (its
  // error path deliberately leaves the node in place). Without this, replaying
  // exactly the message most likely to have failed delivery would silently do
  // nothing, forever. Removing first guarantees the create the trigger needs.
  const relayRef = ref(rtdb, `messageQueue/${ownerUserId}/${message.id}`);
  await remove(relayRef);
  await set(relayRef, stripUndefinedDeep(messageData));
  return true;
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
      // console.error, not warn (CLAUDE.md): dropping an incoming message here
      // leaves no other trace anywhere — functionally identical, from the
      // user's side, to the message simply never arriving.
      console.error('⚠️ Invalid queue message payload, skipping:', messageId);
      return;
    }

    // E2E decrypt (doc 31 §3.3). fanOutQueuedMessage hands each device only
    // its OWN envelope, so `envelope` here is already the one addressed to us.
    // On failure we keep going with whatever plaintext the payload carried:
    // dropping the message would make a dead session (peer reinstalled, new
    // identity) look like permanent message loss.
    const envelope = raw?.envelope as { t?: number; b?: string } | undefined;
    const senderSignalDeviceId = Number(raw?.senderSignalDeviceId);
    /** Set when this device proved the message authentic but could not open it. */
    let undecryptableHere = false;
    // WHO ENCRYPTED THIS is not always WHO WROTE IT. For an ordinary message
    // they're the same person, but a gap-fill replay (queueGapFillMessage) is
    // a peer's message re-encrypted by one of OUR OWN devices — the Signal
    // session is keyed to that device's user id, not to the original author.
    // Falling back to payload.senderId keeps every pre-existing payload shape
    // decrypting exactly as before.
    const envelopeSenderId = typeof raw?.envelopeSenderId === 'string' && raw.envelopeSenderId
      ? raw.envelopeSenderId
      : payload.senderId;
    // A replay is not a fresh delivery: no receipt, and it carries the
    // originating device's own view of the message's status.
    const isGapFill = raw?.gapFill === true;
    if (envelope?.b != null && envelope?.t != null && Number.isFinite(senderSignalDeviceId)) {
      const decrypted = await decryptMessageEnvelope(
        envelopeSenderId,
        senderSignalDeviceId,
        { t: envelope.t, b: envelope.b },
      );
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
        // Carries the REASON. "Couldn't decrypt" alone left us guessing at
        // which of several failure modes was happening on a real phone, and
        // Release-build JS logs never reach the device console — so the
        // message itself has to be the diagnostic.
        const reason = consumeLastDecryptError();
        payload.content = reason
          ? `⚠️ Couldn’t decrypt this message (${reason.slice(0, 80)})`
          : '⚠️ Couldn’t decrypt this message';
        // Tell the SENDER too (doc 32 §5c). Until this, the failure was
        // visible only on the receiving phone: the sender saw a successful
        // send for a message the other side could not read, and had no reason
        // to resend it.
        undecryptableHere = true;
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
        status: (isSelfAuthored || isGapFill)
          ? ((typeof raw?.status === 'string'
              ? raw.status
              : (isSelfAuthored ? 'sent' : 'delivered')) as ChatMessage['status'])
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
      // SELF-SYNC MUST REPORT A DECRYPT FAILURE TOO.
      //
      // This used to skip both receipts for a self-authored message, and the
      // reasoning only ever applied to the DELIVERY receipt (which is keyed by
      // the acknowledging user, so self-sync would make a message look
      // delivered to a recipient purely because the sender owns two phones).
      //
      // Applying the same skip to the UNDECRYPTABLE receipt created a
      // permanent one-way break: our own other device proves the message
      // authentic, cannot open it, and has no way to say so — so the sending
      // device never learns its session is dead and never rebuilds it. Every
      // subsequent self-sync message fails identically, forever. Observed on a
      // Pixel as a wall of "Couldn't decrypt this message" from the user's own
      // account that never recovered.
      //
      // The report is safe here because the SENDER distinguishes a self-report
      // from a peer's (see ChatContext): it rebuilds the session either way,
      // but only marks the message failed when a real recipient could not read
      // it.
      if (undecryptableHere && !isGapFill) {
        await sendUndecryptableReceipt(
          payload.chatId,
          messageId,
          userId,
          getCachedSignalDeviceId() ?? undefined,
        );
      }

      // The DELIVERY receipt stays peer-only: it is keyed by the acknowledging
      // user, so a self-sync ack would make a message look delivered to a
      // recipient purely because the sender owns two phones. And it is sent
      // INSTEAD of the undecryptable report above, never alongside —
      // "delivered" outranks "undecryptable" on the sender's side by design,
      // so sending both would hide the very thing being reported.
      if (!isSelfAuthored && !isGapFill && !undecryptableHere) {
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
 * Reports that an authentic message could not be decrypted on this device
 * (doc 32 §5c, Scenario C).
 *
 * Deliberately travels the SAME `receipts/` channel as delivered/read rather
 * than a new mesh NACK protocol: the sender is already listening there, and
 * an RTDB write made while offline lands as soon as connectivity returns — so
 * this works for the offline-mesh case that motivated it without inventing a
 * second signed wire format.
 *
 * Only ever sent for an envelope that already PASSED authorization/signature
 * verification. An unauthorized or unverifiable envelope is still dropped
 * silently, because acknowledging it would confirm receipt to an unverified
 * sender.
 */
export const sendUndecryptableReceipt = async (
  chatId: string,
  messageId: string,
  recipientId: string,
  reportingSignalDeviceId?: number,
): Promise<void> => {
  try {
    await update(ref(rtdb, `receipts/${chatId}/${messageId}/${recipientId}`), {
      undecryptable: true,
      undecryptableAt: Date.now(),
      ...(typeof reportingSignalDeviceId === 'number'
        ? { undecryptableDeviceId: reportingSignalDeviceId }
        : {}),
      recipientId,
    });
  } catch (error) {
    // Best-effort. The receiver already shows its own placeholder bubble, so
    // failing here degrades the sender's view, not the receiver's.
    console.error('❌ Error sending undecryptable receipt:', error);
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
    status: 'delivered' | 'read' | 'undecryptable',
    recipientId?: string,
    allDelivered?: string[],
    allRead?: string[],
    /** Set only for 'undecryptable': which device of theirs failed. */
    undecryptableDeviceId?: number,
  ) => void,
  isGroupChat: boolean = false,
  onError?: (error: Error) => void,
  /**
   * The listening user's own id, so a group's undecryptable representative can
   * avoid being the sender's own self-sync report. Optional for callers that
   * predate it; without it the old (sorted-first) behaviour applies.
   */
  ownUserId?: string,
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

    const allUndecryptable = Object.entries(receiptMap)
      .filter(([, receipt]) => receipt.undecryptable)
      .map(([recipientId]) => recipientId)
      .sort();

    // Strictly the weakest signal: a real read or delivery from ANY recipient
    // outranks it, so a group message that one stale device could not open is
    // not reported as failed to the sender while everyone else read it.
    const status: 'delivered' | 'read' | 'undecryptable' | null = allRead.length > 0
      ? 'read'
      : allDelivered.length > 0
        ? 'delivered'
        : allUndecryptable.length > 0
          ? 'undecryptable'
          : null;

    if (!status) {
      fingerprints.delete(messageId);
      return;
    }

    const fingerprint = getReceiptFingerprint(status, allDelivered, allRead)
      + (status === 'undecryptable' ? `|u:${allUndecryptable.join(',')}` : '');
    if (fingerprints.get(messageId) === fingerprint) {
      return;
    }

    fingerprints.set(messageId, fingerprint);

    if (isGroupChat) {
      // WHICH undecryptable report represents the group matters (doc 35).
      //
      // This picks ONE userId to stand for the whole group, and the consumer in
      // ChatContext returns early when that userId is the sender's own — a
      // self-sync report says the sender's session with its own other device is
      // dead, which must not be shown as a failed delivery to the group. But
      // `allUndecryptable` is sorted, so if the sender's own account sorted
      // first, a REAL member's simultaneous report was discarded with it, and
      // the message kept its previous confident status: a genuine delivery
      // failure to an actual human, permanently hidden.
      //
      // Prefer any OTHER member as the representative, falling back to self
      // only when self is the only report — the case where returning early is
      // exactly right.
      const representative = status === 'undecryptable'
        ? (allUndecryptable.find((userId) => userId !== ownUserId) ?? allUndecryptable[0])
        : undefined;
      onReceiptReceived(
        messageId,
        status,
        representative,
        allDelivered,
        allRead,
        representative ? receiptMap[representative]?.undecryptableDeviceId : undefined,
      );
      return;
    }

    const recipientId = status === 'read'
      ? allRead[0]
      : status === 'delivered'
        ? allDelivered[0]
        : allUndecryptable[0];
    if (recipientId) {
      onReceiptReceived(
        messageId,
        status,
        recipientId,
        undefined,
        undefined,
        status === 'undecryptable'
          ? receiptMap[recipientId]?.undecryptableDeviceId
          : undefined,
      );
    }
  };

  const unsubscribeAdded = onChildAdded(
    receiptsRef,
    processReceiptSnapshot,
    (error: Error) => {
      console.error('⚠️ Receipt listener (added) cancelled:', error);
      onError?.(error);
    }
  );
  const unsubscribeChanged = onChildChanged(
    receiptsRef,
    processReceiptSnapshot,
    (error: Error) => {
      console.error('⚠️ Receipt listener (changed) cancelled:', error);
      onError?.(error);
    }
  );

  return () => {
    unsubscribeAdded();
    unsubscribeChanged();
    fingerprints.clear();
  };
};
