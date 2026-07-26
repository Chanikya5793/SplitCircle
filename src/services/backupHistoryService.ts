/**
 * A rolling log of backup runs (product-owner request 2026-07-26).
 *
 * WHY THIS EXISTS. Before it, exactly one fact was kept: the timestamp of the
 * last SUCCESSFUL backup. That makes the most useful question unanswerable —
 * "why hasn't this backed up in three days?" A single success timestamp cannot
 * distinguish "iOS hasn't scheduled it yet" from "it has tried nine times and
 * been refused on cellular every time", and those need opposite responses from
 * the user. Failures are recorded here with their REASON precisely so the
 * screen can say which one is happening.
 *
 * Deliberately local-only and device-scoped. This is diagnostic history about
 * THIS device's behaviour, not account state — syncing it would say nothing
 * true about another device, since only the main device ever backs up.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BackupCategory } from '@/services/backupContentService';

const HISTORY_KEY = 'splitcircle.backup.history';

/**
 * Kept short on purpose. Twenty runs is roughly three weeks of daily backups —
 * long enough to see a pattern, small enough that the whole log is a few KB
 * and can be read synchronously on screen open without paging.
 */
const MAX_ENTRIES = 20;

export interface BackupRunEntry {
  /** When the run finished (success or failure). */
  at: number;
  outcome: 'success' | 'failed' | 'blocked';
  /** How long the run took, milliseconds. */
  durationMs: number;
  /** Machine-readable cause for a blocked/failed run, e.g. 'network_not_allowed'. */
  reason?: string;
  /** Human-readable cause, shown verbatim. */
  message?: string;
  messageCount?: number;
  chatCount?: number;
  /** Total bytes written this run. */
  bytes?: number;
  sizes?: Partial<Record<BackupCategory, number>>;
  /** Files skipped for exceeding the bridge size limit. */
  mediaSkippedTooLarge?: number;
  /** Whether this run was started by the user or by the OS scheduler. */
  trigger: 'manual' | 'scheduled';
  /** Device that ran it — only meaningful after a main-device takeover. */
  deviceName?: string | null;
}

export const getBackupHistory = async (): Promise<BackupRunEntry[]> => {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as BackupRunEntry[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** Newest first, capped at MAX_ENTRIES. */
export const recordBackupRun = async (entry: BackupRunEntry): Promise<void> => {
  try {
    const existing = await getBackupHistory();
    const next = [entry, ...existing].slice(0, MAX_ENTRIES);
    await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // History is diagnostic. Never let recording it fail a real backup.
  }
};

/** Most recent successful run, for "last backup" displays. */
export const getLastSuccessfulRun = async (): Promise<BackupRunEntry | null> =>
  (await getBackupHistory()).find((entry) => entry.outcome === 'success') ?? null;

/**
 * How many times in a row the most recent runs have failed.
 *
 * Drives the "something is actually wrong" banner: one failure is noise (a
 * flaky network), several in a row is a condition the user has to act on.
 */
export const getConsecutiveFailures = async (): Promise<number> => {
  const history = await getBackupHistory();
  let count = 0;
  for (const entry of history) {
    if (entry.outcome === 'success') break;
    count += 1;
  }
  return count;
};
