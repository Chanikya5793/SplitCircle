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
  /** CloudKit account status for this app's container. */
  isHealthy(): Promise<BackupHealthRaw>;
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
  /** Encrypts + stores a file read natively (no base64 bridge). Returns plaintext bytes. */
  backupFile?(
    recordType: string,
    recordId: string,
    filePath: string,
    metadata: Record<string, string>,
  ): Promise<number>;
  /** Fetches + decrypts a record straight to a file. Null when absent. */
  restoreFile?(
    recordType: string,
    recordId: string,
    destinationPath: string,
  ): Promise<{ metadata: Record<string, string>; bytes: number } | null>;
  /** Deletes records by id; missing ids are fine. */
  deleteRecords?(recordIds: string[]): Promise<void>;
  estimateSize(): Promise<number>;
  verifyIntegrity(recordType: string, recordId: string, expectedChecksum: string): Promise<boolean>;
}

export default requireOptionalNativeModule<SplitCircleBackupNativeModule>('SplitCircleBackup');
