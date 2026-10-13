/**
 * splitcircle-backup — iCloud (CloudKit) chat backup/restore (doc 31 §3.2).
 *
 * Mutating functions reject rather than no-op when CloudKit is unreachable:
 * a backup failure that looks like success is exactly the class of bug doc 31
 * §3.7's device-retirement gate exists to prevent. Callers must handle it.
 */

import * as Device from 'expo-device';
import NativeModule, { type BackupChunkRaw, type BackupHealthRaw } from './src/SplitCircleBackupModule';

export type { BackupChunkRaw, BackupHealthRaw };

/**
 * CloudKit is UNREACHABLE on a simulator and taking the process down is how it
 * says so.
 *
 * `CloudKitBackupProvider` builds its `CKContainer(identifier:)` eagerly in a
 * lazy var, and CKContainer TRAPS (EXC_BREAKPOINT / SIGTRAP) when the running
 * binary has no matching iCloud entitlement — which is always true of a
 * simulator build, and also true of any device build whose provisioning lost
 * the container. A trap is not an exception: the try/catch in isBackupHealthy
 * below cannot see it, and neither can any JS handler, so the whole app dies
 * instead of showing "backup unavailable".
 *
 * Same shape as the PrivateCloudCompute simulator crash in CLAUDE.md, and the
 * same answer: do not construct the native object at all where it cannot work.
 */
const CLOUDKIT_REACHABLE = Device.isDevice;

/**
 * Coarse iCloud-account presence check. Safe to call even when the native
 * module isn't linked yet (stale dev build) — degrades to "unavailable"
 * rather than throwing, since this backs a passive status banner
 * (doc 31 §3.6), not a mutating action.
 */
export async function isBackupHealthy(): Promise<BackupHealthRaw> {
  if (!CLOUDKIT_REACHABLE) {
    return { isAvailable: false, reason: 'simulator_no_icloud' };
  }
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
  // Reject BEFORE reaching native: every mutating call routes through the same
  // provider getter that traps, so letting one through kills the process.
  if (!CLOUDKIT_REACHABLE) {
    throw new Error('iCloud backup is unavailable on the simulator');
  }
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

/**
 * Opens a session from a raw 32-byte key rather than a passphrase — doc 31
 * Phase 6's history handoff, where the key is random and delivered over a
 * Signal session, so there is nothing to stretch.
 */
export async function beginBackupSessionWithKey(keyBase64: string): Promise<void> {
  return requireModule().beginSessionWithKey(keyBase64);
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

/**
 * Reads a record's metadata WITHOUT decrypting its payload, so no session is
 * needed. Phase 6's handoff bootstraps from this — the bundle key travels as a
 * Signal envelope in metadata, and the payload cannot be opened until that
 * envelope has been read.
 */
export async function restoreChunkMetadata(
  recordType: string,
  recordId: string,
): Promise<{ recordId: string; metadata: Record<string, string> } | null> {
  return requireModule().restoreChunkMetadata(recordType, recordId);
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

/**
 * The native module holds ONE encryption session. Backup, restore, verify and
 * the pairing history handoff each open it, use it, and close it — so two of
 * them interleaving would encrypt one's chunks under the other's key, or close
 * the session out from under it. Every begin…end sequence runs through here,
 * one at a time.
 */
let sessionQueue: Promise<unknown> = Promise.resolve();
export function runExclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = sessionQueue.then(work, work);
  sessionQueue = run.catch(() => undefined);
  return run;
}

/** Whether this binary has the native file functions (added with backup v2). */
export const hasNativeFileTransfer = (): boolean =>
  CLOUDKIT_REACHABLE && typeof NativeModule?.backupFile === 'function';

export async function backupFile(
  recordType: string,
  recordId: string,
  filePath: string,
  metadata: Record<string, string>,
): Promise<number> {
  const mod = requireModule();
  if (!mod.backupFile) throw new Error('This build cannot back up files natively');
  return mod.backupFile(recordType, recordId, filePath, metadata);
}

export async function restoreFile(
  recordType: string,
  recordId: string,
  destinationPath: string,
): Promise<{ metadata: Record<string, string>; bytes: number } | null> {
  const mod = requireModule();
  if (!mod.restoreFile) throw new Error('This build cannot restore files natively');
  return mod.restoreFile(recordType, recordId, destinationPath);
}

/** Best effort: older binaries without the function simply keep the records. */
export async function deleteRecords(recordIds: string[]): Promise<void> {
  if (recordIds.length === 0) return;
  const mod = requireModule();
  if (!mod.deleteRecords) return;
  await mod.deleteRecords(recordIds);
}
