/**
 * Behavioural tests for cross-device history reconciliation (doc 31 §8.1).
 *
 * These cover the decisions that are easy to get wrong and impossible to see in
 * a typecheck: the scope guard that stops a fresh device requesting full
 * history, the slack window that stops an in-flight message looking like a gap,
 * the "never answer your own request / never poach a claim" filtering, and the
 * claim-release path that stops a request sitting claimed-but-unserved.
 *
 * They do NOT prove the feature works on real devices — see doc 31 §8.4 for the
 * hardware protocol that would.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Snapshot = { key: string | null; val: () => unknown };
type ChildHandler = (snapshot: Snapshot) => void;

const rtdb = {
  set: vi.fn<(path: string, value: unknown) => Promise<void>>(async () => undefined),
  remove: vi.fn<(path: string) => Promise<void>>(async () => undefined),
  get: vi.fn<(path: string) => Promise<{ forEach: (cb: (s: Snapshot) => void) => void }>>(
    async () => ({ forEach: () => undefined }),
  ),
  runTransaction: vi.fn<
    (path: string, fn: (current: unknown) => unknown) => Promise<{
      committed: boolean;
      snapshot: { val: () => unknown };
    }>
  >(),
  onChildAdded: vi.fn<(path: string, handler: ChildHandler) => () => void>(
    () => () => undefined,
  ),
  onChildChanged: vi.fn<(path: string, handler: ChildHandler) => () => void>(
    () => () => undefined,
  ),
};

vi.mock('firebase/database', () => ({
  getDatabase: () => ({}),
  // The path is the only thing the assertions care about.
  ref: (_db: unknown, path: string) => path,
  set: (path: string, value: unknown) => rtdb.set(path, value),
  remove: (path: string) => rtdb.remove(path),
  get: (path: string) => rtdb.get(path),
  runTransaction: (path: string, fn: (current: unknown) => unknown) =>
    rtdb.runTransaction(path, fn),
  onChildAdded: (path: string, handler: ChildHandler) => rtdb.onChildAdded(path, handler),
  onChildChanged: (path: string, handler: ChildHandler) => rtdb.onChildChanged(path, handler),
}));

// syncGapService now delegates to the batch path, which imports the native
// crypto module. Mocked here rather than pulled in: this suite is about gap
// detection and claim handling, and a real import fails collection with
// "Cannot read properties of undefined (reading 'EventEmitter')" — the hazard
// CLAUDE.md documents.
const sendSyncBatch = vi.fn<() => Promise<number>>(async () => 0);
vi.mock('@/services/syncBatchService', () => ({
  sendSyncBatch: (...args: unknown[]) => sendSyncBatch(...(args as [])),
  subscribeToSyncBatches: vi.fn(() => () => undefined),
}));

const storage = {
  getChatMessages: vi.fn<(chatId: string) => Promise<unknown[]>>(async () => []),
  getLocalMessageStats: vi.fn<(chatId?: string) => Promise<unknown[]>>(async () => []),
};

vi.mock('@/services/localMessageStorage', () => ({
  getChatMessages: (chatId: string) => storage.getChatMessages(chatId),
  getLocalMessageStats: (chatId?: string) => storage.getLocalMessageStats(chatId),
}));

const queueGapFillMessage =
  vi.fn<(ownerUserId: string, message: { id: string }, isGroupChat: boolean) => Promise<boolean>>(
    async () => true,
  );
vi.mock('@/services/messageQueueService', () => ({
  queueGapFillMessage: (ownerUserId: string, message: { id: string }, isGroupChat: boolean) =>
    queueGapFillMessage(ownerUserId, message, isGroupChat),
}));

import {
  answerGapRequest,
  checkForGapsAndRequestFill,
  claimGapRequest,
  resetGapState,
  subscribeToGapRequests,
} from '../syncGapService';

const UID = 'user-1';
const OWN_DEVICE = 'device-a';
const CHAT = 'direct_user-1_user-2';

const stats = (count: number, latestTimestamp: number | null) => [
  { chatId: CHAT, count, latestTimestamp },
];

beforeEach(() => {
  vi.clearAllMocks();
  resetGapState();
  storage.getLocalMessageStats.mockResolvedValue([]);
  storage.getChatMessages.mockResolvedValue([]);
  rtdb.get.mockResolvedValue({ forEach: () => undefined });
  queueGapFillMessage.mockResolvedValue(true);
});

describe('gap detection', () => {
  it('requests a fill when the thread is ahead of local storage', async () => {
    storage.getLocalMessageStats.mockResolvedValue(stats(12, 1_000_000));

    await checkForGapsAndRequestFill(UID, OWN_DEVICE, [
      { chatId: CHAT, lastMessage: { createdAt: 5_000_000 } },
    ]);

    expect(rtdb.set).toHaveBeenCalledTimes(1);
    const [path, payload] = rtdb.set.mock.calls[0];
    const body = payload as Record<string, unknown>;
    expect(path).toBe(`syncGapRequests/${UID}/${CHAT}__${OWN_DEVICE}`);
    // The watermark is the local latest, so the responder sends strictly what
    // this device is missing.
    expect(body.sinceTimestamp).toBe(1_000_000);
    expect(body.requesterDeviceId).toBe(OWN_DEVICE);
    expect(body.claimedBy).toBeNull();
    // No message content may ever reach this path.
    expect(Object.keys(body).sort()).toEqual(
      ['chatId', 'claimedBy', 'createdAt', 'requesterDeviceId', 'sinceTimestamp'],
    );
  });

  it('DOES request a bounded backfill for a chat with no local messages', async () => {
    // doc 34 §0.1/§3.6. This case used to be skipped outright, which left a
    // reinstalled or restored device unable to raise a single request for any
    // chat — permanently, and with nothing shown to the user. It now asks, but
    // only for a bounded window rather than all history.
    storage.getLocalMessageStats.mockResolvedValue(stats(0, null));

    await checkForGapsAndRequestFill(UID, OWN_DEVICE, [
      { chatId: CHAT, lastMessage: { createdAt: Date.now() - 60_000 } },
    ]);

    expect(rtdb.set).toHaveBeenCalledTimes(1);
    const body = rtdb.set.mock.calls[0][1] as Record<string, unknown>;
    const since = body.sinceTimestamp as number;
    // Bounded, not zero. Asking from 0 is the unbounded request the original
    // guard existed to prevent.
    expect(since).toBeGreaterThan(0);
    const windowDays = (Date.now() - since) / (24 * 60 * 60 * 1000);
    expect(windowDays).toBeGreaterThan(29);
    expect(windowDays).toBeLessThan(32);
  });

  it('still ignores a chat whose newest message predates the backfill window', async () => {
    // Nothing recent enough to be worth asking for; the guard's intent survives.
    storage.getLocalMessageStats.mockResolvedValue(stats(0, null));

    await checkForGapsAndRequestFill(UID, OWN_DEVICE, [
      { chatId: CHAT, lastMessage: { createdAt: 5_000_000 } },
    ]);

    expect(rtdb.set).not.toHaveBeenCalled();
  });

  it('caps how many zero-history chats it asks about in one pass', async () => {
    // A device restored with fifty conversations must not ask for all fifty at
    // once — that is the bulk volume this path exists to avoid.
    storage.getLocalMessageStats.mockResolvedValue(stats(0, null));
    const recent = Date.now() - 60_000;

    await checkForGapsAndRequestFill(
      UID,
      OWN_DEVICE,
      Array.from({ length: 10 }, (_, i) => ({
        chatId: `chat-${i}`,
        lastMessage: { createdAt: recent - i },
      })),
    );

    expect(rtdb.set).toHaveBeenCalledTimes(3);
  });

  it('asks about the newest conversations first', async () => {
    // The per-pass budget should be spent where the user is most likely to look.
    storage.getLocalMessageStats.mockResolvedValue(stats(0, null));
    const now = Date.now();

    await checkForGapsAndRequestFill(UID, OWN_DEVICE, [
      { chatId: 'oldest', lastMessage: { createdAt: now - 500_000 } },
      { chatId: 'newest', lastMessage: { createdAt: now - 1_000 } },
      { chatId: 'middle', lastMessage: { createdAt: now - 100_000 } },
    ]);

    const requested = rtdb.set.mock.calls.map(
      ([, payload]) => (payload as Record<string, unknown>).chatId,
    );
    expect(requested[0]).toBe('newest');
  });

  it('does not re-raise the same zero-history request on the next pass', async () => {
    // The window is derived from `Date.now()`, so without bucketing it would
    // differ on every call, never match its own watermark, and rewrite the
    // request on every detection pass — the exact RTDB write storm this path
    // must avoid.
    storage.getLocalMessageStats.mockResolvedValue(stats(0, null));
    const threads = [{ chatId: CHAT, lastMessage: { createdAt: Date.now() - 60_000 } }];

    await checkForGapsAndRequestFill(UID, OWN_DEVICE, threads);
    await checkForGapsAndRequestFill(UID, OWN_DEVICE, threads);

    expect(rtdb.set).toHaveBeenCalledTimes(1);
  });

  it('tolerates a message still in flight rather than calling it a gap', async () => {
    storage.getLocalMessageStats.mockResolvedValue(stats(12, 1_000_000));

    await checkForGapsAndRequestFill(UID, OWN_DEVICE, [
      { chatId: CHAT, lastMessage: { createdAt: 1_000_000 + 5_000 } },
    ]);

    expect(rtdb.set).not.toHaveBeenCalled();
  });

  it('does not rewrite an identical request (which would reset a live claim)', async () => {
    storage.getLocalMessageStats.mockResolvedValue(stats(12, 1_000_000));
    const threads = [{ chatId: CHAT, lastMessage: { createdAt: 5_000_000 } }];

    await checkForGapsAndRequestFill(UID, OWN_DEVICE, threads);
    await checkForGapsAndRequestFill(UID, OWN_DEVICE, threads);

    expect(rtdb.set).toHaveBeenCalledTimes(1);
  });

  it('clears its request once it has caught up', async () => {
    storage.getLocalMessageStats.mockResolvedValue(stats(12, 1_000_000));
    await checkForGapsAndRequestFill(UID, OWN_DEVICE, [
      { chatId: CHAT, lastMessage: { createdAt: 5_000_000 } },
    ]);

    storage.getLocalMessageStats.mockResolvedValue(stats(40, 5_000_000));
    await checkForGapsAndRequestFill(UID, OWN_DEVICE, [
      { chatId: CHAT, lastMessage: { createdAt: 5_000_000 } },
    ]);

    expect(rtdb.remove).toHaveBeenCalledWith(`syncGapRequests/${UID}/${CHAT}__${OWN_DEVICE}`);
  });

  it('re-asks after the watermark advances but a gap remains', async () => {
    storage.getLocalMessageStats.mockResolvedValue(stats(12, 1_000_000));
    await checkForGapsAndRequestFill(UID, OWN_DEVICE, [
      { chatId: CHAT, lastMessage: { createdAt: 9_000_000 } },
    ]);

    // A partial replay landed: local advanced, but the thread is still ahead.
    storage.getLocalMessageStats.mockResolvedValue(stats(30, 4_000_000));
    await checkForGapsAndRequestFill(UID, OWN_DEVICE, [
      { chatId: CHAT, lastMessage: { createdAt: 9_000_000 } },
    ]);

    expect(rtdb.set).toHaveBeenCalledTimes(2);
    expect((rtdb.set.mock.calls[1][1] as Record<string, unknown>).sinceTimestamp)
      .toBe(4_000_000);
  });
});

describe('request routing', () => {
  const capture = () => {
    const seen: unknown[] = [];
    subscribeToGapRequests(UID, OWN_DEVICE, (request) => seen.push(request));
    const handler = rtdb.onChildAdded.mock.calls[0][1];
    return { seen, handler };
  };

  const snapshot = (key: string, value: Record<string, unknown> | null): Snapshot => ({
    key,
    val: () => value,
  });

  it('ignores a request raised by this same device', () => {
    const { seen, handler } = capture();
    handler(snapshot('req-1', {
      chatId: CHAT,
      sinceTimestamp: 1,
      requesterDeviceId: OWN_DEVICE,
    }));
    expect(seen).toHaveLength(0);
  });

  it('ignores a request another device already claimed', () => {
    const { seen, handler } = capture();
    handler(snapshot('req-1', {
      chatId: CHAT,
      sinceTimestamp: 1,
      requesterDeviceId: 'device-b',
      claimedBy: 'device-c',
    }));
    expect(seen).toHaveLength(0);
  });

  it('accepts an unclaimed request from another device, and resumes its own claim', () => {
    const { seen, handler } = capture();
    handler(snapshot('req-1', {
      chatId: CHAT,
      sinceTimestamp: 1,
      requesterDeviceId: 'device-b',
    }));
    handler(snapshot('req-2', {
      chatId: CHAT,
      sinceTimestamp: 2,
      requesterDeviceId: 'device-b',
      claimedBy: OWN_DEVICE,
    }));
    expect(seen).toHaveLength(2);
  });

  it('drops a malformed request instead of throwing inside the listener', () => {
    const { seen, handler } = capture();
    handler(snapshot('req-1', { chatId: CHAT }));
    handler(snapshot('req-2', null));
    expect(seen).toHaveLength(0);
  });
});

describe('claiming', () => {
  it('claims only when unowned', async () => {
    rtdb.runTransaction.mockImplementation(async (_path, fn) => {
      const next = fn(null);
      return { committed: true, snapshot: { val: () => next } };
    });
    await expect(claimGapRequest(UID, 'req-1', OWN_DEVICE)).resolves.toBe(true);

    rtdb.runTransaction.mockImplementation(async (_path, fn) => {
      const next = fn('device-c');
      // An aborted transaction leaves the existing value in place.
      return { committed: next !== undefined, snapshot: { val: () => 'device-c' } };
    });
    await expect(claimGapRequest(UID, 'req-1', OWN_DEVICE)).resolves.toBe(false);
  });
});

describe('answering', () => {
  const request = { requestId: 'req-1', chatId: CHAT, sinceTimestamp: 1_000, requesterDeviceId: 'device-b' };

  it('replays only messages newer than the requester, oldest first', async () => {
    storage.getChatMessages.mockResolvedValue([
      { id: 'm3', createdAt: 3_000 },
      { id: 'm1', createdAt: 500 },
      { id: 'm2', createdAt: 2_000 },
    ]);

    await expect(answerGapRequest(UID, request, false)).resolves.toBe(2);

    expect(queueGapFillMessage).toHaveBeenCalledTimes(2);
    expect(queueGapFillMessage.mock.calls[0][1]).toMatchObject({ id: 'm2' });
    expect(queueGapFillMessage.mock.calls[1][1]).toMatchObject({ id: 'm3' });
  });

  it('releases the claim when it has nothing newer to contribute', async () => {
    storage.getChatMessages.mockResolvedValue([{ id: 'm1', createdAt: 500 }]);

    await expect(answerGapRequest(UID, request, false)).resolves.toBe(0);
    expect(queueGapFillMessage).not.toHaveBeenCalled();
    expect(rtdb.set).toHaveBeenCalledWith(
      `syncGapRequests/${UID}/req-1/claimedBy`,
      null,
    );
  });

  it('releases the claim when every replay was skipped (target has no keys yet)', async () => {
    storage.getChatMessages.mockResolvedValue([{ id: 'm2', createdAt: 2_000 }]);
    queueGapFillMessage.mockResolvedValue(false);

    await expect(answerGapRequest(UID, request, false)).resolves.toBe(0);
    expect(rtdb.set).toHaveBeenCalledWith(
      `syncGapRequests/${UID}/req-1/claimedBy`,
      null,
    );
  });

  it('keeps going when one message fails to replay', async () => {
    storage.getChatMessages.mockResolvedValue([
      { id: 'm2', createdAt: 2_000 },
      { id: 'm3', createdAt: 3_000 },
    ]);
    queueGapFillMessage
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(true);

    await expect(answerGapRequest(UID, request, false)).resolves.toBe(1);
  });
});

describe('claim retry storm', () => {
  it('does not re-dispatch the same request on an optimistic-write echo', async () => {
    // claimGapRequest runs a TRANSACTION, which writes optimistically before
    // the server answers — firing onChildChanged straight back into this
    // handler. The "resumed attempt" allowance let that feed itself, and the
    // server's rejection fired onChildChanged again. Observed on a Pixel:
    // 11,233 attempts, 99.96% of every JS log line the app emitted.
    const seen: string[] = [];
    subscribeToGapRequests(UID, OWN_DEVICE, (request) => { seen.push(request.requestId); });
    const handler = rtdb.onChildAdded.mock.calls.at(-1)?.[1] as (s: Snapshot) => void;

    const node = {
      key: 'chat-x__other-device',
      val: () => ({
        chatId: 'chat-x',
        sinceTimestamp: 100,
        requesterDeviceId: 'other-device',
        createdAt: 1,
      }),
    };
    handler(node);
    // The echo: same node, now optimistically stamped with OUR claim.
    for (let i = 0; i < 50; i += 1) {
      handler({
        key: 'chat-x__other-device',
        val: () => ({
          chatId: 'chat-x',
          sinceTimestamp: 100,
          requesterDeviceId: 'other-device',
          createdAt: 1,
          claimedBy: OWN_DEVICE,
        }),
      });
    }

    expect(seen).toHaveLength(1);
  });

  it('still serves a DIFFERENT request while one is cooling down', async () => {
    // The brake must be per request, or one stuck gap would block every other
    // conversation from ever being served.
    const seen: string[] = [];
    subscribeToGapRequests(UID, OWN_DEVICE, (request) => { seen.push(request.requestId); });
    const handler = rtdb.onChildAdded.mock.calls.at(-1)?.[1] as (s: Snapshot) => void;

    for (const chat of ['chat-a', 'chat-b']) {
      handler({
        key: `${chat}__other-device`,
        val: () => ({
          chatId: chat,
          sinceTimestamp: 100,
          requesterDeviceId: 'other-device',
          createdAt: 1,
        }),
      });
    }

    expect(seen).toHaveLength(2);
  });
});
