/**
 * Gap-fill batch format (ai_layer/docs/34 §3.1, §3.2 — step 4).
 *
 * A gap response used to be replayed message by message through
 * `queueGapFillMessage` → `fanOutQueuedMessage` → per-device RTDB writes: for a
 * gap of M messages across D linked devices, M×D encryptions, M×D writes, and M
 * function invocations, to move history the devices could have handed each
 * other once. This makes it ONE payload, sealed once to the requester.
 *
 * PURE. No crypto, no I/O, no native imports — the sealing lives with whatever
 * owns the keys. That keeps the part with the security-relevant invariants
 * exhaustively testable without a device, the same split doc 33 §2.5 used.
 *
 * THE INVARIANT THAT MATTERS. A batch states the range it CLAIMS to cover, and
 * whether it is complete. Without that a responder can return a subset while
 * looking authoritative, and the requester cannot tell "there was nothing more"
 * from "I withheld it" — absence is invisible. `until` and `complete` are what
 * make truncation an explicit, resumable fact rather than silent loss.
 */
import type { ChatMessage } from '@/models';

export const SYNC_BATCH_VERSION = 1 as const;

export interface SyncBatchBody {
  v: typeof SYNC_BATCH_VERSION;
  chatId: string;
  /** Exclusive lower bound — the requester's watermark. */
  since: number;
  /**
   * Inclusive upper bound this batch claims to cover. When `complete` is false
   * this is the newest message actually included, so the requester knows
   * exactly where to resume.
   */
  until: number;
  /** False when the byte budget truncated the range. */
  complete: boolean;
  messages: ChatMessage[];
}

/**
 * Byte budget for one batch.
 *
 * BYTES, not a message count. Doc 34 §6: 200 text messages and 200 messages
 * carrying media metadata differ by orders of magnitude, so a count-based cap
 * either wastes the budget or blows it. 256KB matches
 * `MAX_MESH_ENVELOPE_BYTES` — the largest payload this stack already moves.
 */
export const MAX_SYNC_BATCH_BYTES = 256 * 1024;

/**
 * Packs messages newer than `since` into one batch, oldest first.
 *
 * OLDEST FIRST is deliberate and matches `MAX_REPLAY_PER_REQUEST`'s existing
 * reasoning: serving the oldest advances the requester's watermark, so a
 * truncated batch is self-resuming rather than lossy — the next request asks
 * for the remainder and the gap closes in chunks. Newest-first would leave a
 * permanent hole in the middle that nothing would ever ask for again.
 */
export const packSyncBatch = (
  chatId: string,
  since: number,
  messages: readonly ChatMessage[],
  maxBytes: number = MAX_SYNC_BATCH_BYTES,
): SyncBatchBody => {
  const candidates = messages
    .filter((message) => (message.createdAt ?? 0) > since)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

  const newestAvailable = candidates.length > 0
    ? (candidates[candidates.length - 1].createdAt ?? since)
    : since;

  const included: ChatMessage[] = [];
  let bytes = 0;
  for (const message of candidates) {
    const size = JSON.stringify(message).length;
    // Always take the first message even if it alone exceeds the budget.
    // Refusing would stall the gap permanently on one oversized message, which
    // is strictly worse than one oversized batch.
    if (included.length > 0 && bytes + size > maxBytes) break;
    included.push(message);
    bytes += size;
  }

  const complete = included.length === candidates.length;
  return {
    v: SYNC_BATCH_VERSION,
    chatId,
    since,
    until: complete
      ? newestAvailable
      : (included[included.length - 1]?.createdAt ?? since),
    complete,
    messages: included,
  };
};

/**
 * Validates a decoded batch. Returns null for anything malformed.
 *
 * A trust boundary: this content came from another device. Never throws into
 * the receive path, and never returns a partially-trusted result — doc 34 §3.2
 * requires a bad batch be discarded whole.
 */
export const parseSyncBatchBody = (value: unknown): SyncBatchBody | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== SYNC_BATCH_VERSION) return null;
  if (typeof raw.chatId !== 'string' || raw.chatId.length === 0) return null;
  if (typeof raw.since !== 'number' || !Number.isFinite(raw.since)) return null;
  if (typeof raw.until !== 'number' || !Number.isFinite(raw.until)) return null;
  if (typeof raw.complete !== 'boolean') return null;
  if (!Array.isArray(raw.messages)) return null;

  // A batch cannot claim to end before it starts.
  if (raw.until < raw.since) return null;

  const messages = raw.messages.filter(
    (message): message is ChatMessage =>
      Boolean(message)
      && typeof message === 'object'
      && typeof (message as ChatMessage).id === 'string'
      && typeof (message as ChatMessage).chatId === 'string',
  );
  // Any malformed member invalidates the batch rather than being dropped
  // silently: a batch that quietly loses messages is the failure this format
  // exists to make impossible.
  if (messages.length !== raw.messages.length) return null;

  return {
    v: SYNC_BATCH_VERSION,
    chatId: raw.chatId,
    since: raw.since,
    until: raw.until,
    complete: raw.complete,
    messages,
  };
};

/**
 * Checks a batch against what was actually asked for.
 *
 * Separate from `parseSyncBatchBody` because well-formed and honest are
 * different questions: a batch can parse perfectly and still be for the wrong
 * chat or a range nobody requested. Both must pass before anything is stored.
 */
export const isBatchForRequest = (
  body: SyncBatchBody,
  request: { chatId: string; sinceTimestamp: number },
): boolean =>
  body.chatId === request.chatId
  // A responder may serve from an EARLIER point than asked (harmless, just
  // redundant), but never a later one — that would silently skip the messages
  // between what was asked for and what was sent.
  && body.since <= request.sinceTimestamp
  && body.messages.every((message) => (message.createdAt ?? 0) > body.since)
  && body.messages.every((message) => message.chatId === body.chatId);

/** True when the requester should immediately ask for the remainder. */
export const needsContinuation = (body: SyncBatchBody): boolean =>
  !body.complete && body.messages.length > 0;
