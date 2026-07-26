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
import { readBackupManifest, readBackupSummary, type BackupSummary } from '@/services/backupService';
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
export type { BackupSummary };

export const publishRecoveryVerifier = async (recoverySecret: string): Promise<void> => {
  try {
    const verifier = await sha256Hex(recoverySecret);
    await httpsCallable(functions, 'setBackupRecoveryVerifier')({ verifier });
  } catch (error) {
    console.warn('Could not publish the backup recovery verifier', error);
  }
};

/** Whether this account has a backup that recovery could verify against. */
/**
 * Whether a backup exists, plus what's in it — answered from iCloud FIRST.
 *
 * The summary rides in the manifest record's CloudKit metadata, which our
 * passphrase layer does not wrap, so `restoreChunkMetadata` reads it with no
 * session and no passphrase (verified: the native function skips decryption
 * entirely — Phase 6's handoff already bootstraps from that same property).
 * A phone that has just signed in can therefore show what a restore would
 * bring back before the user types anything.
 *
 * iCloud is the PRIMARY source deliberately, not a fallback. This is the
 * user's own data sitting in the user's own storage, so nothing about their
 * message counts needs to reach our servers — which also means this screen
 * keeps working as the app moves off Firebase.
 *
 * The server is consulted only as a secondary signal, for the case where the
 * summary is unreadable (no iCloud on this device, or a backup written before
 * summaries existed). The recovery VERIFIER stays server-side regardless: it
 * has to be tamper-proof and unreadable by the client, which is exactly what
 * iCloud storage cannot provide.
 */
export const hasRecoverableBackup = async (): Promise<{
  hasBackup: boolean;
  summary: BackupSummary | null;
}> => {
  const summary = await readBackupSummary().catch(() => null);
  // A summary we could actually read IS the backup — no second opinion needed.
  if (summary) return { hasBackup: true, summary };

  try {
    const result = await httpsCallable<unknown, { hasBackup: boolean }>(
      functions,
      'hasBackupRecovery',
    )({});
    return { hasBackup: result.data.hasBackup === true, summary: null };
  } catch {
    return { hasBackup: false, summary: null };
  }
};

export interface RecoveryResult {
  revokedDeviceIds: string[];
  demotedDeviceIds: string[];
  backupVerified: boolean;
}

/**
 * Recovers this device as the new main using the backup passphrase.
 *
 * Reads and DECRYPTS the manifest locally first — that is what makes the
 * passphrase a real factor rather than a string the server takes on trust.
 */
export const recoverWithPassphrase = async (
  passphrase: string,
  keepOtherDevices = false,
): Promise<RecoveryResult> => {
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
    )({ deviceId, verifier, keepOtherDevices });
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
export const recoverWithoutBackup = async (keepOtherDevices = false): Promise<RecoveryResult> => {
  const deviceId = await getCurrentDeviceId();
  const result = await httpsCallable<unknown, RecoveryResult>(
    functions,
    'recoverAsNewMainDevice',
  )({ deviceId, acknowledgedNoBackup: true, keepOtherDevices });
  return result.data;
};
