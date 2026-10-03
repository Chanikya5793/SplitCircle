import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __asyncStorageStore, __clearAsyncStorageStore } from './mocks/async-storage';

const mocks = vi.hoisted(() => ({
  online: true,
  send: vi.fn(),
  authUid: 'owner-a' as string | null,
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
  recordMonetizationUsage: mocks.send,
}));

import {
  __resetMonetizationUsageQueueForTests,
  flushMonetizationUsageQueue,
  queueMonetizationUsage,
} from '../monetizationUsageQueue';

const STORAGE_KEY = 'monetization_usage_queue_v1';
const operationId = (suffix: number): string =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`;

const event = (id: string) => ({
  operationId: id,
  featureId: 'advanced_split.completion',
  outcome: 'completed' as const,
  variant: 'income',
  executionRoute: 'local_deterministic' as const,
});

describe('monetization usage queue', () => {
  beforeEach(async () => {
    __clearAsyncStorageStore();
    await __resetMonetizationUsageQueueForTests();
    mocks.online = false;
    mocks.authUid = 'owner-a';
    mocks.send.mockReset();
  });

  it('durably deduplicates the same operation while offline', async () => {
    await queueMonetizationUsage('owner-a', event(operationId(1)));
    await queueMonetizationUsage('owner-a', event(operationId(1)));
    mocks.online = true;
    mocks.send.mockResolvedValue({ accepted: true });

    expect(await flushMonetizationUsageQueue('owner-a', mocks.send)).toBe(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      operationId: operationId(1),
      connectivity: 'offline_reconciled',
    }));
  });

  it('does not send another signed-in account\'s event', async () => {
    await queueMonetizationUsage('owner-b', event(operationId(2)));
    mocks.online = true;
    mocks.send.mockResolvedValue({ accepted: true });

    expect(await flushMonetizationUsageQueue('owner-a', mocks.send)).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.authUid = 'owner-b';
    expect(await flushMonetizationUsageQueue('owner-b', mocks.send)).toBe(1);
  });

  it('retains an event when the server call fails and retries it later', async () => {
    await queueMonetizationUsage('owner-a', event(operationId(3)));
    mocks.online = true;
    mocks.send.mockRejectedValueOnce(new Error('network'));
    expect(await flushMonetizationUsageQueue('owner-a', mocks.send)).toBe(0);

    mocks.send.mockResolvedValueOnce({ accepted: true });
    expect(await flushMonetizationUsageQueue('owner-a', mocks.send)).toBe(1);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('repairs already-queued Siri-prefixed UUIDs before sending', async () => {
    __asyncStorageStore.set(STORAGE_KEY, JSON.stringify([{
      ownerUid: 'owner-a',
      input: {
        ...event(`siri-${operationId(4).toUpperCase()}`),
        connectivity: 'offline_reconciled',
      },
      createdAt: Date.now(),
    }]));
    mocks.online = true;
    mocks.send.mockResolvedValue({ accepted: true });

    expect(await flushMonetizationUsageQueue('owner-a', mocks.send)).toBe(1);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      operationId: operationId(4),
    }));
  });

  it('keeps provider results server-valid if reachability drops before enqueue', async () => {
    await queueMonetizationUsage('owner-a', {
      operationId: operationId(5),
      featureId: 'provider.ai_or_ocr_job',
      outcome: 'completed',
      executionRoute: 'provider',
    });
    mocks.online = true;
    mocks.send.mockResolvedValue({ accepted: true });

    expect(await flushMonetizationUsageQueue('owner-a', mocks.send)).toBe(1);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      operationId: operationId(5),
      connectivity: 'online',
    }));
  });

  it('never sends a queue owned by a different current account', async () => {
    await queueMonetizationUsage('owner-a', event(operationId(6)));
    await queueMonetizationUsage('owner-b', event(operationId(7)));
    mocks.online = true;
    mocks.send.mockResolvedValue({ accepted: true });

    expect(await flushMonetizationUsageQueue('owner-b', mocks.send)).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(await flushMonetizationUsageQueue('owner-a', mocks.send)).toBe(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('drops a permanent bad event without blocking later valid telemetry', async () => {
    await queueMonetizationUsage('owner-a', event(operationId(8)));
    await queueMonetizationUsage('owner-a', event(operationId(9)));
    mocks.online = true;
    mocks.send
      .mockRejectedValueOnce({ code: 'functions/invalid-argument' })
      .mockResolvedValueOnce({ accepted: true });

    expect(await flushMonetizationUsageQueue('owner-a', mocks.send)).toBe(1);
    expect(mocks.send).toHaveBeenCalledTimes(2);

    mocks.send.mockClear();
    expect(await flushMonetizationUsageQueue('owner-a', mocks.send)).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('stops a flush if the signed-in account changes between events', async () => {
    await queueMonetizationUsage('owner-a', event(operationId(10)));
    await queueMonetizationUsage('owner-a', event(operationId(11)));
    mocks.online = true;
    mocks.send.mockImplementation(async () => {
      mocks.authUid = 'owner-b';
      return { accepted: true };
    });

    expect(await flushMonetizationUsageQueue('owner-a', mocks.send)).toBe(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);

    mocks.authUid = 'owner-a';
    mocks.send.mockResolvedValue({ accepted: true });
    expect(await flushMonetizationUsageQueue('owner-a', mocks.send)).toBe(1);
  });
});
