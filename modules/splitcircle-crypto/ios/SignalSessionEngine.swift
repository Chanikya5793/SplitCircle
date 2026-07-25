import Foundation
import LibSignalClient

/// Key management + session operations for per-device Signal sessions
/// (doc 31 §3.3). This is the layer the JS bridge calls; it owns key
/// generation, prekey-bundle publishing, session establishment, and
/// encrypt/decrypt. Storage lives in `SplitCircleSignalStore`.
///
/// Address model (§3.3 + the spike's protocol-design finding): libsignal's
/// `ProtocolAddress` is `(name, deviceId)` where deviceId is a SMALL INTEGER
/// (libsignal's own `DeviceId` is Int8-backed, 1-127). That is NOT this repo's
/// existing UUID-string deviceId used by `pairedDevices`/`notificationDevices`/
/// RTDB. The small integer is minted per user at pairing time and stored
/// alongside — never replacing — the UUID. `name` is the Firebase uid.
enum SignalEngineError: Error, LocalizedError {
  case notBootstrapped
  case malformedBundle(String)
  case unsupportedCiphertextType(Int)

  var errorDescription: String? {
    switch self {
    case .notBootstrapped:
      return "Signal engine used before bootstrap(userId:deviceId:)"
    case .malformedBundle(let field):
      return "Malformed prekey bundle: \(field)"
    case .unsupportedCiphertextType(let raw):
      return "Unsupported ciphertext type \(raw)"
    }
  }
}

final class SignalSessionEngine {
  private let store: SplitCircleSignalStore
  private let meta: SignalBlobStore
  private let context = SignalContext()

  private static let localUserKey = "localUserId"
  private static let localDeviceKey = "localDeviceId"
  private static let keyCounterKey = "keyIdCounter"

  init() throws {
    self.store = try SplitCircleSignalStore()
    self.meta = try SignalBlobStore(namespace: "meta")
  }

  // MARK: - Bootstrap

  private var localAddress: ProtocolAddress? {
    guard
      let userData = meta.get(Self.localUserKey),
      let userId = String(data: userData, encoding: .utf8),
      let deviceData = meta.get(Self.localDeviceKey),
      let deviceString = String(data: deviceData, encoding: .utf8),
      let deviceId = UInt32(deviceString)
    else { return nil }
    return try? ProtocolAddress(name: userId, deviceId: deviceId)
  }

  /// Creates the device identity if needed and records who we are. Idempotent —
  /// safe to call on every app start.
  @discardableResult
  func bootstrap(userId: String, deviceId: UInt32) throws -> [String: Any] {
    let (identity, registrationId) = try store.ensureIdentity()
    try meta.set(Data(userId.utf8), for: Self.localUserKey)
    try meta.set(Data(String(deviceId).utf8), for: Self.localDeviceKey)
    return [
      "registrationId": registrationId,
      "identityKey": identity.identityKey.serialize().base64EncodedString(),
      "deviceId": deviceId,
    ]
  }

  var hasIdentity: Bool { store.hasIdentity }

  func wipe() throws {
    try store.wipe()
    meta.removeAll()
  }

  // MARK: - Key ids

  /// Monotonic id source for prekeys. Kept below 2^24 because libsignal treats
  /// prekey ids as u32 but Signal's own convention keeps them well under that;
  /// wrapping is safe here because ids are only ever compared to what we
  /// ourselves published.
  private func nextKeyId() throws -> UInt32 {
    let current: UInt32
    if let data = meta.get(Self.keyCounterKey), data.count == 4 {
      current = data.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
    } else {
      current = 1
    }
    let next = current >= 0xFF_FFFF ? 1 : current + 1
    var nextLE = next.littleEndian
    try meta.set(Data(bytes: &nextLE, count: 4), for: Self.keyCounterKey)
    return current
  }

  // MARK: - Prekey publishing

  /// Generates and persists this device's prekeys, returning ONLY public
  /// material — this is what gets written to `users/{uid}/signalPrekeys/{deviceId}`
  /// (§3.3). Private halves never leave the Keychain/blob store, so this return
  /// value is safe to hand to Firestore.
  func generatePublishableBundle(oneTimeCount: Int) throws -> [String: Any] {
    let (identity, registrationId) = try store.ensureIdentity()

    // Signed prekey: classic X25519, signed by the identity key so peers can
    // verify it really came from us.
    let signedPreKeyId = try nextKeyId()
    let signedPrivate = PrivateKey.generate()
    let signedPublic = signedPrivate.publicKey
    let signedSignature = identity.privateKey.generateSignature(message: signedPublic.serialize())
    let timestamp = UInt64(Date().timeIntervalSince1970 * 1000)
    let signedRecord = try SignedPreKeyRecord(
      id: signedPreKeyId,
      timestamp: timestamp,
      privateKey: signedPrivate,
      signature: signedSignature
    )
    try store.storeSignedPreKey(signedRecord, id: signedPreKeyId, context: context)

    // Kyber prekey: MANDATORY. PreKeyBundle's initializers in this version all
    // require the post-quantum fields — there is no classic-X3DH-only path
    // (verified against libsignal's real source during the Phase 3 spike).
    let kyberPreKeyId = try nextKeyId()
    let kyberPair = KEMKeyPair.generate()
    let kyberSignature = identity.privateKey.generateSignature(message: kyberPair.publicKey.serialize())
    let kyberRecord = try KyberPreKeyRecord(
      id: kyberPreKeyId,
      timestamp: timestamp,
      keyPair: kyberPair,
      signature: kyberSignature
    )
    try store.storeKyberPreKey(kyberRecord, id: kyberPreKeyId, context: context)

    // One-time prekeys: consumed on use (the store deletes them), so a device
    // that runs out falls back to the signed prekey — weaker forward secrecy
    // for that one handshake, which is why these get replenished.
    var oneTime: [[String: Any]] = []
    for _ in 0..<max(0, oneTimeCount) {
      let id = try nextKeyId()
      let priv = PrivateKey.generate()
      let record = try PreKeyRecord(id: id, privateKey: priv)
      try store.storePreKey(record, id: id, context: context)
      oneTime.append([
        "keyId": id,
        "publicKey": priv.publicKey.serialize().base64EncodedString(),
      ])
    }

    return [
      "registrationId": registrationId,
      "identityKey": identity.identityKey.serialize().base64EncodedString(),
      "signedPreKeyId": signedPreKeyId,
      "signedPreKeyPublic": signedPublic.serialize().base64EncodedString(),
      "signedPreKeySignature": signedSignature.base64EncodedString(),
      "kyberPreKeyId": kyberPreKeyId,
      "kyberPreKeyPublic": kyberPair.publicKey.serialize().base64EncodedString(),
      "kyberPreKeySignature": kyberSignature.base64EncodedString(),
      "oneTimePreKeys": oneTime,
    ]
  }

  // MARK: - Session establishment

  /// Builds a session against a peer device from its published bundle.
  /// `bundle` is the Firestore document produced by
  /// `generatePublishableBundle` on the peer.
  func establishSession(userId: String, deviceId: UInt32, bundle: [String: Any]) throws {
    func b64(_ key: String) throws -> Data {
      guard let s = bundle[key] as? String, let d = Data(base64Encoded: s) else {
        throw SignalEngineError.malformedBundle(key)
      }
      return d
    }
    func u32(_ key: String) throws -> UInt32 {
      // JS numbers arrive as Int/Double depending on the bridge; accept both
      // rather than failing on a value that is perfectly valid.
      if let v = bundle[key] as? UInt32 { return v }
      if let v = bundle[key] as? Int { return UInt32(v) }
      if let v = bundle[key] as? Double { return UInt32(v) }
      throw SignalEngineError.malformedBundle(key)
    }

    let identityKey = try IdentityKey(bytes: b64("identityKey"))
    let signedPublic = try PublicKey(b64("signedPreKeyPublic"))
    let kyberPublic = try KEMPublicKey(b64("kyberPreKeyPublic"))
    let address = try ProtocolAddress(name: userId, deviceId: deviceId)

    let preKeyBundle: PreKeyBundle
    if let oneTime = bundle["oneTimePreKey"] as? [String: Any],
       let idValue = oneTime["keyId"],
       let publicString = oneTime["publicKey"] as? String,
       let publicData = Data(base64Encoded: publicString) {
      let oneTimeId = (idValue as? Int).map(UInt32.init)
        ?? (idValue as? Double).map(UInt32.init)
        ?? (idValue as? UInt32)
        ?? 0
      preKeyBundle = try PreKeyBundle(
        registrationId: try u32("registrationId"),
        deviceId: deviceId,
        prekeyId: oneTimeId,
        prekey: try PublicKey(publicData),
        signedPrekeyId: try u32("signedPreKeyId"),
        signedPrekey: signedPublic,
        signedPrekeySignature: try b64("signedPreKeySignature"),
        identity: identityKey,
        kyberPrekeyId: try u32("kyberPreKeyId"),
        kyberPrekey: kyberPublic,
        kyberPrekeySignature: try b64("kyberPreKeySignature")
      )
    } else {
      // No one-time prekey available (peer exhausted its supply) — the
      // signed-prekey-only initializer is the documented fallback.
      preKeyBundle = try PreKeyBundle(
        registrationId: try u32("registrationId"),
        deviceId: deviceId,
        signedPrekeyId: try u32("signedPreKeyId"),
        signedPrekey: signedPublic,
        signedPrekeySignature: try b64("signedPreKeySignature"),
        identity: identityKey,
        kyberPrekeyId: try u32("kyberPreKeyId"),
        kyberPrekey: kyberPublic,
        kyberPrekeySignature: try b64("kyberPreKeySignature")
      )
    }

    guard let ourAddress = localAddress else { throw SignalEngineError.notBootstrapped }
    try processPreKeyBundle(
      preKeyBundle,
      for: address,
      ourAddress: ourAddress,
      sessionStore: store,
      identityStore: store,
      context: context
    )
  }

  func hasSession(userId: String, deviceId: UInt32) throws -> Bool {
    let address = try ProtocolAddress(name: userId, deviceId: deviceId)
    return try store.loadSession(for: address, context: context) != nil
  }

  // MARK: - Encrypt / decrypt

  func encrypt(userId: String, deviceId: UInt32, plaintext: Data) throws -> [String: Any] {
    guard let ourAddress = localAddress else { throw SignalEngineError.notBootstrapped }
    let address = try ProtocolAddress(name: userId, deviceId: deviceId)
    let message = try signalEncrypt(
      message: plaintext,
      for: address,
      localAddress: ourAddress,
      sessionStore: store,
      identityStore: store,
      context: context
    )
    return [
      // The receiver must dispatch on this to pick the right decrypt function;
      // it is protocol data, not a hint, so it travels with every envelope.
      "type": message.messageType.rawValue,
      "body": message.serialize().base64EncodedString(),
    ]
  }

  func decrypt(userId: String, deviceId: UInt32, type: Int, body: Data) throws -> Data {
    guard let ourAddress = localAddress else { throw SignalEngineError.notBootstrapped }
    let address = try ProtocolAddress(name: userId, deviceId: deviceId)
    let messageType = CiphertextMessage.MessageType(rawValue: UInt8(truncatingIfNeeded: type))

    switch messageType {
    case .preKey:
      // First message of a session: carries the sender's prekey selection, so
      // it consumes one of OUR one-time prekeys and builds the session.
      let message = try PreKeySignalMessage(bytes: body)
      return try signalDecryptPreKey(
        message: message,
        from: address,
        localAddress: ourAddress,
        sessionStore: store,
        identityStore: store,
        preKeyStore: store,
        signedPreKeyStore: store,
        kyberPreKeyStore: store,
        context: context
      )
    case .whisper:
      let message = try SignalMessage(bytes: body)
      return try signalDecrypt(
        message: message,
        from: address,
        to: ourAddress,
        sessionStore: store,
        identityStore: store,
        context: context
      )
    default:
      // Sender-key (group) and plaintext types are deliberately not handled
      // yet — group E2E is its own slice of §3.3 and must not be silently
      // half-implemented here.
      throw SignalEngineError.unsupportedCiphertextType(type)
    }
  }
}
