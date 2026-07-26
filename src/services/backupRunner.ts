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
import { publishRecoveryVerifier } from '@/services/accountRecoveryService';
import { checkNetworkAllowance } from '@/services/backupSettingsService';
import { getCurrentDeviceId, subscribeToPairedDevices } from '@/services/pairingService';
import { recordBackupRun } from '@/services/backupHistoryService';
import * as Device from 'expo-device';

const LAST_BACKUP_KEY = 'splitcircle.backup.last';

export interface LastBackupInfo {
  completedAt: number;
  chatCount: number;
  messageCount: number;
  /** Media files skipped for being too large to move through the bridge. */
  mediaSkippedTooLarge?: number;
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
  trigger: 'manual' | 'scheduled' = 'manual',
): Promise<LastBackupInfo> => {
  const startedAt = Date.now();

  /**
   * Every terminal outcome is logged, INCLUDING refusals.
   *
   * A blocked run is the single most useful thing to record: "no backup for
   * three days" reads as neglect, while nine consecutive
   * `network_not_allowed` entries names a setting the user can change. The
   * old code kept only successes, so the interesting case left no trace.
   */
  const log = (
    outcome: 'success' | 'failed' | 'blocked',
    extra: Record<string, unknown> = {},
  ) =>
    recordBackupRun({
      at: Date.now(),
      outcome,
      durationMs: Date.now() - startedAt,
      trigger,
      deviceName: Device.deviceName ?? null,
      ...extra,
    } as Parameters<typeof recordBackupRun>[0]);

  if (running) {
    throw new BackupBlockedError('already_running', 'A backup is already in progress.');
  }

  const passphrase = await getStoredPassphrase();
  if (!passphrase) {
    await log('blocked', { reason: 'no_passphrase', message: 'No backup passphrase is set.' });
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
    await log('blocked', {
      reason: 'network_not_allowed',
      message: network.reason ?? 'This connection can\u2019t be used for backups.',
    });
    throw new BackupBlockedError(
      'network_not_allowed',
      network.reason ?? 'This connection can’t be used for backups right now.',
    );
  }

  const health = await isBackupHealthy();
  if (!health.isAvailable) {
    await log('blocked', {
      reason: 'icloud_unavailable',
      message: health.reason ?? 'iCloud is unavailable.',
    });
    throw new BackupBlockedError(
      'icloud_unavailable',
      health.reason === 'not_signed_into_icloud'
        ? 'Sign in to iCloud on this device to back up.'
        : `iCloud is unavailable: ${health.reason ?? 'unknown reason'}`,
    );
  }

  if (!(await isThisDeviceMain(userId))) {
    await log('blocked', {
      reason: 'not_main_device',
      message: 'Only the main device backs up.',
    });
    throw new BackupBlockedError(
      'not_main_device',
      'Only your main device can back up your chat history.',
    );
  }

  running = true;
  try {
    const manifest = await exportBackup(passphrase, onProgress);

    // Publish the §3.12 recovery verifier for the backup that just landed.
    // After EVERY run, not only the first: this is what lets a device that
    // lost its local secret (app reinstall) mint a new one and have the
    // server's copy follow. Never throws — see publishRecoveryVerifier.
    if (manifest.recoverySecret) {
      // The summary travels with the verifier so a brand-new phone can show
      // WHAT it would restore before the user commits — the manifest itself is
      // unreadable without the passphrase, so without this the choice on the
      // setup screen would be blind.
      const sizes = manifest.sizes ?? {};
      await publishRecoveryVerifier(manifest.recoverySecret, {
        createdAt: manifest.createdAt,
        totalMessages: manifest.totalMessages,
        chatCount: manifest.chats.length,
        bytes: Object.values(sizes).reduce((sum: number, n) => sum + (n ?? 0), 0),
        mediaCount: manifest.mediaIds?.length ?? 0,
        deviceName: Device.deviceName ?? null,
      });
    }

    const info: LastBackupInfo = {
      completedAt: Date.now(),
      chatCount: manifest.chats.length,
      messageCount: manifest.totalMessages,
      mediaSkippedTooLarge: manifest.mediaSkippedTooLarge,
    };
    // Recorded only after a successful export, so a failed run never makes the
    // UI claim a backup exists — the retirement gate (§3.7) reads this.
    await AsyncStorage.setItem(LAST_BACKUP_KEY, JSON.stringify(info));

    const sizes = manifest.sizes ?? {};
    await log('success', {
      messageCount: manifest.totalMessages,
      chatCount: manifest.chats.length,
      bytes: Object.values(sizes).reduce((sum, n) => sum + (n ?? 0), 0),
      sizes,
      mediaSkippedTooLarge: manifest.mediaSkippedTooLarge,
    });
    return info;
  } catch (error) {
    // A run that got past every precondition and then broke is a different
    // condition from a refusal, and the screen says so — this is the one the
    // user cannot fix by changing a setting.
    await log('failed', {
      message: error instanceof Error ? error.message : 'Backup failed.',
    });
    throw error;
  } finally {
    running = false;
  }
};
