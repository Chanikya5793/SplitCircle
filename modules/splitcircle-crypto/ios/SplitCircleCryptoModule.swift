import ExpoModulesCore
import LibSignalClient

/**
 A dedicated, stateless HPKE identity for notification previews.

 The ordinary Signal identity is intentionally Keychain-backed. A Notification
 Service Extension is a separate process, however, and iOS has shown that its
 shared-Keychain visibility can be inconsistent across TestFlight upgrades.
 This key is restricted to the already-provisioned App Group, where the
 extension has deterministic access. It encrypts only the short notification
 preview; it is never used for message envelopes, sessions, signatures, or
 long-lived chat data.
 */
private enum NotificationPreviewIdentity {
  private static let suiteName = "group.com.splitcircle.app"
  private static let storageKey = "splitcircle.notificationPreview.identityKeyPair"
  private static let fileName = "notification-preview-identity.bin"
  private static let installationIdFileName = "notification-preview-installation-id.txt"

  private static func storageURL() -> URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: suiteName)?
      .appendingPathComponent(fileName, isDirectory: false)
  }

  static func installationIdStorageURL() -> URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: suiteName)?
      .appendingPathComponent(installationIdFileName, isDirectory: false)
  }

  private static func persist(_ data: Data, defaults: UserDefaults) {
    // App Group UserDefaults ordinarily propagate across processes, but that
    // propagation is not synchronous. The NSE can be launched by APNs within
    // seconds of this app publishing its public key, so make that path
    // explicit and maintain an atomic file copy as the extension's primary
    // source of truth.
    defaults.set(data, forKey: storageKey)
    defaults.synchronize()

    guard let url = storageURL() else { return }
    do {
      try data.write(to: url, options: .atomic)
      try? FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: url.path
      )
    } catch {
      // The UserDefaults copy above is still a valid compatibility fallback.
    }
  }

  static func publicKey() -> String? {
    guard let defaults = UserDefaults(suiteName: suiteName) else { return nil }
    if let url = storageURL(),
       let data = try? Data(contentsOf: url),
       let existing = try? IdentityKeyPair(bytes: data) {
      return existing.identityKey.serialize().base64EncodedString()
    }

    if let data = defaults.data(forKey: storageKey),
       let existing = try? IdentityKeyPair(bytes: data) {
      // Migration from build 215's defaults-only storage. Preserve the same
      // public key so a sender that already fetched it does not need to wait
      // for another directory refresh.
      persist(data, defaults: defaults)
      return existing.identityKey.serialize().base64EncodedString()
    }

    let created = IdentityKeyPair.generate()
    persist(created.serialize(), defaults: defaults)
    return created.identityKey.serialize().base64EncodedString()
  }
}

/// JS bridge for per-device Signal sessions (doc 31 §3.3, Phase 3).
///
/// Everything runs on ONE serial queue. This is not incidental: a Signal
/// session's ratchet state is rewritten by every encrypt/decrypt, so two
/// concurrent operations on the same session corrupt it — and this repo has
/// already been burned once by exactly this class of bug, where concurrent
/// Foundation Models calls raced the Expo module plumbing and corrupted the
/// Hermes heap (CLAUDE.md's `serializeFm` gotcha). Serializing here is the
/// native-side counterpart of that rule; JS callers get no way to opt out.
///
/// Private key material never crosses this bridge. JS sees only public prekey
/// bundles, ciphertext, and plaintext it already had.
public class SplitCircleCryptoModule: Module {
  private let queue = DispatchQueue(label: "com.splitcircle.app.signal", qos: .userInitiated)
  private var engineStorage: SignalSessionEngine?

  private func engine() throws -> SignalSessionEngine {
    if let existing = engineStorage { return existing }
    let created = try SignalSessionEngine()
    engineStorage = created
    return created
  }

  /// Hops onto the serial queue and rethrows into Expo's promise machinery.
  private func onQueue<T>(_ work: @escaping () throws -> T) throws -> T {
    try queue.sync { try work() }
  }

  public func definition() -> ModuleDefinition {
    Name("SplitCircleCrypto")

    /// Creates this device's identity if absent and records who we are.
    /// `deviceId` is libsignal's SMALL-INTEGER device id (1-127), NOT this
    /// repo's UUID installation id — see SignalSessionEngine's note.
    AsyncFunction("bootstrap") { (userId: String, deviceId: Int) -> [String: Any] in
      try self.onQueue { try self.engine().bootstrap(userId: userId, deviceId: UInt32(deviceId)) }
    }

    AsyncFunction("hasIdentity") { () -> Bool in
      try self.onQueue { try self.engine().hasIdentity }
    }

    /// Returns PUBLIC prekey material for publishing to
    /// `users/{uid}/signalPrekeys/{deviceId}`. Safe to hand to Firestore.
    AsyncFunction("generatePublishableBundle") { (oneTimeCount: Int) -> [String: Any] in
      try self.onQueue { try self.engine().generatePublishableBundle(oneTimeCount: oneTimeCount) }
    }

    AsyncFunction("establishSession") { (userId: String, deviceId: Int, bundle: [String: Any]) in
      try self.onQueue {
        try self.engine().establishSession(userId: userId, deviceId: UInt32(deviceId), bundle: bundle)
      }
    }

    AsyncFunction("hasSession") { (userId: String, deviceId: Int) -> Bool in
      try self.onQueue { try self.engine().hasSession(userId: userId, deviceId: UInt32(deviceId)) }
    }

    /// Plaintext in, `{ type, body }` out — both base64 at the JS boundary so
    /// the envelope survives RTDB/JSON transport unchanged.
    AsyncFunction("encrypt") { (userId: String, deviceId: Int, plaintextBase64: String) -> [String: Any] in
      guard let plaintext = Data(base64Encoded: plaintextBase64) else {
        throw Exception(name: "InvalidArgument", description: "plaintext must be base64")
      }
      return try self.onQueue {
        try self.engine().encrypt(userId: userId, deviceId: UInt32(deviceId), plaintext: plaintext)
      }
    }

    AsyncFunction("decrypt") { (userId: String, deviceId: Int, type: Int, bodyBase64: String) -> String in
      guard let body = Data(base64Encoded: bodyBase64) else {
        throw Exception(name: "InvalidArgument", description: "body must be base64")
      }
      let plaintext: Data
      do {
        plaintext = try self.onQueue {
          try self.engine().decrypt(userId: userId, deviceId: UInt32(deviceId), type: type, body: body)
        }
      } catch SignalError.duplicatedMessage(let detail) {
        // A replay is an expected transport condition, not evidence that the
        // Double Ratchet session is corrupt. Give JS a stable code so its
        // repair policy never tears down a healthy session for this case.
        throw Exception(name: "DuplicateSignalMessage", description: detail)
      }
      return plaintext.base64EncodedString()
    }

    /// Signs bytes with this device's Signal identity key (§3.7 attestation).
    AsyncFunction("signWithIdentity") { (payloadBase64: String) -> String in
      guard let payload = Data(base64Encoded: payloadBase64) else {
        throw Exception(name: "InvalidArgument", description: "payload must be base64")
      }
      return try self.onQueue { try self.engine().signWithIdentity(payload).base64EncodedString() }
    }

    AsyncFunction("verifyWithIdentity") { (payloadBase64: String, signatureBase64: String, identityKey: String) -> Bool in
      guard
        let payload = Data(base64Encoded: payloadBase64),
        let signature = Data(base64Encoded: signatureBase64)
      else {
        throw Exception(name: "InvalidArgument", description: "payload and signature must be base64")
      }
      return try self.onQueue {
        try self.engine().verifyWithIdentity(payload, signature: signature, identityKeyBase64: identityKey)
      }
    }

    AsyncFunction("sealToIdentity") {
      (
        plaintextBase64: String,
        identityKey: String,
        info: String,
        associatedDataBase64: String
      ) -> String in
      guard
        let plaintext = Data(base64Encoded: plaintextBase64),
        let associatedData = Data(base64Encoded: associatedDataBase64)
      else {
        throw Exception(
          name: "InvalidArgument",
          description: "plaintext and associated data must be base64"
        )
      }
      return try self.onQueue {
        try self.engine().sealToIdentity(
          plaintext,
          identityKeyBase64: identityKey,
          info: info,
          associatedData: associatedData
        ).base64EncodedString()
      }
    }

    AsyncFunction("openWithIdentity") {
      (
        ciphertextBase64: String,
        info: String,
        associatedDataBase64: String
      ) -> String in
      guard
        let ciphertext = Data(base64Encoded: ciphertextBase64),
        let associatedData = Data(base64Encoded: associatedDataBase64)
      else {
        throw Exception(
          name: "InvalidArgument",
          description: "ciphertext and associated data must be base64"
        )
      }
      return try self.onQueue {
        try self.engine().openWithIdentity(
          ciphertext,
          info: info,
          associatedData: associatedData
        ).base64EncodedString()
      }
    }

    /// Publishes only the public half of the App-Group preview identity. See
    /// `NotificationPreviewIdentity`: this is a narrow reliability fallback
    /// for the extension, not a replacement for Signal message encryption.
    AsyncFunction("notificationPreviewIdentityKey") { () -> String? in
      NotificationPreviewIdentity.publicKey()
    }

    /**
     Publishes the installation id into the App Group, for the Notification
     Service Extension (doc 36 §4).

     The extension needs it because a preview's associated data is
     `{chatId, deviceId}` — the binding that stops a blob sealed for one device
     opening on another. App Group `UserDefaults` rather than the keychain: this
     is a device identifier, not a secret. It is already sent to the server on
     every push registration and travels in the payload, so protecting it would
     buy nothing while costing a second keychain migration.

     Silently no-ops when the App Group is unavailable — a build without the
     entitlement must keep working, just without decrypted previews.
     */
    Function("publishInstallationId") { (installationId: String) -> Bool in
      guard let defaults = UserDefaults(suiteName: "group.com.splitcircle.app") else {
        return false
      }
      let normalized = installationId.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !normalized.isEmpty else { return false }

      // The Notification Service Extension can be started by APNs before an
      // App-Group UserDefaults write has propagated to its process. Its HPKE
      // associated data includes this id, so an invisible value turns every
      // otherwise-valid sealed preview into the generic fallback. Keep the
      // defaults copy for compatibility, but publish an atomic file as the
      // extension's deterministic source just as we do for its preview key.
      defaults.set(normalized, forKey: "splitcircle.installationId")
      defaults.synchronize()

      guard let url = NotificationPreviewIdentity.installationIdStorageURL() else {
        return true
      }
      do {
        try Data(normalized.utf8).write(to: url, options: .atomic)
        try? FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
          ofItemAtPath: url.path
        )
      } catch {
        // UserDefaults above remains a best-effort compatibility fallback.
      }
      return true
    }

    /// Destroys all Signal state on this device. Called on revocation (§3.7)
    /// and account deletion (doc 28) — stale sessions would otherwise keep
    /// decrypting a revoked peer's ciphertext.
    AsyncFunction("wipe") {
      try self.onQueue { try self.engine().wipe() }
    }

  }
}
