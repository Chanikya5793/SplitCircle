/**
 * "What has to be true for the next backup to run" (product-owner decision,
 * 2026-07-26).
 *
 * WHY THIS SHAPE, AND NOT A PREDICTED TIME. §3.6's locked decision is that we
 * never invent a next-run timestamp, and that holds: iOS alone decides when a
 * BGProcessingTask executes, and it may decline for days on a device that is
 * rarely charged. A "Next backup: 3:00 AM" that silently doesn't happen
 * teaches the user the whole screen lies.
 *
 * The honest substitute is CONDITIONS, which are real, checkable right now,
 * and actionable: instead of a clock the user can't trust, they see exactly
 * what is currently standing in the way — and every item here is something
 * they can do something about.
 */

import { isBackupHealthy } from '../../modules/splitcircle-backup';
import { isPassphraseEnrolled } from '@/services/backupPassphraseService';
import { checkNetworkAllowance, getBackupFrequency } from '@/services/backupSettingsService';
import { isBackupScheduled } from '@/services/backupScheduler';
import { getCurrentDeviceId, subscribeToPairedDevices } from '@/services/pairingService';

export interface ReadinessCondition {
  key: 'passphrase' | 'icloud' | 'network' | 'main_device' | 'scheduled';
  label: string;
  met: boolean;
  /** Shown when unmet — says what to DO, never just what is wrong. */
  detail?: string;
}

export interface BackupReadiness {
  conditions: ReadinessCondition[];
  /** True when a scheduled run could actually proceed right now. */
  readyNow: boolean;
  frequencyLabel: string;
}

const isMainDevice = (userId: string): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    void getCurrentDeviceId().then((deviceId) => {
      const unsubscribe = subscribeToPairedDevices(
        userId,
        (devices) => {
          if (settled) return;
          settled = true;
          resolve(devices.find((d) => d.deviceId === deviceId)?.isMainDevice === true);
          unsubscribe();
        },
        () => {
          if (settled) return;
          settled = true;
          resolve(false);
          unsubscribe();
        },
      );
    });
  });

export const assessBackupReadiness = async (userId: string): Promise<BackupReadiness> => {
  const [enrolled, health, network, frequency, scheduled, main] = await Promise.all([
    isPassphraseEnrolled(),
    isBackupHealthy(),
    checkNetworkAllowance(userId),
    getBackupFrequency(userId),
    isBackupScheduled(),
    isMainDevice(userId),
  ]);

  const conditions: ReadinessCondition[] = [
    {
      key: 'passphrase',
      label: 'Backup passphrase set',
      met: enrolled,
      detail: 'Set a passphrase — without one nothing can be encrypted or restored.',
    },
    {
      key: 'icloud',
      label: 'Signed in to iCloud',
      met: health.isAvailable,
      detail: health.reason ?? 'Sign in to iCloud in the Settings app.',
    },
    {
      key: 'network',
      label: network.isCellular ? 'Connection allowed (on cellular)' : 'Connected to Wi-Fi',
      met: network.allowed,
      detail: network.reason,
    },
    {
      key: 'main_device',
      label: 'This is your main device',
      met: main,
      detail: 'Only your main device backs up. This one syncs from it instead.',
    },
  ];

  // Only meaningful when automatic backups are actually wanted — with
  // frequency off, an unregistered task is the correct state, not a fault.
  if (frequency !== 'off') {
    conditions.push({
      key: 'scheduled',
      label: 'Automatic backup scheduled with iOS',
      met: scheduled,
      detail: 'iOS did not accept the schedule on this device. Manual backups still work.',
    });
  }

  return {
    conditions,
    readyNow: conditions.every((condition) => condition.met),
    frequencyLabel:
      frequency === 'off'
        ? 'Automatic backups are off'
        : frequency === 'daily'
          ? 'Runs about once a day'
          : frequency === 'every3days'
            ? 'Runs about every 3 days'
            : 'Runs about once a week',
  };
};
