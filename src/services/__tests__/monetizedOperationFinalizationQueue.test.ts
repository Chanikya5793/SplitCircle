import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __clearAsyncStorageStore } from './mocks/async-storage';

const mocks = vi.hoisted(() => ({
  online: false,
  authUid: 'owner-a' as string | null,
  finalize: vi.fn(),
}));

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    fetch: vi.fn(async () => ({
      isConnected: mocks.online,
      isInternetReachable: mocks.online,
    })),
    addEventListener: vi.fn(() => () => undefined),
  },
}));

vi.mock('@/firebase', () => ({
  auth: {
    get currentUser() {
      return mocks.authUid ? { uid: mocks.authUid } : null;
    },
  },
}));

vi.mock('../monetizationService', () => ({
  finalizeMonetizedOperation: mocks.finalize,
}));

import {
  __resetMonetizedOperationFinalizationQueueForTests,
  flushMonetizedOperationFinalizations,
  queueMonetizedOperationFinalization,
  runWithMonetizedOperationFinalization,
} from '../monetizedOperationFinalizationQueue';

const input = (suffix: number, outcome: 'completed' | 'failed' = 'completed') => ({
  operationId: `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`,
  authorizationId: suffix.toString(16).padStart(64, '0'),
  outcome,
});

describe('monetized operation finalization queue', () => {
  beforeEach(async () => {
    __clearAsyncStorageStore();
    await __resetMonetizedOperationFinalizationQueueForTests();
    mocks.online = false;
    mocks.authUid = 'owner-a';
    mocks.finalize.mockReset();
  });

  it('persists offline and deduplicates by authorization id', async () => {
    await queueMonetizedOperationFinalization('owner-a', input(1));
    await queueMonetizedOperationFinalization('owner-a', input(1));
    mocks.online = true;
    mocks.finalize.mockResolvedValue({ accepted: true });

    expect(await flushMonetizedOperationFinalizations('owner-a', mocks.finalize)).toBe(1);
    expect(mocks.finalize).toHaveBeenCalledTimes(1);
    expect(mocks.finalize).toHaveBeenCalledWith(input(1));
  });

  it('never finalizes another signed-in account\'s reservation', async () => {
    await queueMonetizedOperationFinalization('owner-a', input(2));
    mocks.online = true;
    mocks.authUid = 'owner-b';

    expect(await flushMonetizedOperationFinalizations('owner-a', mocks.finalize)).toBe(0);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it('retains a transient failure for the next reconnect', async () => {
    await queueMonetizedOperationFinalization('owner-a', input(3));
    mocks.online = true;
    mocks.finalize.mockRejectedValueOnce(new Error('network'));
    expect(await flushMonetizedOperationFinalizations('owner-a', mocks.finalize)).toBe(0);

    mocks.finalize.mockResolvedValueOnce({ accepted: true });
    expect(await flushMonetizedOperationFinalizations('owner-a', mocks.finalize)).toBe(1);
    expect(mocks.finalize).toHaveBeenCalledTimes(2);
  });

  it('upgrades a failed outcome when the expense later commits', async () => {
    await queueMonetizedOperationFinalization('owner-a', input(4, 'failed'));
    await queueMonetizedOperationFinalization('owner-a', input(4, 'completed'));
    mocks.online = true;
    mocks.finalize.mockResolvedValue({ accepted: true });

    expect(await flushMonetizedOperationFinalizations('owner-a', mocks.finalize)).toBe(1);
    expect(mocks.finalize).toHaveBeenCalledWith(input(4, 'completed'));
  });

  it('never downgrades a persisted completion to failed', async () => {
    await queueMonetizedOperationFinalization('owner-a', input(5, 'completed'));
    await queueMonetizedOperationFinalization('owner-a', input(5, 'failed'));
    mocks.online = true;
    mocks.finalize.mockResolvedValue({ accepted: true });

    expect(await flushMonetizedOperationFinalizations('owner-a', mocks.finalize)).toBe(1);
    expect(mocks.finalize).toHaveBeenCalledWith(input(5, 'completed'));
  });

  it.each(['create', 'edit'])('finalizes a completed advanced-split %s mutation', async () => {
    const queue = vi.fn(async () => undefined);
    const mutation = vi.fn(async () => 'committed');

    await expect(runWithMonetizedOperationFinalization({
      ownerUid: 'owner-a',
      operationId: input(6).operationId,
      authorizationId: input(6).authorizationId,
      mutation,
      queue,
    })).resolves.toBe('committed');

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledWith('owner-a', input(6, 'completed'));
  });

  it('records failed only when the underlying expense mutation fails', async () => {
    const mutationError = new Error('update failed');
    const queue = vi.fn(async () => undefined);

    await expect(runWithMonetizedOperationFinalization({
      ownerUid: 'owner-a',
      operationId: input(7).operationId,
      authorizationId: input(7).authorizationId,
      mutation: async () => { throw mutationError; },
      queue,
    })).rejects.toBe(mutationError);

    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledWith('owner-a', input(7, 'failed'));
  });

  it('does not turn a completed expense into failed when queue persistence errors', async () => {
    const queueError = new Error('storage unavailable');
    const onQueueError = vi.fn();
    const queue = vi.fn(async () => { throw queueError; });

    await expect(runWithMonetizedOperationFinalization({
      ownerUid: 'owner-a',
      operationId: input(8).operationId,
      authorizationId: input(8).authorizationId,
      mutation: async () => 'committed',
      queue,
      onQueueError,
    })).resolves.toBe('committed');

    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledWith('owner-a', input(8, 'completed'));
    expect(onQueueError).toHaveBeenCalledWith('completed', queueError);
  });
});
