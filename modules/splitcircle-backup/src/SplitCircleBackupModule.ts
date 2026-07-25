import { requireOptionalNativeModule } from 'expo';

export interface BackupHealthRaw {
  isAvailable: boolean;
  reason: string | null;
}

/** Base64-encoded payload — the native side never sees plaintext (doc 31 §3.3/§3.5). */
export interface BackupChunkRaw {
  recordType: string;
  recordId: string;
  payloadBase64: string;
  metadata: Record<string, string>;
}

export interface SplitCircleBackupNativeModule {
  /** Derives the passphrase key; returns the KDF salt. Pass a salt to restore. */
  beginSession(passphrase: string, saltBase64: string | null): Promise<{ salt: string }>;
  /** Opens a session from a raw 32-byte key (Phase 6 handoff). */
  beginSessionWithKey(keyBase64: string): Promise<void>;
  endSession(): Promise<void>;
  hasSession(): Promise<boolean>;
  /** Cheap iCloud-account presence check — see doc 31 §3.6/§3.7. Not a full CloudKit health check until Phase 4. */
  isHealthy(): Promise<BackupHealthRaw>;
  /** Throws SplitCircleBackup.notImplemented until Phase 4's CloudKitBackupProvider lands. */
  backupChunk(
    recordType: string,
    recordId: string,
    payloadBase64: string,
    metadata: Record<string, string>,
  ): Promise<void>;
  restoreChunk(recordType: string, recordId: string): Promise<BackupChunkRaw | null>;
  /** Metadata only, no decryption — Phase 6 handoff bootstrap. */
  restoreChunkMetadata(
    recordType: string,
    recordId: string,
  ): Promise<{ recordId: string; metadata: Record<string, string> } | null>;
  listChunkIds(recordType: string, metadata: Record<string, string>): Promise<string[]>;
  estimateSize(): Promise<number>;
  verifyIntegrity(recordType: string, recordId: string, expectedChecksum: string): Promise<boolean>;
}

export default requireOptionalNativeModule<SplitCircleBackupNativeModule>('SplitCircleBackup');
