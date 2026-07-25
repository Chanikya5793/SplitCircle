/**
 * splitcircle-backup — iCloud (CloudKit) chat backup/restore (doc 31 §3.2).
 *
 * Phase 0 shell: only `isHealthy()` does anything real. Every mutating
 * function throws until Phase 4's CloudKitBackupProvider lands — deliberately
 * NOT silently swallowed like `redactPII`'s JS fallback, because a backup
 * failure that looks like success is exactly the class of bug doc 31 §3.7's
 * device-retirement gate exists to prevent. Callers must handle rejection.
 */

import NativeModule, { type BackupChunkRaw, type BackupHealthRaw } from './src/SplitCircleBackupModule';

export type { BackupChunkRaw, BackupHealthRaw };

/**
 * Coarse iCloud-account presence check. Safe to call even when the native
 * module isn't linked yet (stale dev build) — degrades to "unavailable"
 * rather than throwing, since this backs a passive status banner
 * (doc 31 §3.6), not a mutating action.
 */
export async function isBackupHealthy(): Promise<BackupHealthRaw> {
  if (!NativeModule) {
    return { isAvailable: false, reason: 'native_module_unavailable' };
  }
  try {
    return await NativeModule.isHealthy();
  } catch (error) {
    return { isAvailable: false, reason: error instanceof Error ? error.message : 'unknown_error' };
  }
}

const requireModule = () => {
  if (!NativeModule) {
    throw new Error('SplitCircleBackup native module is not available on this platform/build');
  }
  return NativeModule;
};

/**
 * Derives the backup key from a passphrase (doc 31 §3.5) and returns the KDF
 * salt. PERSIST THE SALT with the backup — without it the backup cannot be
 * opened again even with the correct passphrase. Pass `saltBase64` when
 * restoring an existing backup.
 *
 * Derivation is intentionally expensive, so this is called ONCE per
 * backup/restore run, never per chunk.
 */
export async function beginBackupSession(
  passphrase: string,
  saltBase64?: string,
): Promise<{ salt: string }> {
  return requireModule().beginSession(passphrase, saltBase64 ?? null);
}

/** Drops the derived key. Always call when a run finishes, including on failure. */
export async function endBackupSession(): Promise<void> {
  return requireModule().endSession();
}

export async function hasBackupSession(): Promise<boolean> {
  return requireModule().hasSession();
}

export async function backupChunk(
  recordType: string,
  recordId: string,
  payloadBase64: string,
  metadata: Record<string, string>,
): Promise<void> {
  return requireModule().backupChunk(recordType, recordId, payloadBase64, metadata);
}

export async function restoreChunk(
  recordType: string,
  recordId: string,
): Promise<BackupChunkRaw | null> {
  return requireModule().restoreChunk(recordType, recordId);
}

export async function listChunkIds(
  recordType: string,
  metadata: Record<string, string>,
): Promise<string[]> {
  return requireModule().listChunkIds(recordType, metadata);
}

export async function estimateBackupSize(): Promise<number> {
  return requireModule().estimateSize();
}

export async function verifyBackupIntegrity(
  recordType: string,
  recordId: string,
  expectedChecksum: string,
): Promise<boolean> {
  return requireModule().verifyIntegrity(recordType, recordId, expectedChecksum);
}
