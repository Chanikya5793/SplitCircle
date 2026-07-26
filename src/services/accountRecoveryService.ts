/**
 * New-main-device recovery (doc 31 §3.12).
 *
 * The escape from a total lockout: a device whose only possible approver is a
 * phone the user no longer has. See `functions/src/accountRecovery.ts` for the
 * full statement of the bug and why the server-side verifier is load-bearing.
 *
 * The client's job here is narrow — open the backup with the passphrase, pull
 * the `recoverySecret` the manifest carries, and present its SHA-256. The
 * secret itself never leaves the device: publishing the hash means a Firestore
 * leak yields nothing replayable, and the preimage exists only inside a backup
 * that cannot be read without both the user's iCloud account and passphrase.
 */

import * as Crypto from 'expo-crypto';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '@/firebase';
import { readBackupManifest } from '@/services/backupService';
import { getCurrentDeviceId } from '@/services/pairingService';

const functions = getFunctions(app);

/** Distinguishes "the passphrase didn't open the backup" from a real fault. */
export class BackupProofError extends Error {
  constructor(
    message: string,
    readonly code: 'no_manifest' | 'no_secret' | 'mismatch' | 'proof_required',
  ) {
    super(message);
    this.name = 'BackupProofError';
  }
}

const sha256Hex = async (input: string): Promise<string> =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, {
    encoding: Crypto.CryptoEncoding.HEX,
  });

/**
 * Publishes the verifier for the backup just written.
 *
 * Never throws: a backup that landed in iCloud is a success even if this call
 * can't reach the network, and failing the whole run would be a worse outcome
 * than a verifier that catches up on the next one. It is re-published after
 * EVERY export precisely so a missed publish is self-healing.
 */
export const publishRecoveryVerifier = async (recoverySecret: string): Promise<void> => {
  try {
    const verifier = await sha256Hex(recoverySecret);
    await httpsCallable(functions, 'setBackupRecoveryVerifier')({ verifier });
  } catch (error) {
    console.warn('Could not publish the backup recovery verifier', error);
  }
};

/** Whether this account has a backup that recovery could verify against. */
export const hasRecoverableBackup = async (): Promise<boolean> => {
  try {
    const result = await httpsCallable<unknown, { hasBackup: boolean }>(
      functions,
      'hasBackupRecovery',
    )({});
    return result.data.hasBackup === true;
  } catch {
    // Unknown is reported as "no backup" only for choosing which explanation
    // to show; the server re-checks for real and will still demand proof.
    return false;
  }
};

export interface RecoveryResult {
  revokedDeviceIds: string[];
  backupVerified: boolean;
}

/**
 * Recovers this device as the new main using the backup passphrase.
 *
 * Reads and DECRYPTS the manifest locally first — that is what makes the
 * passphrase a real factor rather than a string the server takes on trust.
 */
export const recoverWithPassphrase = async (passphrase: string): Promise<RecoveryResult> => {
  const manifest = await readBackupManifest(passphrase);
  if (!manifest) {
    throw new BackupProofError(
      "We couldn't find a backup in this iCloud account.",
      'no_manifest',
    );
  }
  if (!manifest.recoverySecret) {
    // A backup written before §3.12 existed. The passphrase demonstrably
    // worked (the manifest decrypted), but there is no preimage to present,
    // so the server has nothing to check it against.
    throw new BackupProofError(
      'This backup was made by an older version of the app and cannot prove itself. Use the no-backup option below.',
      'no_secret',
    );
  }

  const deviceId = await getCurrentDeviceId();
  const verifier = await sha256Hex(manifest.recoverySecret);

  try {
    const result = await httpsCallable<unknown, RecoveryResult>(
      functions,
      'recoverAsNewMainDevice',
    )({ deviceId, verifier });
    return result.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('BACKUP_PROOF_INVALID')) {
      throw new BackupProofError(
        "This backup doesn't match the one on record for your account.",
        'mismatch',
      );
    }
    throw error;
  }
};

/**
 * Recovers with NO backup to verify against.
 *
 * Allowed deliberately. firestore.rules gates chats, expenses and groups on
 * the authenticated uid rather than a live device session, so anyone holding
 * these credentials can already reach that data through the API — refusing
 * would buy no security while stranding a legitimate user out of their own
 * account permanently. The caller makes it effortful (a typed phrase) and
 * states plainly that chat history is not coming back, matching §3.7 point 5's
 * rule that an escape hatch must always exist.
 */
export const recoverWithoutBackup = async (): Promise<RecoveryResult> => {
  const deviceId = await getCurrentDeviceId();
  const result = await httpsCallable<unknown, RecoveryResult>(
    functions,
    'recoverAsNewMainDevice',
  )({ deviceId, acknowledgedNoBackup: true });
  return result.data;
};
