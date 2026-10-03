import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { auth } from '@/firebase';
import type { RecordMonetizationUsageInput } from '@/models/monetization';
import { recordMonetizationUsage } from '@/services/monetizationService';
import { normalizeMonetizationOperationId } from '@/utils/monetizationUsage';
import { useEffect } from 'react';
import { AppState } from 'react-native';

const STORAGE_KEY = 'monetization_usage_queue_v1';
const MAX_EVENT_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_QUEUED_EVENTS = 2_000;

export type QueuedMonetizationUsageInput = Omit<
  RecordMonetizationUsageInput,
  'connectivity'
>;

interface QueuedMonetizationUsage {
  ownerUid: string;
  input: RecordMonetizationUsageInput;
  createdAt: number;
}

let writeChain: Promise<void> = Promise.resolve();
const flushPromises = new Map<string, Promise<number>>();

const withQueueLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = writeChain;
  let release!: () => void;
  writeChain = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
};

const isConnectivity = (value: unknown): value is RecordMonetizationUsageInput['connectivity'] =>
  value === 'online' || value === 'offline_reconciled';

const normalizeQueuedUsage = (value: unknown): QueuedMonetizationUsage | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<QueuedMonetizationUsage>;
  if (
    typeof item.ownerUid !== 'string'
    || item.ownerUid.length === 0
    || typeof item.createdAt !== 'number'
    || !Number.isFinite(item.createdAt)
    || !item.input
    || typeof item.input.operationId !== 'string'
    || typeof item.input.featureId !== 'string'
    || !isConnectivity(item.input.connectivity)
  ) {
    return null;
  }

  const operationId = normalizeMonetizationOperationId(item.input.operationId);
  if (!operationId) return null;
  return {
    ownerUid: item.ownerUid,
    input: { ...item.input, operationId },
    createdAt: item.createdAt,
  };
};

const readUnlocked = async (): Promise<QueuedMonetizationUsage[]> => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_EVENT_AGE_MS;
    return parsed
      .map(normalizeQueuedUsage)
      .filter((item): item is QueuedMonetizationUsage => item !== null && item.createdAt >= cutoff);
  } catch {
    return [];
  }
};

const writeUnlocked = async (events: QueuedMonetizationUsage[]): Promise<void> => {
  if (events.length === 0) {
    await AsyncStorage.removeItem(STORAGE_KEY);
    return;
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_QUEUED_EVENTS)));
};

const deviceIsOnline = async (): Promise<boolean> => {
  try {
    const state = await NetInfo.fetch();
    return state.isConnected === true && state.isInternetReachable === true;
  } catch {
    return false;
  }
};

const removeQueuedOperation = async (ownerUid: string, operationId: string): Promise<void> => {
  await withQueueLock(async () => {
    const fresh = await readUnlocked();
    await writeUnlocked(fresh.filter((candidate) => !(
      candidate.ownerUid === ownerUid
      && candidate.input.operationId === operationId
    )));
  });
};

const isPermanentServerRejection = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  const normalized = code.replace(/^functions\//, '');
  return normalized === 'invalid-argument' || normalized === 'failed-precondition';
};

/**
 * Persists a privacy-minimized event before trying the network. The owner UID
 * stays local and prevents one signed-in account from flushing another
 * account's pending telemetry after an account switch.
 */
export const queueMonetizationUsage = async (
  ownerUid: string,
  input: QueuedMonetizationUsageInput,
): Promise<void> => {
  if (!ownerUid) return;
  const operationId = normalizeMonetizationOperationId(input.operationId);
  if (!operationId) return;
  const normalizedInput = { ...input, operationId };
  await withQueueLock(async () => {
    const current = await readUnlocked();
    const duplicate = current.some(
      (event) => event.ownerUid === ownerUid && event.input.operationId === operationId,
    );
    if (duplicate) return;
    await writeUnlocked([...current, {
      ownerUid,
      // Persist first with the conservative classification. If the process is
      // killed before reachability resolves, the event is still durable and
      // the server will correctly treat its window as receive-time shadow data.
      input: {
        ...normalizedInput,
        // A completed provider result proves that its operation ran online.
        // Marking it offline-reconciled would be rejected by the server and
        // leave a permanently unflushable event at the front of the queue.
        connectivity: input.executionRoute === 'provider' ? 'online' : 'offline_reconciled',
      },
      createdAt: Date.now(),
    }]);
  });
  if (input.executionRoute !== 'provider' && await deviceIsOnline()) {
    await withQueueLock(async () => {
      const current = await readUnlocked();
      await writeUnlocked(current.map((event) => (
        event.ownerUid === ownerUid && event.input.operationId === operationId
          ? { ...event, input: { ...event.input, connectivity: 'online' } }
          : event
      )));
    });
  }
  void flushMonetizationUsageQueue(ownerUid);
};

/**
 * Flushes only the active account's events. Each server write is idempotent by
 * operationId; removal happens only after an accepted response.
 */
export const flushMonetizationUsageQueue = async (
  ownerUid: string | undefined = auth.currentUser?.uid,
  send: typeof recordMonetizationUsage = recordMonetizationUsage,
): Promise<number> => {
  if (!ownerUid || auth.currentUser?.uid !== ownerUid || !(await deviceIsOnline())) return 0;
  const existingFlush = flushPromises.get(ownerUid);
  if (existingFlush) return existingFlush;

  const flushPromise = (async () => {
    const snapshot = await withQueueLock(readUnlocked);
    const pending = snapshot.filter((event) => event.ownerUid === ownerUid);
    let flushed = 0;
    for (const event of pending) {
      // The callable authenticates the current Firebase user, not ownerUid.
      // Stop before an account switch could attribute this event to somebody
      // other than the local queue owner.
      if (auth.currentUser?.uid !== ownerUid) break;
      try {
        await send(event.input);
        await removeQueuedOperation(ownerUid, event.input.operationId);
        flushed += 1;
      } catch (error) {
        if (isPermanentServerRejection(error)) {
          // Retrying malformed input or an idempotency-key conflict can never
          // succeed. Drop only that event so it cannot block later valid usage.
          await removeQueuedOperation(ownerUid, event.input.operationId);
          continue;
        }
        // Usually connectivity or authentication. Keep this and later events
        // durable, then retry on the next reconnect/foreground transition.
        break;
      }
    }
    return flushed;
  })();
  flushPromises.set(ownerUid, flushPromise);
  void flushPromise.finally(() => {
    if (flushPromises.get(ownerUid) === flushPromise) {
      flushPromises.delete(ownerUid);
    }
  });

  return flushPromise;
};

/** Mount once inside the authenticated app tree. */
export const useMonetizationUsageFlush = (): void => {
  useEffect(() => {
    const flushCurrentAccount = () => {
      const uid = auth.currentUser?.uid;
      if (uid) void flushMonetizationUsageQueue(uid);
    };
    const networkSubscription = NetInfo.addEventListener((state) => {
      if (state.isConnected === true && state.isInternetReachable === true) {
        flushCurrentAccount();
      }
    });
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') flushCurrentAccount();
    });
    flushCurrentAccount();
    return () => {
      networkSubscription();
      appStateSubscription.remove();
    };
  }, []);
};

export const __resetMonetizationUsageQueueForTests = async (): Promise<void> => {
  await withQueueLock(() => writeUnlocked([]));
  flushPromises.clear();
};
