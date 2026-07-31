/**
 * Uploads messages created while offline, once Internet connectivity returns.
 *
 * Covers DIRECT chats as well as groups (doc 32 §5a). It used to skip direct
 * chats entirely, which left an offline DM with exactly one delivery route —
 * physical mesh proximity — so a DM sent while the recipient was away was
 * silently dropped at the 7-day TTL if the two phones never met again, even
 * though both had been online the whole time. That was not a privacy boundary:
 * a DM sent while online already travels this same RTDB path. `originOwned`
 * is the guard that stops a relay impersonating another sender; chat type
 * never was.
 *
 * Ordering (doc 32 §5b): operations are grouped per chat and each chat is
 * drained strictly in creation order, because letting a later message land
 * before an earlier stuck one would reorder that conversation on the server.
 * Chats are independent of each other, so one blocked conversation no longer
 * starves every other one — which is what a single global FIFO break did.
 */
import { db } from '@/firebase';
import { doc, updateDoc } from 'firebase/firestore';
import {
  loadMeshMessageQueue,
  removeMeshMessage,
  updateMeshMessage,
  type MeshMessageOperation,
} from '@/services/meshMessageQueue';
import {
  queueMessage,
  queueMessageToOwnDevices,
} from '@/services/messageQueueService';
import {
  saveMessageLocally,
  updateMessageStatus,
} from '@/services/localMessageStorage';
import { uploadMedia } from '@/services/mediaService';
import { discardNearbyAttachment } from '../../modules/splitcircle-mesh';

let flushing = false;

/**
 * Give up cloud-relaying one operation after this many failed attempts and
 * surface it as a failed message (doc 32 §5b). Without a cap, a permanently
 * undeliverable operation retried on every reconnect until the 7-day TTL
 * silently discarded it — the user was never told, and never got the chance
 * to retry it themselves.
 */
const MAX_CLOUD_RELAY_ATTEMPTS = 6;

/** Escalating delay before the Nth retry, capped at the last entry. */
const CLOUD_RELAY_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];

const backoffFor = (attempts: number): number =>
  CLOUD_RELAY_BACKOFF_MS[Math.min(attempts - 1, CLOUD_RELAY_BACKOFF_MS.length - 1)];

const previewFor = (type: string, content: string): string => {
  switch (type) {
    case 'image': return 'photo';
    case 'video': return 'video';
    case 'audio': return 'audio';
    case 'file': return 'document';
    case 'location': return 'location';
    default: return content;
  }
};

/**
 * Drains ONE conversation's queued operations, oldest first, stopping at the
 * first failure so a later message can never overtake a stuck earlier one on
 * the server. Scoped to a single chat on purpose: ordering is a
 * per-conversation guarantee, and enforcing it globally is what let one
 * broken operation starve every other conversation (doc 32 §5b).
 */
const drainChatBucket = async (
  chatOperations: MeshMessageOperation[],
  currentUserId: string,
  now: number,
): Promise<void> => {
  for (const queuedOperation of chatOperations) {
    let operation = queuedOperation;
    // Still inside this operation's backoff window. Stop draining THIS
    // chat — a later message must not overtake it — but leave every other
    // chat free to proceed.
    if (
      operation.cloudRelayNextAttemptAt !== undefined
      && operation.cloudRelayNextAttemptAt > now
    ) {
      break;
    }

    const recipients = operation.participantIds.filter((id) => id !== currentUserId);
    try {
      if (operation.message.status === 'sending') {
        operation = {
          ...operation,
          message: { ...operation.message, status: 'sent' },
        };
        await Promise.all([
          updateMeshMessage(operation),
          saveMessageLocally(operation.message),
        ]);
      }

      if (
        operation.nearbyAttachment?.localPath
        && operation.message.type !== 'text'
        && !operation.message.mediaUrl
      ) {
        const upload = await uploadMedia(
          operation.nearbyAttachment.localPath,
          operation.message.chatId,
          operation.message.messageId,
          operation.nearbyAttachment.fileName,
          operation.nearbyAttachment.mimeType,
        );
        const message = {
          ...operation.message,
          mediaUrl: upload.downloadUrl,
          localMediaPath: upload.localPath,
          mediaDownloaded: true,
        };
        operation = {
          ...operation,
          message,
          nearbyAttachment: {
            ...operation.nearbyAttachment,
            localPath: upload.localPath,
          },
        };
        // Persist before recipient fan-out. If the process dies halfway,
        // retry reuses the stable message/storage id and never uploads a
        // second logical attachment.
        await Promise.all([
          updateMeshMessage(operation),
          saveMessageLocally(message),
        ]);
      }

      // Derived, never hardcoded: this path was group-only when it was
      // written, so both calls passed a literal `true`. With direct chats
      // now relayed too (doc 32 §5a) that would label a DM a group message,
      // which changes delivery-receipt and notification handling on the
      // receiving side.
      const isGroupChat = operation.chatType === 'group';
      for (const recipientId of recipients) {
        await queueMessage(recipientId, operation.message, isGroupChat);
      }
      await queueMessageToOwnDevices(currentUserId, operation.message, isGroupChat);
      await updateDoc(doc(db, 'chats', operation.message.chatId), {
        groupId: operation.groupId ?? null,
        updatedAt: operation.message.createdAt,
        lastMessage: {
          messageId: operation.message.messageId,
          senderId: operation.message.senderId,
          type: operation.message.type,
          content: previewFor(operation.message.type, operation.message.content),
          createdAt: operation.message.createdAt,
        },
      });
      await updateMessageStatus(operation.message.chatId, operation.message.id, 'sent');
      await removeMeshMessage(operation.id);
      if (operation.nearbyAttachment) {
        discardNearbyAttachment(operation.nearbyAttachment.transferId);
      }
    } catch {
      // Stop draining THIS conversation and retry it later: continuing past
      // a failure would reorder the conversation on the server. Other chats
      // are unaffected — that is the whole point of the per-chat buckets.
      //
      // Record the attempt so a permanently broken operation backs off
      // instead of re-failing on every single reconnect, and eventually
      // gives up loudly rather than being swallowed by the 7-day TTL.
      try {
        const attempts = (operation.cloudRelayAttempts ?? 0) + 1;
        if (attempts >= MAX_CLOUD_RELAY_ATTEMPTS) {
          // Out of retries. Tell the user — a visible failed message is
          // recoverable (they can resend) where a silent TTL expiry is not.
          // `cloudRelay: false` retires it from this path only; any nearby
          // envelope it still carries stays broadcastable, and it no longer
          // holds up the rest of this conversation.
          await updateMeshMessage({
            ...operation,
            cloudRelay: false,
            cloudRelayAttempts: attempts,
          });
          await updateMessageStatus(
            operation.message.chatId,
            operation.message.id,
            'failed',
          );
        } else {
          await updateMeshMessage({
            ...operation,
            cloudRelayAttempts: attempts,
            cloudRelayNextAttemptAt: now + backoffFor(attempts),
          });
        }
      } catch {
        // Bookkeeping is best-effort: if even the queue write fails, the
        // operation simply retries unchanged on the next flush. Never let
        // this escape and abort the remaining chats.
      }
      break;
    }
  }
};

export const flushMeshCloudRelay = async (currentUserId: string): Promise<void> => {
  if (!currentUserId || flushing) return;
  flushing = true;
  try {
    const operations = await loadMeshMessageQueue();
    const now = Date.now();

    // Bucket by chat, preserving creation order inside each bucket. Ordering
    // only has to hold WITHIN a conversation; the previous single global loop
    // enforced it across every chat at once, so one stuck operation blocked
    // unrelated conversations indefinitely (doc 32 §5b).
    const byChat = new Map<string, MeshMessageOperation[]>();
    for (const operation of operations) {
      if (
        !operation.originOwned
        || !operation.cloudRelay
        || operation.originUserId !== currentUserId
      ) {
        continue;
      }
      const bucket = byChat.get(operation.message.chatId);
      if (bucket) bucket.push(operation);
      else byChat.set(operation.message.chatId, [operation]);
    }

    for (const chatOperations of byChat.values()) {
      await drainChatBucket(chatOperations, currentUserId, now);
    }
  } finally {
    flushing = false;
  }
};
