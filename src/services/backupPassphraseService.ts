/**
 * Backup passphrase enrollment + storage (doc 31 §3.5).
 *
 * The passphrase is the ONLY thing between a stolen encrypted backup and an
 * offline brute force: decryption happens entirely against already-downloaded
 * CKRecords, so there is no server to rate-limit guessing. §3.5 is explicit
 * that a real minimum strength must be ENFORCED at enrollment, not merely
 * suggested — hence `assessPassphrase` returning a hard `meetsMinimum` rather
 * than only a score.
 */

import * as SecureStore from 'expo-secure-store';
import {
  assessPassphrase,
  type PassphraseAssessment,
  type PassphraseVerdict,
} from '@/utils/passphraseStrength';

export { assessPassphrase };
export type { PassphraseAssessment, PassphraseVerdict };

const PASSPHRASE_KEY = 'splitcircle.backup.passphrase';
const ENROLLED_AT_KEY = 'splitcircle.backup.enrolledAt';


export class PassphraseTooWeakError extends Error {
  constructor(assessment: PassphraseAssessment) {
    super(`Passphrase does not meet the minimum strength (${assessment.entropyBits} bits).`);
    this.name = 'PassphraseTooWeakError';
  }
}

/**
 * Stores the passphrase so scheduled and manual backups can run without
 * re-prompting.
 *
 * TRADEOFF, stated plainly: keeping it on-device weakens "only the user knows
 * it" to "only the user's unlocked device knows it". That is the same model
 * WhatsApp uses for automatic backups, and it is unavoidable if backups are to
 * run unattended (§3.6). It costs little in practice because this device
 * already holds the plaintext data the backup is made from — the passphrase's
 * real job is protecting the copy sitting in iCloud, which this does not
 * weaken. `WHEN_UNLOCKED_THIS_DEVICE_ONLY` keeps it out of any iCloud/iTunes
 * backup, so a restored clone cannot inherit it.
 */
export const enrollPassphrase = async (passphrase: string): Promise<void> => {
  const assessment = assessPassphrase(passphrase);
  if (!assessment.meetsMinimum) {
    throw new PassphraseTooWeakError(assessment);
  }

  await SecureStore.setItemAsync(PASSPHRASE_KEY, passphrase, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await SecureStore.setItemAsync(ENROLLED_AT_KEY, String(Date.now()), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
};

export const isPassphraseEnrolled = async (): Promise<boolean> => {
  try {
    return (await SecureStore.getItemAsync(PASSPHRASE_KEY)) != null;
  } catch {
    return false;
  }
};

export const getEnrolledAt = async (): Promise<number | null> => {
  try {
    const raw = await SecureStore.getItemAsync(ENROLLED_AT_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** For backup/restore runs. Returns null when not enrolled. */
export const getStoredPassphrase = async (): Promise<string | null> => {
  try {
    return await SecureStore.getItemAsync(PASSPHRASE_KEY);
  } catch {
    return null;
  }
};

/**
 * Forgets the passphrase on this device.
 *
 * Does NOT and cannot re-encrypt or delete the existing iCloud backup — that
 * backup stays readable only by whoever still knows the old passphrase. The
 * caller must say so plainly rather than implying this "turns off" the backup.
 */
export const clearPassphrase = async (): Promise<void> => {
  await SecureStore.deleteItemAsync(PASSPHRASE_KEY);
  await SecureStore.deleteItemAsync(ENROLLED_AT_KEY);
};
