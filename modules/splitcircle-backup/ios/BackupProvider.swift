import Foundation

/// A chunk of already-encrypted backup data ready to persist, or freshly
/// fetched from the backup store during restore. Payload is always opaque
/// ciphertext by the time it reaches a BackupProvider — see doc 31 §3.3/§3.5
/// (Signal-encrypted content, further wrapped under a passphrase-derived key
/// before it ever reaches this layer). A provider never needs to understand
/// what's inside.
public struct BackupChunk {
  public let recordType: String // e.g. "message", "media", "callHistory", "manifest"
  public let recordId: String
  public let payload: Data
  /// Small, non-sensitive fields a provider may need to route/paginate
  /// (e.g. chatId, sequence index) — never message content.
  public let metadata: [String: String]

  public init(recordType: String, recordId: String, payload: Data, metadata: [String: String] = [:]) {
    self.recordType = recordType
    self.recordId = recordId
    self.payload = payload
    self.metadata = metadata
  }
}

public struct BackupHealth {
  public let isAvailable: Bool
  /// Human-readable, surfaced to the "iCloud unavailable" banner (doc 31 §3.6).
  public let reason: String?

  public init(isAvailable: Bool, reason: String? = nil) {
    self.isAvailable = isAvailable
    self.reason = reason
  }
}

/// A provider-agnostic backup/restore backend (doc 31 §3.2). CloudKitBackupProvider
/// (Phase 4) is the only v1 implementation; a future GoogleDriveBackupProvider
/// (Android, doc 31 decision #1) or a web-client provider (decision #3) plugs
/// in here without any call site elsewhere in the app needing to change.
///
/// Deliberately NOT modeled after CKSyncEngine's continuous-bidirectional-sync
/// shape — SplitCircle's backup/restore is one-shot bulk export (main device
/// only) and one-shot bulk import (new/promoted main device only, once), so a
/// provider only needs simple chunked write/read, not live sync semantics.
/// See doc 31 §2.4 and §3.10 gotcha #1 for why CKSyncEngine was deliberately
/// avoided — don't "upgrade" to it later without re-deriving that reasoning.
public protocol BackupProvider {
  /// Write one chunk (already Signal + passphrase encrypted by the caller —
  /// this protocol never sees plaintext). Throws on failure; the caller is
  /// responsible for retry/backoff (doc 31 §3.2's ~200-record chunking with
  /// backoff on transient errors lives at the call site, not here).
  func backupChunk(_ chunk: BackupChunk) async throws

  /// Fetch one chunk by type + id during restore. Returns nil if not found.
  func restoreChunk(recordType: String, recordId: String) async throws -> BackupChunk?

  /// List available chunk ids for a record type (e.g. every message-batch id
  /// for a chat), used to drive restore pagination.
  func listChunkIds(recordType: String, metadata: [String: String]) async throws -> [String]

  /// True if the backup store is currently reachable/usable at all — the
  /// mechanical check behind doc 31 §3.6's "iCloud unavailable" banner and
  /// §3.7's device-retirement gate. Never throws; failures fold into
  /// `BackupHealth.isAvailable == false` with a reason.
  func isHealthy() async -> BackupHealth

  /// Best-effort size estimate for the current backup (for quota-risk UX —
  /// doc 31 §2.4: CloudKit private-DB usage counts against the user's own
  /// personal iCloud quota, with no default warning built into the platform).
  func estimateSize() async throws -> Int64

  /// Re-derives a record's integrity directly from the STORE side, for the
  /// device-retirement gate (doc 31 §3.7). Must actually verify against what
  /// the store holds, never just echo back the caller-supplied
  /// `expectedChecksum` — a provider that does the latter makes the
  /// retirement gate gameable (doc 31 §3.7 point 3 / §5 Phase 7).
  func verifyIntegrity(recordType: String, recordId: String, expectedChecksum: String) async throws -> Bool
}
