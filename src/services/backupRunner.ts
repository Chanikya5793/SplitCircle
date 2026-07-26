/**
 * Runs an actual backup (doc 31 §3.2/§3.6).
 *
 * Sits between the enrollment UI and `backupService`, and owns the three
 * preconditions a backup must satisfy before it may run: a passphrase is
 * enrolled, iCloud is actually usable, and THIS device is the main device.
 * Keeping them here rather than in the UI means a scheduled run (§3.6, Phase 5)
 * inherits the same rules instead of re-deriving them.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { isBackupHealthy } from '../../modules/splitcircle-backup';
import { exportBackup, type BackupProgress } from '@/services/backupService';
import { getStoredPassphrase } from '@/services/backupPassphraseService';
import { checkNetworkAllowance } from '@/services/backupSettingsService';
import { getCurrentDeviceId, subscribeToPairedDevices } from '@/services/pairingService';

const LAST_BACKUP_KEY = 'splitcircle.backup.last';

export interface LastBackupInfo {
  completedAt: number;
  chatCount: number;
  messageCount: number;
}

export type BackupBlockedReason =
  | 'no_passphrase'
  | 'icloud_unavailable'
  | 'not_main_device'
  | 'already_running'
  | 'network_not_allowed';

export class BackupBlockedError extends Error {
  readonly reason: BackupBlockedReason;

  constructor(reason: BackupBlockedReason, message: string) {
    super(message);
    this.name = 'BackupBlockedError';
    this.reason = reason;
  }
}

/**
 * One run at a time, process-wide. Two concurrent exports would write the same
 * record ids from two different points in the message history and race the
 * manifest — the last writer would publish an index describing batches the
 * other run overwrote.
 */
let running = false;

export const isBackupRunning = (): boolean => running;

export const getLastBackupInfo = async (): Promise<LastBackupInfo | null> => {
  try {
    const raw = await AsyncStorage.getItem(LAST_BACKUP_KEY);
    return raw ? (JSON.parse(raw) as LastBackupInfo) : null;
  } catch {
    return null;
  }
};

/**
 * §3.2: only the main device exports. A companion holds a partial view of
 * history (§3.4's bounded handoff), so letting it back up would publish a
 * SHORTER backup over the complete one — silent data loss that only surfaces
 * on a restore, which is exactly when it cannot be undone.
 */
const isThisDeviceMain = async (userId: string): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    void getCurrentDeviceId().then((deviceId) => {
      const unsubscribe = subscribeToPairedDevices(
        userId,
        (devices) => {
          if (settled) return;
          settled = true;
          const own = devices.find((device) => device.deviceId === deviceId);
          resolve(own?.isMainDevice === true);
          unsubscribe();
        },
        () => {
          if (settled) return;
          settled = true;
          // Can't establish that we're main — refuse rather than assume.
          resolve(false);
          unsubscribe();
        },
      );
    });
  });

/**
 * Runs a full backup now.
 *
 * Throws `BackupBlockedError` with a specific reason when a precondition
 * fails, so callers can say WHY rather than showing a generic failure.
 */
export const runBackupNow = async (
  userId: string,
  onProgress?: (progress: BackupProgress) => void,
): Promise<LastBackupInfo> => {
  if (running) {
    throw new BackupBlockedError('already_running', 'A backup is already in progress.');
  }

  const passphrase = await getStoredPassphrase();
  if (!passphrase) {
    throw new BackupBlockedError(
      'no_passphrase',
      'Set a backup passphrase before backing up.',
    );
  }

  // Honour the cellular preference on manual runs too (§3.6). The scheduled
  // task enforces this natively via NWPathMonitor; without the same check
  // here, "Back Up Now" would quietly spend mobile data the user said not to.
  const network = await checkNetworkAllowance(userId);
  if (!network.allowed) {
    throw new BackupBlockedError(
      'network_not_allowed',
      network.reason ?? 'This connection can’t be used for backups right now.',
    );
  }

  const health = await isBackupHealthy();
  if (!health.isAvailable) {
    throw new BackupBlockedError(
      'icloud_unavailable',
      health.reason === 'not_signed_into_icloud'
        ? 'Sign in to iCloud on this device to back up.'
        : `iCloud is unavailable: ${health.reason ?? 'unknown reason'}`,
    );
  }

  if (!(await isThisDeviceMain(userId))) {
    throw new BackupBlockedError(
      'not_main_device',
      'Only your main device can back up your chat history.',
    );
  }

  running = true;
  try {
    const manifest = await exportBackup(passphrase, onProgress);
    const info: LastBackupInfo = {
      completedAt: Date.now(),
      chatCount: manifest.chats.length,
      messageCount: manifest.totalMessages,
    };
    // Recorded only after a successful export, so a failed run never makes the
    // UI claim a backup exists — the retirement gate (§3.7) reads this.
    await AsyncStorage.setItem(LAST_BACKUP_KEY, JSON.stringify(info));
    return info;
  } finally {
    running = false;
  }
};
