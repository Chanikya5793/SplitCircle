import CloudKit
import Foundation

/// The v1 `BackupProvider` (doc 31 §3.2, Phase 4).
///
/// Deliberately raw `CKModifyRecordsOperation` / `CKQueryOperation` rather than
/// `CKSyncEngine`: this is one-shot bulk export from the main device and
/// one-shot bulk import on a new/promoted main device, never continuous
/// bidirectional sync, so CKSyncEngine's batch-acknowledgement-ordering
/// instability (§2.4) is a risk there is no reason to take on. Don't "modernise"
/// this to CKSyncEngine without re-deriving that reasoning.
///
/// Private database, default zone: only the main device ever writes, so there
/// is no multi-writer conflict resolution to model.
///
/// Payloads are opaque ciphertext by the time they arrive here (§3.3 Signal
/// encryption, then §3.5's passphrase-derived wrapping). This type never sees
/// plaintext and must never try to interpret a payload.
public final class CloudKitBackupProvider: BackupProvider {
  /// Matches the container that must exist on the App ID. If this string and
  /// the provisioned container ever disagree, every operation fails at runtime
  /// with a container-not-found error rather than anything more descriptive.
  public static let containerIdentifier = "iCloud.com.splitcircle.app"

  private let database: CKDatabase
  private let container: CKContainer

  /// Payload field name. Stored as `CKAsset` above the inline threshold —
  /// CloudKit rejects records whose non-asset fields exceed ~1MB, and a media
  /// chunk (§3.2, decision #10) is routinely larger than that.
  private static let payloadField = "payload"
  private static let assetField = "payloadAsset"
  private static let checksumField = "checksum"
  private static let metadataField = "metadata"

  /// Stay well under CloudKit's ~1MB per-record non-asset ceiling; anything at
  /// or above this goes to a CKAsset instead.
  private static let inlinePayloadLimit = 512 * 1024

  public init(containerIdentifier: String = CloudKitBackupProvider.containerIdentifier) {
    self.container = CKContainer(identifier: containerIdentifier)
    self.database = container.privateCloudDatabase
  }

  // MARK: - Write

  public func backupChunk(_ chunk: BackupChunk) async throws {
    let recordID = CKRecord.ID(recordName: chunk.recordId)
    let record = CKRecord(recordType: chunk.recordType, recordID: recordID)

    // Checksum is computed here, over the exact bytes we persist, so
    // verifyIntegrity can later re-derive it from the STORE rather than
    // trusting a caller-supplied value (§3.7 point 3 — otherwise the
    // device-retirement gate is gameable).
    record[Self.checksumField] = Self.checksum(of: chunk.payload) as CKRecordValue

    if !chunk.metadata.isEmpty,
       let metadataData = try? JSONSerialization.data(withJSONObject: chunk.metadata) {
      record[Self.metadataField] = String(data: metadataData, encoding: .utf8) as CKRecordValue?
    }

    var temporaryAssetURL: URL?
    if chunk.payload.count >= Self.inlinePayloadLimit {
      let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("backup-\(chunk.recordId)-\(UUID().uuidString)")
      try chunk.payload.write(to: url, options: .atomic)
      temporaryAssetURL = url
      record[Self.assetField] = CKAsset(fileURL: url)
    } else {
      record[Self.payloadField] = chunk.payload as CKRecordValue
    }

    defer {
      // CloudKit copies the asset during upload; the temp file is ours to
      // clean up, and leaving them accumulates unbounded across a bulk export.
      if let url = temporaryAssetURL {
        try? FileManager.default.removeItem(at: url)
      }
    }

    // .allKeys: a re-run of a backup must overwrite the previous version of
    // the same record rather than fail on an existing-record conflict — the
    // main device is the sole writer, so its copy is authoritative by
    // definition.
    try await save(record, savePolicy: .allKeys)
  }

  private func save(_ record: CKRecord, savePolicy: CKModifyRecordsOperation.RecordSavePolicy) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let operation = CKModifyRecordsOperation(recordsToSave: [record], recordIDsToDelete: nil)
      operation.savePolicy = savePolicy
      // Backup is explicitly background work and must not compete with
      // interactive traffic; §3.6 schedules it opportunistically.
      operation.qualityOfService = .utility
      operation.modifyRecordsResultBlock = { result in
        switch result {
        case .success:
          continuation.resume()
        case .failure(let error):
          continuation.resume(throwing: error)
        }
      }
      database.add(operation)
    }
  }

  // MARK: - Read

  public func restoreChunk(recordType: String, recordId: String) async throws -> BackupChunk? {
    let recordID = CKRecord.ID(recordName: recordId)
    do {
      let record = try await database.record(for: recordID)
      guard let payload = try Self.payload(from: record) else { return nil }
      return BackupChunk(
        recordType: record.recordType,
        recordId: record.recordID.recordName,
        payload: payload,
        metadata: Self.metadata(from: record)
      )
    } catch let error as CKError where error.code == .unknownItem {
      // Absent is a normal restore outcome (a chunk id from a manifest that
      // was never written), not an error worth propagating.
      return nil
    }
  }

  public func listChunkIds(recordType: String, metadata: [String: String]) async throws -> [String] {
    // TRUEPREDICATE: every record of this type in our own private database.
    // Filtering is done client-side on the returned ids because CloudKit
    // requires an explicitly-indexed field for any queryable predicate, and
    // the schema here is deliberately opaque (payload + checksum only).
    let query = CKQuery(recordType: recordType, predicate: NSPredicate(value: true))
    var ids: [String] = []
    var cursor: CKQueryOperation.Cursor?

    repeat {
      let (matches, nextCursor) = try await runQuery(query, cursor: cursor)
      for (recordID, result) in matches {
        // A per-record failure inside a page must not abandon the whole
        // listing — restore can still proceed with the chunks that do load.
        if case .success = result {
          ids.append(recordID.recordName)
        }
      }
      cursor = nextCursor
    } while cursor != nil

    return ids
  }

  private func runQuery(
    _ query: CKQuery,
    cursor: CKQueryOperation.Cursor?
  ) async throws -> ([(CKRecord.ID, Result<CKRecord, Error>)], CKQueryOperation.Cursor?) {
    try await withCheckedThrowingContinuation { continuation in
      let operation = cursor.map { CKQueryOperation(cursor: $0) } ?? CKQueryOperation(query: query)
      operation.qualityOfService = .utility
      // Ids only — pulling full payloads here would download the entire
      // backup just to enumerate it.
      operation.desiredKeys = []

      var matches: [(CKRecord.ID, Result<CKRecord, Error>)] = []
      operation.recordMatchedBlock = { recordID, result in
        matches.append((recordID, result))
      }
      operation.queryResultBlock = { result in
        switch result {
        case .success(let nextCursor):
          continuation.resume(returning: (matches, nextCursor))
        case .failure(let error):
          continuation.resume(throwing: error)
        }
      }
      database.add(operation)
    }
  }

  // MARK: - Health / size / integrity

  public func isHealthy() async -> BackupHealth {
    do {
      let status = try await container.accountStatus()
      switch status {
      case .available:
        return BackupHealth(isAvailable: true)
      case .noAccount:
        return BackupHealth(isAvailable: false, reason: "No iCloud account is signed in on this device.")
      case .restricted:
        return BackupHealth(isAvailable: false, reason: "iCloud is restricted on this device.")
      case .couldNotDetermine:
        return BackupHealth(isAvailable: false, reason: "Could not determine iCloud account status.")
      case .temporarilyUnavailable:
        return BackupHealth(isAvailable: false, reason: "iCloud is temporarily unavailable.")
      @unknown default:
        return BackupHealth(isAvailable: false, reason: "Unrecognized iCloud account status.")
      }
    } catch {
      return BackupHealth(isAvailable: false, reason: error.localizedDescription)
    }
  }

  public func estimateSize() async throws -> Int64 {
    // CloudKit exposes no per-container usage API, so this is derived from what
    // we wrote rather than what Apple reports. It exists for the quota-risk UX
    // (§2.4: private-DB usage counts against the user's personal iCloud quota
    // with no platform-level warning), so an approximation from our own records
    // is both the best available and sufficient.
    var total: Int64 = 0
    for recordType in ["message", "media", "callHistory", "manifest"] {
      let ids = (try? await listChunkIds(recordType: recordType, metadata: [:])) ?? []
      for id in ids {
        if let chunk = try? await restoreChunk(recordType: recordType, recordId: id) {
          total += Int64(chunk.payload.count)
        }
      }
    }
    return total
  }

  public func verifyIntegrity(
    recordType: String,
    recordId: String,
    expectedChecksum: String
  ) async throws -> Bool {
    // Re-derives from the STORE's bytes, never echoing expectedChecksum back
    // (§3.7 point 3): the retirement gate's whole value is that it can prove a
    // backup is real, so a provider that trusts the caller makes it gameable.
    guard let chunk = try await restoreChunk(recordType: recordType, recordId: recordId) else {
      return false
    }
    return Self.checksum(of: chunk.payload) == expectedChecksum
  }

  // MARK: - Helpers

  private static func payload(from record: CKRecord) throws -> Data? {
    if let data = record[payloadField] as? Data {
      return data
    }
    if let asset = record[assetField] as? CKAsset, let url = asset.fileURL {
      return try Data(contentsOf: url)
    }
    return nil
  }

  private static func metadata(from record: CKRecord) -> [String: String] {
    guard
      let raw = record[metadataField] as? String,
      let data = raw.data(using: .utf8),
      let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: String]
    else { return [:] }
    return parsed
  }

  /// FNV-1a over the payload. Not a security primitive — integrity here is
  /// already guaranteed cryptographically by the AEAD wrapping in §3.5; this
  /// only needs to detect truncation/corruption of a stored record cheaply,
  /// including for multi-hundred-MB media assets.
  private static func checksum(of data: Data) -> String {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in data {
      hash ^= UInt64(byte)
      hash = hash &* 0x1000_0000_01b3
    }
    return String(format: "%016llx", hash)
  }
}
