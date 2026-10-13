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

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {
  assessPassphrase,
  type PassphraseAssessment,
  type PassphraseVerdict,
} from '@/utils/passphraseStrength';

export { assessPassphrase };
export type { PassphraseAssessment, PassphraseVerdict };

/**
 * AFTER-FIRST-UNLOCK, not when-unlocked.
 *
 * iOS runs background processing tasks mostly overnight, while the phone is
 * locked and charging — and a when-unlocked Keychain item cannot be read then.
 * Every scheduled backup therefore failed with "no passphrase" (and the
 * recovery secret the manifest needs was unreadable too), which is why
 * automatic backups never happened. After-first-unlock keeps the items
 * device-only and unavailable before the first unlock after a reboot, which
 * is the protection that actually matters here.
 */
const KEYCHAIN_ACCESS = SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;

const PASSPHRASE_KEY = 'splitcircle.backup.passphrase';
const ENROLLED_AT_KEY = 'splitcircle.backup.enrolledAt';
const RECOVERY_SECRET_KEY = 'splitcircle.backup.recoverySecret';

/** Reads an item, falling back to an in-flight migration copy. */
const readItem = async (key: string): Promise<string | null> =>
  (await SecureStore.getItemAsync(key)) ?? (await SecureStore.getItemAsync(`${key}.migrating`));

/**
 * The random secret written into every manifest, whose SHA-256 the server
 * holds as the §3.12 recovery verifier. Presenting the preimage is what proves
 * a recovering device really opened the backup.
 *
 * Kept on-device only so it stays STABLE across re-exports — the copy that
 * matters during recovery is the one inside the manifest, which is why losing
 * this (app reinstall) is harmless: the next export mints a fresh secret,
 * rewrites the manifest and re-publishes the verifier, and the two stay in
 * step. It is deliberately NOT derived from the passphrase: a value derived
 * from the passphrase and then published server-side would hand an attacker
 * who reads Firestore an offline oracle to test passphrase guesses against.
 */
export const getOrCreateRecoverySecret = async (): Promise<string> => {
  const existing = await readItem(RECOVERY_SECRET_KEY);
  if (existing) return existing;

  // btoa over a binary string, matching backupService's encoding convention.
  // Deliberately NOT `Buffer` — it is not polyfilled in this Hermes runtime,
  // and @types/node makes that mistake typecheck cleanly while crashing on
  // device.
  const bytes = Crypto.getRandomBytes(32);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // eslint-disable-next-line no-undef
  const secret = globalThis.btoa(binary);
  await SecureStore.setItemAsync(RECOVERY_SECRET_KEY, secret, {
    keychainAccessible: KEYCHAIN_ACCESS,
  });
  return secret;
};


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
    keychainAccessible: KEYCHAIN_ACCESS,
  });
  await SecureStore.setItemAsync(ENROLLED_AT_KEY, String(Date.now()), {
    keychainAccessible: KEYCHAIN_ACCESS,
  });
};

/**
 * Stores the passphrase of a backup that was just RESTORED on this device.
 *
 * No strength check: it is not a new choice but a proven one (it decrypted
 * the backup), and this device must keep backing up under the SAME passphrase
 * or its next backup would be sealed under a key the user doesn't know.
 */
export const adoptRestoredPassphrase = async (passphrase: string): Promise<void> => {
  await SecureStore.setItemAsync(PASSPHRASE_KEY, passphrase, { keychainAccessible: KEYCHAIN_ACCESS });
  if (!(await readItem(ENROLLED_AT_KEY))) {
    await SecureStore.setItemAsync(ENROLLED_AT_KEY, String(Date.now()), { keychainAccessible: KEYCHAIN_ACCESS });
  }
};

export const isPassphraseEnrolled = async (): Promise<boolean> => {
  try {
    return (await readItem(PASSPHRASE_KEY)) != null;
  } catch {
    return false;
  }
};

export const getEnrolledAt = async (): Promise<number | null> => {
  try {
    const raw = await readItem(ENROLLED_AT_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** For backup/restore runs. Returns null when not enrolled. */
export const getStoredPassphrase = async (): Promise<string | null> => {
  try {
    return await readItem(PASSPHRASE_KEY);
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
  // The recovery secret is deliberately KEPT. It identifies the backup sitting
  // in iCloud, which this does not delete; dropping it here would mint a new
  // secret on the next enrollment and leave the old backup's manifest holding
  // one the server no longer knows — unrecoverable for no reason.
};

/**
 * Re-saves items written with the old when-unlocked accessibility. Runs in
 * the foreground (where they are readable) at app start; idempotent.
 */
const MIGRATED_FLAG = 'splitcircle.backup.keychainAfterFirstUnlock';

export const migrateBackupKeychainAccess = async (): Promise<void> => {
  try {
    if ((await SecureStore.getItemAsync(MIGRATED_FLAG)) === '1') return;
    for (const key of [PASSPHRASE_KEY, ENROLLED_AT_KEY, RECOVERY_SECRET_KEY]) {
      const value = await readItem(key);
      if (value == null) continue;
      // An update keeps the item's old accessibility class, so the item has
      // to be deleted and re-added. A temporary copy is written FIRST, and
      // reads fall back to it (readItem), so dying between the delete and
      // the re-add cannot lose the passphrase.
      await SecureStore.setItemAsync(`${key}.migrating`, value, { keychainAccessible: KEYCHAIN_ACCESS });
      await SecureStore.deleteItemAsync(key);
      await SecureStore.setItemAsync(key, value, { keychainAccessible: KEYCHAIN_ACCESS });
      await SecureStore.deleteItemAsync(`${key}.migrating`);
    }
    await SecureStore.setItemAsync(MIGRATED_FLAG, '1', { keychainAccessible: KEYCHAIN_ACCESS });
  } catch {
    // Locked or unavailable: try again next launch.
  }
};
