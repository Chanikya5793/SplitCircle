import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { auth } from '@/firebase';
import type { FinalizeMonetizedOperationInput } from '@/models/monetization';
import { finalizeMonetizedOperation } from '@/services/monetizationService';
import { normalizeMonetizationOperationId } from '@/utils/monetizationUsage';
import { useEffect } from 'react';
import { AppState } from 'react-native';

const STORAGE_KEY = 'monetization_finalization_queue_v1';
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 2_000;
const AUTHORIZATION_ID_PATTERN = /^[0-9a-f]{64}$/;

interface QueuedFinalization {
  ownerUid: string;
  input: FinalizeMonetizedOperationInput;
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

const normalize = (value: unknown): QueuedFinalization | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<QueuedFinalization>;
  const operationId = typeof item.input?.operationId === 'string'
    ? normalizeMonetizationOperationId(item.input.operationId)
    : null;
  if (!operationId
    || typeof item.ownerUid !== 'string'
    || !item.ownerUid
    || typeof item.input?.authorizationId !== 'string'
    || !AUTHORIZATION_ID_PATTERN.test(item.input.authorizationId)
    || (item.input.outcome !== 'completed'
      && item.input.outcome !== 'failed'
      && item.input.outcome !== 'cancelled'
      && item.input.outcome !== 'abandoned')
    || typeof item.createdAt !== 'number'
    || !Number.isFinite(item.createdAt)) {
    return null;
  }
  return {
    ownerUid: item.ownerUid,
    input: { ...item.input, operationId },
    createdAt: item.createdAt,
  };
};

const readUnlocked = async (): Promise<QueuedFinalization[]> => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.map(normalize).filter(
      (item): item is QueuedFinalization => item !== null && item.createdAt >= cutoff,
    );
  } catch {
    return [];
  }
};

const writeUnlocked = async (items: QueuedFinalization[]): Promise<void> => {
  if (items.length === 0) {
    await AsyncStorage.removeItem(STORAGE_KEY);
    return;
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(-MAX_ITEMS)));
};

const online = async (): Promise<boolean> => {
  try {
    const state = await NetInfo.fetch();
    return state.isConnected === true && state.isInternetReachable === true;
  } catch {
    return false;
  }
};

const permanentRejection = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  const normalized = code.replace(/^functions\//, '');
  return normalized === 'invalid-argument'
    || normalized === 'permission-denied'
    || normalized === 'failed-precondition'
    || normalized === 'not-found';
};

const remove = async (ownerUid: string, authorizationId: string): Promise<void> => {
  await withQueueLock(async () => {
    const current = await readUnlocked();
    await writeUnlocked(current.filter((item) => !(
      item.ownerUid === ownerUid && item.input.authorizationId === authorizationId
    )));
  });
};

/**
 * Persists the completion before attempting the callable. If the app closes
 * after the expense commits, the server reservation still gets finalized on
 * the next foreground or reconnect.
 */
export const queueMonetizedOperationFinalization = async (
  ownerUid: string,
  input: FinalizeMonetizedOperationInput,
): Promise<void> => {
  const operationId = normalizeMonetizationOperationId(input.operationId);
  if (!ownerUid || !operationId || !AUTHORIZATION_ID_PATTERN.test(input.authorizationId)) return;
  await withQueueLock(async () => {
    const current = await readUnlocked();
    const existing = current.find(
      (item) => item.ownerUid === ownerUid && item.input.authorizationId === input.authorizationId,
    );
    if (existing) {
      // A committed expense is the strongest terminal fact we can observe.
      // Never let a later UI error (for example, navigation or haptics after
      // the write) downgrade an already-persisted completion and release its
      // reservation as failed. A prior non-completion may still be upgraded
      // when the underlying mutation eventually succeeds.
      if (existing.input.outcome !== 'completed'
        && input.outcome === 'completed') {
        await writeUnlocked(current.map((item) => (
          item === existing ? { ...item, input: { ...input, operationId } } : item
        )));
      }
      return;
    }
    await writeUnlocked([...current, {
      ownerUid,
      input: { ...input, operationId },
      createdAt: Date.now(),
    }]);
  });
  void flushMonetizedOperationFinalizations(ownerUid);
};

type QueueFinalization = (
  ownerUid: string,
  input: FinalizeMonetizedOperationInput,
) => Promise<void>;

interface RunWithFinalizationOptions<T> {
  ownerUid?: string;
  operationId: string;
  authorizationId?: string;
  mutation: () => Promise<T>;
  queue?: QueueFinalization;
  onQueueError?: (outcome: FinalizeMonetizedOperationInput['outcome'], error: unknown) => void;
}

/**
 * Runs a local expense mutation and records exactly the terminal fact that was
 * observed. Finalization persistence is bookkeeping after a successful local
 * commit, so its own failure must never turn that commit into a failed outcome.
 */
export const runWithMonetizedOperationFinalization = async <T>({
  ownerUid,
  operationId,
  authorizationId,
  mutation,
  queue = queueMonetizedOperationFinalization,
  onQueueError,
}: RunWithFinalizationOptions<T>): Promise<T> => {
  let result: T;
  try {
    result = await mutation();
  } catch (mutationError) {
    if (ownerUid && authorizationId) {
      try {
        await queue(ownerUid, { operationId, authorizationId, outcome: 'failed' });
      } catch (queueError) {
        onQueueError?.('failed', queueError);
      }
    }
    throw mutationError;
  }

  if (ownerUid && authorizationId) {
    try {
      await queue(ownerUid, { operationId, authorizationId, outcome: 'completed' });
    } catch (queueError) {
      onQueueError?.('completed', queueError);
    }
  }
  return result;
};

export const flushMonetizedOperationFinalizations = async (
  ownerUid: string | undefined = auth.currentUser?.uid,
  send: typeof finalizeMonetizedOperation = finalizeMonetizedOperation,
): Promise<number> => {
  if (!ownerUid || auth.currentUser?.uid !== ownerUid || !(await online())) return 0;
  const existing = flushPromises.get(ownerUid);
  if (existing) return existing;

  const promise = (async () => {
    const items = (await withQueueLock(readUnlocked)).filter((item) => item.ownerUid === ownerUid);
    let flushed = 0;
    for (const item of items) {
      if (auth.currentUser?.uid !== ownerUid) break;
      try {
        await send(item.input);
        await remove(ownerUid, item.input.authorizationId);
        flushed += 1;
      } catch (error) {
        if (permanentRejection(error)) {
          await remove(ownerUid, item.input.authorizationId);
          continue;
        }
        break;
      }
    }
    return flushed;
  })();
  flushPromises.set(ownerUid, promise);
  void promise.finally(() => {
    if (flushPromises.get(ownerUid) === promise) flushPromises.delete(ownerUid);
  });
  return promise;
};

export const useMonetizedOperationFinalizationFlush = (): void => {
  useEffect(() => {
    const flush = () => {
      const uid = auth.currentUser?.uid;
      if (uid) void flushMonetizedOperationFinalizations(uid);
    };
    const network = NetInfo.addEventListener((state) => {
      if (state.isConnected === true && state.isInternetReachable === true) flush();
    });
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') flush();
    });
    flush();
    return () => {
      network();
      appState.remove();
    };
  }, []);
};

export const __resetMonetizedOperationFinalizationQueueForTests = async (): Promise<void> => {
  await withQueueLock(() => writeUnlocked([]));
  flushPromises.clear();
};
