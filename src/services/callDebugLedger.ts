/**
 * callDebugLedger.ts — a small persistent ring buffer for diagnosing the
 * device-only call failures we cannot reproduce in a simulator (iOS Phone-app
 * Recents redial, VoIP cold starts, CallKit echo filtering). TestFlight ships
 * blind: there is no Metro console on a real device, so the ONLY way to see
 * what the redial pipeline actually did is to persist tagged breadcrumbs and
 * let the user copy them out of Settings › Notifications › Diagnostics.
 *
 * Design constraints:
 * - Fire-and-forget: appends MUST never throw or block the call path. Every
 *   write is wrapped and serialized behind a promise chain so concurrent
 *   appends (they happen in bursts during a redial) can't clobber each other
 *   with a read-modify-write race.
 * - Bounded: at most MAX_ENTRIES survive so the buffer can never grow without
 *   limit on disk.
 * - Cheap reads: an in-memory mirror backs the viewer so opening the log is
 *   instant and doesn't depend on a fresh AsyncStorage read.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface CallDebugEntry {
  ts: number;
  tag: string;
  data?: Record<string, unknown>;
}

const STORAGE_KEY = 'callDebugLedger.entries';
const MAX_ENTRIES = 200;

// In-memory mirror of the persisted ring buffer. Loaded lazily once per
// process, then kept in lockstep with every append so the viewer never has to
// re-read AsyncStorage and rapid appends don't lose entries to a read race.
let cache: CallDebugEntry[] | null = null;
let loadPromise: Promise<CallDebugEntry[]> | null = null;
// Serializes writes: each append awaits the previous one so two bursts of
// breadcrumbs can't both read the same snapshot and overwrite each other.
let writeChain: Promise<void> = Promise.resolve();

const isEntry = (value: unknown): value is CallDebugEntry =>
  typeof value === 'object'
  && value !== null
  && typeof (value as CallDebugEntry).ts === 'number'
  && typeof (value as CallDebugEntry).tag === 'string';

const parseEntries = (raw: string | null): CallDebugEntry[] => {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isEntry);
  } catch {
    // Corrupted ledger is diagnostic-only — start clean rather than crash.
    return [];
  }
};

const load = (): Promise<CallDebugEntry[]> => {
  if (cache) {
    return Promise.resolve(cache);
  }
  if (!loadPromise) {
    loadPromise = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        cache = parseEntries(raw);
        return cache;
      })
      .catch(() => {
        cache = [];
        return cache;
      });
  }
  return loadPromise;
};

/**
 * Append a tagged breadcrumb. Fire-and-forget by design: callers do NOT await
 * this (it must never delay placing/tearing down a call). Any failure is
 * swallowed — a diagnostic write can never be allowed to break the call path.
 */
export const appendCallDebug = (tag: string, data?: Record<string, unknown>): void => {
  const entry: CallDebugEntry = { ts: Date.now(), tag, ...(data ? { data } : {}) };
  writeChain = writeChain
    .then(async () => {
      const entries = await load();
      entries.push(entry);
      // Ring buffer: drop the oldest entries once over the cap.
      if (entries.length > MAX_ENTRIES) {
        entries.splice(0, entries.length - MAX_ENTRIES);
      }
      cache = entries;
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    })
    .catch(() => {
      // Never surface a ledger write failure to the caller.
    });
};

/** All entries, newest-first (the order a human wants to read them in). */
export const getCallDebugEntries = async (): Promise<CallDebugEntry[]> => {
  const entries = await load();
  return [...entries].reverse();
};

/** Wipe the ledger (both the in-memory mirror and disk). */
export const clearCallDebugLedger = async (): Promise<void> => {
  cache = [];
  writeChain = writeChain
    .then(async () => {
      await AsyncStorage.removeItem(STORAGE_KEY);
    })
    .catch(() => {
      // best-effort
    });
  await writeChain;
};

/** Human-readable, copy-pasteable rendering (newest-first). */
export const formatCallDebugEntries = (entries: CallDebugEntry[]): string => {
  if (entries.length === 0) {
    return 'No call debug entries recorded yet.';
  }
  return entries
    .map((entry) => {
      const time = new Date(entry.ts).toISOString();
      const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
      return `[${time}] ${entry.tag}${data}`;
    })
    .join('\n');
};
