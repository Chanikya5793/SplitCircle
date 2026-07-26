/**
 * Backup scheduling preferences (doc 31 §3.6, Phase 5).
 *
 * Frequency and the cellular allowance are SYNCED, not per-device: only the
 * main device ever runs a backup, so one value for the account is the correct
 * model and a per-device copy would just drift. Both keys were already
 * declared synced in `settingsSyncRegistry` back in Phase 0.
 */

import NetInfo from '@react-native-community/netinfo';
import { SETTINGS_SYNC_KEYS } from '@/config/settingsSyncRegistry';
import { getSetting, setSetting, subscribeToSetting } from '@/services/settingsSyncService';

export type BackupFrequency = 'daily' | 'every3days' | 'weekly' | 'off';

export const BACKUP_FREQUENCY_LABELS: Record<BackupFrequency, string> = {
  daily: 'Daily',
  every3days: 'Every 3 days',
  weekly: 'Weekly',
  off: 'Off',
};

/** Interval each frequency maps to, used for the stale-backup banner threshold. */
export const FREQUENCY_INTERVAL_MS: Record<Exclude<BackupFrequency, 'off'>, number> = {
  daily: 24 * 60 * 60 * 1000,
  every3days: 3 * 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export const getBackupFrequency = async (userId: string): Promise<BackupFrequency> =>
  getSetting<BackupFrequency>(userId, SETTINGS_SYNC_KEYS.backupFrequency, 'daily');

export const setBackupFrequency = async (
  userId: string,
  frequency: BackupFrequency,
): Promise<void> => setSetting(userId, SETTINGS_SYNC_KEYS.backupFrequency, frequency);

/**
 * Whether backups may run on cellular. Defaults to FALSE (§3.6) — a chat
 * backup can be hundreds of megabytes, and silently spending someone's mobile
 * data is the kind of thing they only discover on their bill.
 */
export const getBackupAllowCellular = async (userId: string): Promise<boolean> =>
  getSetting<boolean>(userId, SETTINGS_SYNC_KEYS.backupAllowCellular, false);

export const setBackupAllowCellular = async (userId: string, allow: boolean): Promise<void> =>
  setSetting(userId, SETTINGS_SYNC_KEYS.backupAllowCellular, allow);

export const subscribeToBackupFrequency = (
  userId: string,
  onChange: (frequency: BackupFrequency) => void,
): (() => void) =>
  subscribeToSetting<BackupFrequency>(
    userId,
    SETTINGS_SYNC_KEYS.backupFrequency,
    'daily',
    onChange,
  );

export interface NetworkAllowance {
  allowed: boolean;
  /** Present when blocked — shown to the user rather than a generic failure. */
  reason?: string;
  isCellular: boolean;
}

/**
 * Whether the current connection permits a backup right now.
 *
 * §3.6 puts the authoritative cellular check inside the native scheduled task
 * via NWPathMonitor; this is the JS-side equivalent for manual runs, so a
 * "Back Up Now" tap honours the same preference instead of quietly ignoring
 * it. Being unreachable is treated as NOT allowed — starting a large upload on
 * an unknown connection is the wrong default.
 */
export const checkNetworkAllowance = async (userId: string): Promise<NetworkAllowance> => {
  const state = await NetInfo.fetch();
  const isCellular = state.type === 'cellular';

  if (state.isConnected === false) {
    return { allowed: false, isCellular, reason: 'You’re offline. Connect to Wi-Fi to back up.' };
  }

  if (!isCellular) return { allowed: true, isCellular };

  const allowCellular = await getBackupAllowCellular(userId);
  if (allowCellular) return { allowed: true, isCellular };

  return {
    allowed: false,
    isCellular,
    reason: 'You’re on cellular and “Back up over cellular” is off. Connect to Wi-Fi, or turn it on below.',
  };
};

/**
 * True when the last backup is older than TWICE the chosen frequency — §3.6's
 * threshold for the persistent risk banner. Deliberately 2x rather than 1x:
 * iOS decides when a background task actually runs, so a single missed window
 * is normal and warning on it would train people to ignore the banner.
 */
export const isBackupStale = (
  frequency: BackupFrequency,
  lastCompletedAt: number | null,
): boolean => {
  if (frequency === 'off') return false;
  if (!lastCompletedAt) return true;
  return Date.now() - lastCompletedAt > FREQUENCY_INTERVAL_MS[frequency] * 2;
};
