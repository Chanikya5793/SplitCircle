import CloudKit
import ExpoModulesCore
import Foundation

/// Expo module bridge for the backup engine (doc 31 §3.2/§3.5, Phase 4).
///
/// Layering, deliberately: JS decides WHAT to back up and batches it; this
/// module encrypts each chunk under the session passphrase key and handles
/// CloudKit retry/backoff; `CloudKitBackupProvider` does the dumb store I/O.
/// Retry lives HERE rather than in the provider because only this layer can
/// see `CKError` codes, and the provider protocol deliberately stays
/// backend-shaped rather than CloudKit-shaped (a future Drive provider has no
/// concept of `.zoneBusy`).
///
/// The passphrase-derived key never crosses the bridge — JS supplies the
/// passphrase once to open a session, and thereafter only ever sees ciphertext
/// or plaintext it already had.
public class SplitCircleBackupModule: Module {
  private let crypto = BackupCrypto()
  private lazy var provider: BackupProvider = CloudKitBackupProvider()

  /// CloudKit transient failures worth retrying, per §3.2. Anything else
  /// (auth, quota, malformed record) is permanent — retrying only delays a
  /// failure the user needs to see.
  private static func retryDelay(for error: Error, attempt: Int) -> TimeInterval? {
    guard let ckError = error as? CKError else { return nil }

    // CloudKit often states exactly how long to wait; prefer that over a guess.
    if let suggested = ckError.userInfo[CKErrorRetryAfterKey] as? Double {
      return suggested
    }

    switch ckError.code {
    case .zoneBusy, .serviceUnavailable, .requestRateLimited,
         .serverResponseLost, .networkUnavailable, .networkFailure:
      return pow(2.0, Double(attempt)) // 1s, 2s, 4s
    case .limitExceeded:
      // The batch was too large. Backing off cannot help — the caller must
      // split it — so surface it instead of burning retries.
      return nil
    default:
      return nil
    }
  }

  private static let maxAttempts = 4

  private func withRetry<T>(_ operation: @escaping () async throws -> T) async throws -> T {
    var attempt = 0
    while true {
      do {
        return try await operation()
      } catch {
        guard
          attempt < Self.maxAttempts - 1,
          let delay = Self.retryDelay(for: error, attempt: attempt)
        else { throw error }
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        attempt += 1
      }
    }
  }

  public func definition() -> ModuleDefinition {
    Name("SplitCircleBackup")

    /// Derives the backup key and returns the salt, which the caller MUST
    /// persist alongside the backup — without it the backup is permanently
    /// unreadable even with the correct passphrase. Pass `saltBase64` when
    /// restoring.
    AsyncFunction("beginSession") { (passphrase: String, saltBase64: String?) -> [String: Any] in
      let salt = saltBase64.flatMap { Data(base64Encoded: $0) }
      let resolved = try self.crypto.beginSession(passphrase: passphrase, salt: salt)
      return ["salt": resolved.base64EncodedString()]
    }

    /// Opens a session from a raw 32-byte key (Phase 6 history handoff, where
    /// the key arrives over a Signal session rather than from a passphrase).
    AsyncFunction("beginSessionWithKey") { (keyBase64: String) in
      guard let key = Data(base64Encoded: keyBase64) else {
        throw Exception(name: "InvalidArgument", description: "key must be base64")
      }
      try self.crypto.beginSessionWithRawKey(key)
    }

    /// Drops the derived key. Call as soon as a backup/restore finishes.
    AsyncFunction("endSession") {
      self.crypto.endSession()
    }

    AsyncFunction("hasSession") { () -> Bool in
      self.crypto.hasActiveSession
    }

    /// Real CloudKit account status, superseding Phase 0's coarse check:
    /// `ubiquityIdentityToken` only proves SOME iCloud account is signed in and
    /// says nothing about container access, which is what actually matters.
    AsyncFunction("isHealthy") { () async -> [String: Any] in
      let health = await self.provider.isHealthy()
      return ["isAvailable": health.isAvailable, "reason": health.reason ?? NSNull()]
    }

    /// Encrypts, then stores, one chunk. `payloadBase64` is plaintext-to-us
    /// (message content is already Signal ciphertext by §3.3); it is wrapped
    /// under the session key before it ever reaches CloudKit.
    AsyncFunction("backupChunk") { (recordType: String, recordId: String, payloadBase64: String, metadata: [String: String]) async throws -> Void in
      guard let payload = Data(base64Encoded: payloadBase64) else {
        throw Exception(name: "InvalidArgument", description: "payload must be base64")
      }
      let wrapped = try self.crypto.wrap(payload)
      let chunk = BackupChunk(recordType: recordType, recordId: recordId, payload: wrapped, metadata: metadata)
      try await self.withRetry { try await self.provider.backupChunk(chunk) }
    }

    /// Fetches and decrypts one chunk. Returns nil when absent — a normal
    /// restore outcome (an id named by a manifest that was never written),
    /// not an error.
    AsyncFunction("restoreChunk") { (recordType: String, recordId: String) async throws -> [String: Any]? in
      guard let chunk = try await self.withRetry({
        try await self.provider.restoreChunk(recordType: recordType, recordId: recordId)
      }) else { return nil }

      let unwrapped = try self.crypto.unwrap(chunk.payload)
      return [
        "recordType": chunk.recordType,
        "recordId": chunk.recordId,
        "payloadBase64": unwrapped.base64EncodedString(),
        "metadata": chunk.metadata,
      ]
    }

    /// Metadata ONLY — no decryption, so no session is required.
    ///
    /// Phase 6's handoff bootstraps from this: the bundle key arrives as a
    /// Signal envelope carried in a record's metadata, and the receiver cannot
    /// decrypt that record's payload until it has read and opened that
    /// envelope. Fetching the payload first would be circular.
    AsyncFunction("restoreChunkMetadata") { (recordType: String, recordId: String) async throws -> [String: Any]? in
      guard let chunk = try await self.withRetry({
        try await self.provider.restoreChunk(recordType: recordType, recordId: recordId)
      }) else { return nil }
      return ["recordId": chunk.recordId, "metadata": chunk.metadata]
    }

    AsyncFunction("listChunkIds") { (recordType: String, metadata: [String: String]) async throws -> [String] in
      try await self.withRetry {
        try await self.provider.listChunkIds(recordType: recordType, metadata: metadata)
      }
    }

    AsyncFunction("estimateSize") { () async throws -> Int in
      Int(try await self.provider.estimateSize())
    }



    AsyncFunction("verifyIntegrity") { (recordType: String, recordId: String, expectedChecksum: String) async throws -> Bool in
      try await self.withRetry {
        try await self.provider.verifyIntegrity(
          recordType: recordType,
          recordId: recordId,
          expectedChecksum: expectedChecksum
        )
      }
    }
  }
}
