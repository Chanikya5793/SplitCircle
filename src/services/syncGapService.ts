/**
 * Repeatable cross-device history reconciliation (doc 31 §8.1).
 *
 * WHY THIS EXISTS. Live per-device sync is a relay, not a store: a message is
 * fanned out to `messageQueueDevices/{uid}/{deviceId}/{id}` and deleted as soon
 * as that device consumes it. RTDB replays the backlog to a listener that
 * reconnects, so a device that is briefly offline heals for free — but
 * `cleanup.ts` reaps that queue after seven days, and the ONLY backfill
 * mechanism in the app (the Phase 6 history handoff, `deviceSyncCoordinator.ts`)
 * is one-shot per device LIFETIME, gated behind AsyncStorage flags that never
 * fire again once set. It bootstraps a brand-new pairing and nothing else.
 *
 * So before this file, any message a linked device missed for any reason —
 * offline past the reaper, a failed fan-out, a dead Signal session — was lost
 * permanently, with no detection, no retry, and nothing shown to the user. This
 * closes that hole: a device notices it is behind, says so, and any other device
 * of the same account that has the missing messages replays them.
 *
 * DESIGN NOTES worth keeping.
 *
 * - Detection needs no new listener. Every device already subscribes to its
 *   Firestore chat threads, and each thread carries `lastMessage.createdAt` —
 *   a plaintext timestamp (§3.3 scopes timestamps as plaintext-allowed) that
 *   updates whenever anyone sends into that chat. Comparing it against
 *   `getLocalMessageStats` is the whole "am I behind" check.
 * - Replay reuses the existing encrypt-and-fan-out path wholesale
 *   (`queueGapFillMessage` → `fanOutQueuedMessage` → `listenForMessagesOnDevice`).
 *   No new delivery mechanism and no new crypto — this repo's recurring
 *   regressions have come from inventing parallel surfaces.
 * - NO MESSAGE CONTENT is written to the coordination path. It carries a chatId,
 *   a number, and device ids. The messages themselves travel the normal
 *   end-to-end encrypted route.
 * - The responder never deletes the request. It cannot know whether it had the
 *   whole gap or only part of it; only the requester's own local state can say
 *   that. This is what makes the mechanism converge with N devices and no
 *   central authority — several devices can each contribute part of a gap
 *   across successive passes.
 */

import {
  get,
  getDatabase,
  onChildAdded,
  onChildChanged,
  ref,
  remove,
  runTransaction,
  set,
  type DataSnapshot,
} from 'firebase/database';
import { getChatMessages, getLocalMessageStats } from '@/services/localMessageStorage';
import { queueGapFillMessage } from '@/services/messageQueueService';
import { sendSyncBatch } from '@/services/syncBatchService';

const rtdb = getDatabase();

const GAP_ROOT = 'syncGapRequests';

/**
 * Batched gap responses (doc 34 §3.1), OFF by default.
 *
 * Changes what a responder writes and what a requester must understand, so both
 * sides need the code before either uses it — the same staged-rollout rule as
 * doc 33 §10.3. A responder with this off keeps replaying per message, which
 * every existing device already understands.
 */
const SYNC_BATCH_ENABLED = ['1', 'true'].includes(
  (process.env.EXPO_PUBLIC_ENABLE_SYNC_BATCH ?? '').trim().toLowerCase(),
);

/**
 * Tolerance before calling a chat "behind". A message in flight — sent but not
 * yet fanned out and consumed here — legitimately puts the thread's
 * lastMessage ahead of local storage for a moment, and asking for a gap-fill
 * every time that happens would be pure noise.
 */
const GAP_SLACK_MS = 30_000;

/**
 * Cap on one replay burst. The reaper and RTDB itself are tuned for small
 * ephemeral entries (CLAUDE.md: never let RTDB accumulate), so dumping years of
 * history in one go is exactly the volume pattern to avoid. Truncating is safe
 * and self-resuming rather than lossy: serving the OLDEST messages first
 * advances the requester's local watermark, so its next detection pass asks for
 * the remainder and the gap closes in chunks.
 */
const MAX_REPLAY_PER_REQUEST = 200;

/**
 * How far back a chat with NO local messages asks for (doc 34 §3.6).
 *
 * The SCOPE GUARD below used to skip these chats outright, which was right
 * about the danger and wrong about the remedy: it left "should have history,
 * has none" — a reinstall, an iCloud restore, a handoff that failed — covered
 * by NOTHING, because the history handoff it defers to is one-shot per device
 * lifetime. Diagnosed from production on 2026-07-31: a reinstalled Pixel could
 * not raise a single gap request for any chat, permanently and silently.
 *
 * A BOUND is what makes asking safe. Recent history is what a returning device
 * actually needs to be usable; the rest is pagination's job.
 */
const ZERO_HISTORY_BACKFILL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How many zero-history chats may be requested in ONE detection pass.
 *
 * The other half of the guard's original concern. A device restored with fifty
 * conversations must not ask for all fifty at once — that is the bulk volume
 * this path exists to avoid. Requests resume on the next pass, so coverage is
 * gradual instead of a thundering herd, and the newest chats come first because
 * that is what the user opens.
 */
const MAX_ZERO_HISTORY_REQUESTS_PER_PASS = 3;

/** Bucket the backfill window to this, so repeat passes compute the same value. */
const BACKFILL_BUCKET_MS = 60 * 60 * 1000;

export interface GapRequest {
  requestId: string;
  chatId: string;
  sinceTimestamp: number;
  requesterDeviceId: string;
}

interface ThreadLike {
  chatId: string;
  lastMessage?: { createdAt?: number } | undefined;
}

/**
 * RTDB keys cannot contain `.`, `$`, `#`, `[`, `]`, `/` or control characters.
 * Every chatId this app mints is safe (a uuid, or `direct_<uid>_<uid>`), but a
 * malformed one must skip reconciliation rather than throw inside a listener
 * and take the detection pass down with it.
 */
// RTDB rejects these outright in a key: . $ # [ ] / and any control char.
// eslint-disable-next-line no-control-regex
const RTDB_ILLEGAL_KEY_CHARS = /[.$#[\]/\u0000-\u001F\u007F]/;

const isRtdbKeySafe = (value: string): boolean =>
  value.length > 0 && !RTDB_ILLEGAL_KEY_CHARS.test(value);

const buildRequestId = (chatId: string, deviceId: string): string => `${chatId}__${deviceId}`;

/**
 * Watermark this device last asked about, per chat. Prevents rewriting an
 * identical request on every threads snapshot — and a rewrite is not harmless,
 * because `set` would reset `claimedBy` and let a second device redundantly
 * serve a request already being served.
 */
const requestedWatermarks = new Map<string, number>();
/**
 * When this device first raised the CURRENT request for a chat. Drives the
 * "stuck" signal in diagnostics — an unanswered request is only interesting
 * once it has been outstanding a while.
 */
const requestFirstSeenAt = new Map<string, number>();
let seededForUserId: string | null = null;
let checking = false;

/**
 * Rebuilds `requestedWatermarks` from RTDB once per session.
 *
 * Without it, a device that restarts forgets its outstanding requests and never
 * clears them once it catches up, leaving nodes that other devices would
 * pointlessly serve. Cheap: one read of this account's own request list.
 */
const seedOutstanding = async (userId: string, ownDeviceId: string): Promise<void> => {
  if (seededForUserId === userId) return;
  seededForUserId = userId;
  try {
    const snapshot = await get(ref(rtdb, `${GAP_ROOT}/${userId}`));
    snapshot.forEach((child) => {
      const raw = child.val();
      if (!raw || typeof raw !== 'object') return;
      if (raw.requesterDeviceId !== ownDeviceId) return;
      if (typeof raw.chatId !== 'string' || typeof raw.sinceTimestamp !== 'number') return;
      requestedWatermarks.set(raw.chatId, raw.sinceTimestamp);
    });
  } catch (error) {
    // Non-fatal: a failed seed only costs a redundant write later.
    console.warn('Gap-request seed failed', error);
  }
};

export const requestGapFill = async (
  ownerUserId: string,
  chatId: string,
  sinceTimestamp: number,
  requesterDeviceId: string,
): Promise<void> => {
  await set(ref(rtdb, `${GAP_ROOT}/${ownerUserId}/${buildRequestId(chatId, requesterDeviceId)}`), {
    chatId,
    sinceTimestamp,
    requesterDeviceId,
    createdAt: Date.now(),
    claimedBy: null,
  });
};

export const clearGapRequest = async (
  ownerUserId: string,
  chatId: string,
  requesterDeviceId: string,
): Promise<void> => {
  await remove(ref(rtdb, `${GAP_ROOT}/${ownerUserId}/${buildRequestId(chatId, requesterDeviceId)}`));
};

/**
 * Exactly one device may serve a request. Same shape as the `answeredBy`
 * transaction that resolves the multi-device call-answer race (§3.9) —
 * a plain read-then-write would let every online device serve the same gap.
 */
export const claimGapRequest = async (
  ownerUserId: string,
  requestId: string,
  ownDeviceId: string,
): Promise<boolean> => {
  try {
    const result = await runTransaction(
      ref(rtdb, `${GAP_ROOT}/${ownerUserId}/${requestId}/claimedBy`),
      (current: unknown) => {
        if (current === null || current === undefined) return ownDeviceId;
        if (current === ownDeviceId) return current;
        return undefined; // Someone else owns it — abort.
      },
    );
    return result.committed && result.snapshot.val() === ownDeviceId;
  } catch (error) {
    console.warn('Gap-request claim failed', error);
    return false;
  }
};

/**
 * Hands a claim back. A device that claimed a request and then found it had
 * nothing to contribute must not leave it marked as being handled, or the gap
 * stays open while looking attended-to.
 */
export const releaseGapRequestClaim = async (
  ownerUserId: string,
  requestId: string,
): Promise<void> => {
  try {
    await set(ref(rtdb, `${GAP_ROOT}/${ownerUserId}/${requestId}/claimedBy`), null);
  } catch (error) {
    console.warn('Gap-request release failed', error);
  }
};

export const subscribeToGapRequests = (
  ownerUserId: string,
  ownDeviceId: string,
  onRequest: (request: GapRequest) => void,
): (() => void) => {
  const rootRef = ref(rtdb, `${GAP_ROOT}/${ownerUserId}`);

  const handle = (snapshot: DataSnapshot): void => {
    const requestId = snapshot.key;
    if (!requestId) return;

    const raw = snapshot.val() as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return;

    const { chatId, sinceTimestamp, requesterDeviceId, claimedBy } = raw;
    if (
      typeof chatId !== 'string' ||
      typeof requesterDeviceId !== 'string' ||
      typeof sinceTimestamp !== 'number'
    ) {
      return;
    }

    // Never answer our own request, and never poach one another device already
    // claimed. Re-entering our OWN claim is fine — that is a resumed attempt.
    if (requesterDeviceId === ownDeviceId) return;
    if (typeof claimedBy === 'string' && claimedBy && claimedBy !== ownDeviceId) return;

    onRequest({ requestId, chatId, sinceTimestamp, requesterDeviceId });
  };

  const onError = (error: Error): void => {
    console.warn('Gap-request listener cancelled', error);
  };

  // Both events: `added` catches requests already present when we come online
  // (the common case — the requester wrote it while we were closed), `changed`
  // catches a released claim or an advanced watermark on an existing node.
  const unsubscribeAdded = onChildAdded(rootRef, handle, onError);
  const unsubscribeChanged = onChildChanged(rootRef, handle, onError);

  return () => {
    unsubscribeAdded();
    unsubscribeChanged();
  };
};

/**
 * Serves a claimed request from this device's own local history.
 *
 * Returns how many messages were queued. Zero means this device had nothing
 * newer than the requester — it releases the claim so a better-informed device
 * can take it instead of the request sitting claimed but unserved.
 */
export const answerGapRequest = async (
  ownerUserId: string,
  request: GapRequest,
  isGroupChat: boolean,
  responderDeviceId?: string,
): Promise<number> => {
  const local = await getChatMessages(request.chatId);
  const missing = local
    .filter((message) => (message.createdAt ?? 0) > request.sinceTimestamp)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .slice(0, MAX_REPLAY_PER_REQUEST);

  if (missing.length === 0) {
    await releaseGapRequestClaim(ownerUserId, request.requestId);
    return 0;
  }

  // BATCHED PATH (doc 34 §3.1), preferred. One sealed payload replaces M×D
  // encryptions, writes and function invocations. Falls back rather than fails:
  // a responder whose batch cannot be built (no crypto, requester has published
  // no identity key yet) must still be able to serve the gap the old way, or
  // enabling batching would make sync worse for exactly the devices that are
  // already struggling.
  if (SYNC_BATCH_ENABLED && responderDeviceId) {
    try {
      const sent = await sendSyncBatch(
        ownerUserId,
        responderDeviceId,
        { ...request, requesterDeviceId: request.requesterDeviceId },
        missing,
      );
      if (sent > 0) {
        console.log(`Gap-fill: sent ${sent} messages as one batch for ${request.chatId}`);
        return sent;
      }
    } catch (error) {
      console.warn('Gap-fill batch failed, falling back to per-message replay', error);
    }
  }

  let queued = 0;
  for (const message of missing) {
    try {
      if (await queueGapFillMessage(ownerUserId, message, isGroupChat)) queued++;
    } catch (error) {
      // One message failing must not abandon the rest of the gap.
      console.warn('Gap-fill replay failed for message', message.id, error);
    }
  }

  // If we could not actually queue anything (e.g. the requesting device has no
  // published Signal keys yet) the request is untouched work, not done work.
  if (queued === 0) {
    await releaseGapRequestClaim(ownerUserId, request.requestId);
  }

  console.log(`Gap-fill: replayed ${queued}/${missing.length} messages for ${request.chatId}`);
  return queued;
};

/**
 * Detection pass. Compares each thread's live Firestore watermark against this
 * device's local storage and raises or clears a request.
 *
 * SCOPE GUARD — only chats this device already has messages for. A chat with
 * zero local messages is not "a gap", it is a chat this device has never loaded,
 * and backfilling those is the history handoff's and pagination's job. Without
 * this, a freshly paired companion would request full history for every chat it
 * has never opened at once, which is precisely the bulk volume this path must
 * not carry.
 */
export const checkForGapsAndRequestFill = async (
  userId: string,
  ownDeviceId: string,
  threads: ThreadLike[],
): Promise<void> => {
  if (checking) return;
  checking = true;
  try {
    await seedOutstanding(userId, ownDeviceId);

    // Newest conversations first, so a restored device's limited per-pass
    // budget is spent on the chats its owner is most likely to open.
    const ordered = [...threads].sort(
      (a, b) => (b.lastMessage?.createdAt ?? 0) - (a.lastMessage?.createdAt ?? 0),
    );
    let zeroHistoryRequests = 0;

    for (const thread of ordered) {
      const chatId = thread.chatId;
      if (!chatId || !isRtdbKeySafe(chatId)) continue;

      const remoteLatest = thread.lastMessage?.createdAt;
      if (typeof remoteLatest !== 'number') continue;

      const [stats] = await getLocalMessageStats(chatId);
      const localCount = stats?.count ?? 0;

      // ZERO LOCAL MESSAGES — see SCOPE GUARD above. Previously skipped
      // outright, which permanently stranded any device that should have
      // history and has none (doc 34 §0.1). Now asks, but BOUNDED in two
      // directions: a fixed window back, and a few chats per pass.
      if (localCount === 0) {
        if (zeroHistoryRequests >= MAX_ZERO_HISTORY_REQUESTS_PER_PASS) continue;
        // QUANTIZED to the hour. A raw `Date.now() - window` differs on every
        // call, so the watermark check below could never match its own previous
        // value and this would re-request on every single detection pass —
        // precisely the RTDB write storm the SCOPE GUARD exists to prevent.
        // Bucketing makes the request identical within the hour, and lets it
        // legitimately retry after one, which is the behaviour we want for a
        // request nobody has answered yet.
        const since = Math.floor(
          (Date.now() - ZERO_HISTORY_BACKFILL_MS) / BACKFILL_BUCKET_MS,
        ) * BACKFILL_BUCKET_MS;
        // Nothing recent enough to be worth asking for.
        if (remoteLatest <= since) continue;
        // Keyed by the window, not by 0: two passes days apart compute
        // different windows, and without this the second would look like a
        // duplicate of the first and never be sent.
        if (requestedWatermarks.get(chatId) === since) continue;
        try {
          await requestGapFill(userId, chatId, since, ownDeviceId);
          requestedWatermarks.set(chatId, since);
          if (!requestFirstSeenAt.has(chatId)) requestFirstSeenAt.set(chatId, Date.now());
          zeroHistoryRequests += 1;
        } catch (error) {
          console.warn('Zero-history backfill request failed', chatId, error);
        }
        continue;
      }

      const localLatest = stats?.latestTimestamp ?? 0;

      if (remoteLatest > localLatest + GAP_SLACK_MS) {
        if (requestedWatermarks.get(chatId) === localLatest) continue;
        try {
          await requestGapFill(userId, chatId, localLatest, ownDeviceId);
          requestedWatermarks.set(chatId, localLatest);
          if (!requestFirstSeenAt.has(chatId)) requestFirstSeenAt.set(chatId, Date.now());
        } catch (error) {
          console.warn('Gap-fill request failed', chatId, error);
        }
      } else if (requestedWatermarks.has(chatId)) {
        try {
          await clearGapRequest(userId, chatId, ownDeviceId);
          requestedWatermarks.delete(chatId);
          requestFirstSeenAt.delete(chatId);
        } catch (error) {
          console.warn('Gap-fill clear failed', chatId, error);
        }
      }
    }
  } finally {
    checking = false;
  }
};

export interface SyncGapStatus {
  chatId: string;
  /** What this device has asked to be filled in from. */
  sinceTimestamp: number;
  /** When this device first asked, or undefined if raised before this launch. */
  requestedAt?: number;
}

/**
 * Outstanding gap requests THIS device has raised (doc 34 §3.5).
 *
 * Exists because a request nobody can answer currently expires into silence at
 * the seven-day reaper, and looks identical to being fully synced. That is the
 * fourth silent-failure path this project has shipped (doc 32 §10.1, §10.3,
 * doc 34 §0.2), and the only reliable fix is to make the state observable.
 *
 * Read-only and synchronous: this must be safe to call from a render.
 */
export const getOutstandingSyncGaps = (): SyncGapStatus[] =>
  [...requestedWatermarks.entries()].map(([chatId, sinceTimestamp]) => ({
    chatId,
    sinceTimestamp,
    requestedAt: requestFirstSeenAt.get(chatId),
  }));

/** Drops in-memory state so a signed-out/revoked device starts clean. */
export const resetGapState = (): void => {
  requestFirstSeenAt.clear();
  requestedWatermarks.clear();
  seededForUserId = null;
};
