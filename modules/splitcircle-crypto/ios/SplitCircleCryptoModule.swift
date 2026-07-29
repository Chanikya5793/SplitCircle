import ExpoModulesCore
import LibSignalClient

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

    /// Destroys all Signal state on this device. Called on revocation (§3.7)
    /// and account deletion (doc 28) — stale sessions would otherwise keep
    /// decrypting a revoked peer's ciphertext.
    AsyncFunction("wipe") {
      try self.onQueue { try self.engine().wipe() }
    }

  }
}
