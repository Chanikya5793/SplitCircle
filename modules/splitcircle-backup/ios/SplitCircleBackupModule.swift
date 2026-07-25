import ExpoModulesCore
import Foundation

/// Expo module bridge for BackupProvider (doc 31 §3.2). Phase 0 shell only —
/// no CloudKit calls yet (that's Phase 4's CloudKitBackupProvider.swift,
/// which will conform to BackupProvider and back the functions below).
/// `isHealthy` is the one exception: it's a real, cheap, CloudKit-free check
/// (`FileManager.ubiquityIdentityToken`, not a CloudKit API call) so the
/// "iCloud unavailable" banner (doc 31 §3.6) has something real to read even
/// before Phase 4 lands.
public class SplitCircleBackupModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SplitCircleBackup")

    AsyncFunction("isHealthy") { () -> [String: Any] in
      // A non-nil ubiquityIdentityToken means SOME iCloud account is signed
      // in on this device — it does NOT confirm CloudKit container access,
      // iCloud Drive being enabled for this app, or available quota. Phase 4
      // must layer real CKContainer.accountStatus/accountNotDetermined-style
      // checks on top of this; treat this as a fast, coarse pre-check only.
      if FileManager.default.ubiquityIdentityToken != nil {
        return ["isAvailable": true, "reason": NSNull()]
      }
      return ["isAvailable": false, "reason": "not_signed_into_icloud"]
    }

    AsyncFunction("backupChunk") { (_ recordType: String, _ recordId: String, _ payloadBase64: String, _ metadata: [String: String]) async throws -> Void in
      throw SplitCircleBackupNotImplementedException()
    }

    AsyncFunction("restoreChunk") { (_ recordType: String, _ recordId: String) async throws -> [String: Any]? in
      throw SplitCircleBackupNotImplementedException()
    }

    AsyncFunction("listChunkIds") { (_ recordType: String, _ metadata: [String: String]) async throws -> [String] in
      throw SplitCircleBackupNotImplementedException()
    }

    AsyncFunction("estimateSize") { () async throws -> Int in
      throw SplitCircleBackupNotImplementedException()
    }

    AsyncFunction("verifyIntegrity") { (_ recordType: String, _ recordId: String, _ expectedChecksum: String) async throws -> Bool in
      throw SplitCircleBackupNotImplementedException()
    }
  }
}

internal final class SplitCircleBackupNotImplementedException: Exception {
  override var reason: String {
    "SplitCircleBackup: CloudKit backend not implemented yet (doc 31 Phase 4)"
  }
}
