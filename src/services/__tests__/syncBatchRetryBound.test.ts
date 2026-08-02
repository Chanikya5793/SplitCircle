/**
 * A sync batch that can never be opened must not be retried forever.
 *
 * `subscribeToSyncBatches` consumes a batch on every outcome it can reason
 * about, and its catch deliberately does NOT — a transient failure (crypto
 * busy, storage full) should be retried, and a batch is real history the user
 * would otherwise lose.
 *
 * The problem is that a PERMANENT failure takes the same path. Before this
 * bound, an unopenable batch stayed in RTDB and re-failed on every reconnect and
 * every app restart, forever: that chat's gap-fill was permanently blocked and
 * the node accumulated, against CLAUDE.md's "never let RTDB accumulate" rule.
 * That is not hypothetical — doc 35 found exactly such a batch, produced by the
 * associated-data derivation splitting a chatId on the wrong `__`.
 *
 * These tests pin both halves: retried while there is hope, consumed once there
 * is not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectLogged } from '@/testing/expectLogged';

type ChildHandler = (snapshot: { key: string | null; val: () => unknown }) => void;

const rtdb = vi.hoisted(() => ({
  set: vi.fn<(path: string, value: unknown) => Promise<void>>(async () => undefined),
  remove: vi.fn<(path: string) => Promise<void>>(async () => undefined),
  handlers: [] as ChildHandler[],
}));

vi.mock('firebase/database', () => ({
  getDatabase: () => ({}),
  ref: (_db: unknown, path: string) => path,
  set: (path: string, value: unknown) => rtdb.set(path, value),
  remove: (path: string) => rtdb.remove(path),
  onChildAdded: (_path: string, handler: ChildHandler) => {
    rtdb.handlers.push(handler);
    return () => undefined;
  },
}));

const crypto = vi.hoisted(() => ({
  isCryptoAvailable: vi.fn(() => true),
  openWithIdentity: vi.fn(async () => 'plaintext'),
  sealToIdentity: vi.fn(async () => 'sealed'),
  signWithIdentity: vi.fn(async () => 'sig'),
  verifyWithIdentity: vi.fn(async () => true),
}));
vi.mock('../../../modules/splitcircle-crypto', () => crypto);

// Both responders, so the per-key counting test exercises the RETRY branch
// rather than being consumed early by an unknown-device rejection.
vi.mock('@/services/signalCryptoService', () => ({
  listSignalDevices: vi.fn(async () => [
    { deviceId: 'responder-1', identityKey: 'key' },
    { deviceId: 'responder-2', identityKey: 'key' },
  ]),
}));

import { __resetSyncBatchState, subscribeToSyncBatches } from '../syncBatchService';

/** A well-formed sealed node; only `openWithIdentity` decides pass or fail. */
const sealedBatch = () => ({
  key: 'group_abc__responder-1',
  val: () => ({
    v: 1,
    responderDeviceId: 'responder-1',
    b: 'sealed-bytes',
    sig: 'signature',
    createdAt: 1,
  }),
});

const deliver = async () => {
  for (const handler of rtdb.handlers) handler(sealedBatch());
  // The handler body is an un-awaited async IIFE.
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  vi.clearAllMocks();
  rtdb.handlers.length = 0;
  __resetSyncBatchState();
  crypto.isCryptoAvailable.mockReturnValue(true);
  crypto.verifyWithIdentity.mockResolvedValue(true);
});

describe('unopenable sync batch', () => {
  it('is retried at first, rather than discarded on one failure', async () => {
    crypto.openWithIdentity.mockRejectedValue(new Error('hpke auth failure'));
    subscribeToSyncBatches('user-1', 'device-a', () => null, async () => undefined);

    await expectLogged('Sync batch processing failed', deliver);

    // Kept: a transient failure deserves another go, and a batch is history the
    // user would otherwise never get back.
    expect(rtdb.remove).not.toHaveBeenCalled();
  });

  it('is consumed once it has failed enough times to be hopeless', async () => {
    crypto.openWithIdentity.mockRejectedValue(new Error('hpke auth failure'));
    subscribeToSyncBatches('user-1', 'device-a', () => null, async () => undefined);

    await expectLogged('attempt 1/3', deliver);
    await expectLogged('attempt 2/3', deliver);
    await expectLogged('attempt 3/3', deliver);

    // Otherwise this node blocks that chat's gap-fill on every reconnect,
    // forever, and never leaves RTDB.
    expect(rtdb.remove).toHaveBeenCalled();
  });

  it('counts per batch, so one poisoned node cannot exhaust another\'s budget', async () => {
    crypto.openWithIdentity.mockRejectedValue(new Error('hpke auth failure'));
    subscribeToSyncBatches('user-1', 'device-a', () => null, async () => undefined);

    const other = {
      key: 'group_xyz__responder-2',
      val: () => ({
        v: 1, responderDeviceId: 'responder-2', b: 'b', sig: 's', createdAt: 1,
      }),
    };
    await expectLogged('attempt 1/3', deliver);
    await expectLogged('attempt 1/3', async () => {
      for (const handler of rtdb.handlers) handler(other);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The second batch is on its FIRST attempt, not the first batch's second.
    expect(rtdb.remove).not.toHaveBeenCalled();
  });
});
