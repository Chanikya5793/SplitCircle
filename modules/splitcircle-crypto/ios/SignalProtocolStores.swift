import Foundation
import LibSignalClient

/// libsignal's six store protocols, persisted via `SignalStorage` (doc 31 §3.3).
///
/// libsignal calls these synchronously and re-entrantly during encrypt/decrypt,
/// and a Signal session is REWRITTEN on every message — so correctness here is
/// what makes a session survive app restarts. All record types round-trip
/// through `serialize()` / `init(bytes:)`, so each is stored as an opaque blob;
/// this deliberately treats libsignal's wire format as the source of truth
/// rather than re-modelling any of it.
///
/// Concurrency: every entry point into these stores is expected to be already
/// serialized by `SplitCircleCryptoModule`'s crypto queue. Two concurrent
/// operations on the SAME session would corrupt the ratchet regardless of what
/// the storage layer does, so the queue — not a lock in here — is the real
/// invariant. The blob store still locks internally to keep file writes atomic.

enum SignalStoreError: Error, LocalizedError {
  case notInitialized
  case missingRecord(String)

  var errorDescription: String? {
    switch self {
    case .notInitialized:
      return "Signal identity has not been created on this device yet"
    case .missingRecord(let what):
      return "Missing Signal record: \(what)"
    }
  }
}

/// libsignal requires a `StoreContext`; we carry no ambient transaction, so this
/// is an empty marker (the same thing libsignal's own test stores do).
struct SignalContext: StoreContext {}

final class SplitCircleSignalStore {
  // Keychain accounts.
  private static let identityKeyAccount = "identityKeyPair"
  private static let registrationIdAccount = "registrationId"

  private let sessions: SignalBlobStore
  private let preKeys: SignalBlobStore
  private let signedPreKeys: SignalBlobStore
  private let kyberPreKeys: SignalBlobStore
  private let senderKeys: SignalBlobStore
  private let identities: SignalBlobStore

  init() throws {
    self.sessions = try SignalBlobStore(namespace: "sessions")
    self.preKeys = try SignalBlobStore(namespace: "prekeys")
    self.signedPreKeys = try SignalBlobStore(namespace: "signedprekeys")
    self.kyberPreKeys = try SignalBlobStore(namespace: "kyberprekeys")
    self.senderKeys = try SignalBlobStore(namespace: "senderkeys")
    self.identities = try SignalBlobStore(namespace: "identities")
  }

  // MARK: - Local identity lifecycle

  var hasIdentity: Bool {
    ((try? SignalKeychain.get(Self.identityKeyAccount)) ?? nil) != nil
  }

  /// Creates this device's long-lived identity if absent, and returns it.
  /// Idempotent by design: called on every app start, but must never mint a
  /// second identity — that would invalidate every session peers already hold.
  @discardableResult
  func ensureIdentity() throws -> (identity: IdentityKeyPair, registrationId: UInt32) {
    if let existing = try SignalKeychain.get(Self.identityKeyAccount),
       let idData = try SignalKeychain.get(Self.registrationIdAccount),
       idData.count == 4 {
      let pair = try IdentityKeyPair(bytes: existing)
      let regId = idData.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
      return (pair, regId)
    }

    let pair = IdentityKeyPair.generate()
    // The Swift bindings expose no registration-id generator (it exists only in
    // the Java bindings) — verified against libsignal's real source during the
    // Phase 3 spike. This mirrors libsignal's own test-store convention: a
    // 14-bit value, which is what the protocol's wire format allows.
    let regId = UInt32.random(in: 1...0x3FFF)
    var regIdLE = regId.littleEndian
    let regIdData = Data(bytes: &regIdLE, count: 4)

    // Registration id first: if this crashes between the two writes, a stored
    // registration id with no identity key is discarded by the guard above,
    // whereas an identity key with no registration id would be unusable.
    try SignalKeychain.set(regIdData, for: Self.registrationIdAccount)
    try SignalKeychain.set(pair.serialize(), for: Self.identityKeyAccount)
    return (pair, regId)
  }

  /// Destroys all Signal state for this device. Used on revocation (§3.7) and
  /// account deletion (doc 28) — leaving sessions behind would let a revoked
  /// peer's ciphertext continue to decrypt.
  func wipe() throws {
    try SignalKeychain.delete(Self.identityKeyAccount)
    try SignalKeychain.delete(Self.registrationIdAccount)
    for store in [sessions, preKeys, signedPreKeys, kyberPreKeys, senderKeys, identities] {
      store.removeAll()
    }
  }

  // MARK: - Key helpers

  private func addressKey(_ address: ProtocolAddress) -> String {
    "\(address.name)::\(address.deviceId)"
  }
}

// MARK: - IdentityKeyStore

extension SplitCircleSignalStore: IdentityKeyStore {
  func identityKeyPair(context: StoreContext) throws -> IdentityKeyPair {
    guard let data = try SignalKeychain.get(Self.identityKeyAccount) else {
      throw SignalStoreError.notInitialized
    }
    return try IdentityKeyPair(bytes: data)
  }

  func localRegistrationId(context: StoreContext) throws -> UInt32 {
    guard let data = try SignalKeychain.get(Self.registrationIdAccount), data.count == 4 else {
      throw SignalStoreError.notInitialized
    }
    return data.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
  }

  func saveIdentity(
    _ identity: IdentityKey,
    for address: ProtocolAddress,
    context: StoreContext
  ) throws -> IdentityChange {
    let key = addressKey(address)
    let serialized = identity.serialize()
    if let existing = identities.get(key) {
      if existing == serialized { return .newOrUnchanged }
      try identities.set(serialized, for: key)
      // A changed identity for a known address is the "safety number changed"
      // event: the peer reinstalled, restored, or is being impersonated. The
      // UI-facing warning for this is §3.4's job; here we only record the fact.
      return .replacedExisting
    }
    try identities.set(serialized, for: key)
    return .newOrUnchanged
  }

  func isTrustedIdentity(
    _ identity: IdentityKey,
    for address: ProtocolAddress,
    direction: Direction,
    context: StoreContext
  ) throws -> Bool {
    guard let existing = identities.get(addressKey(address)) else {
      // Trust-on-first-use, matching Signal's own default: with no prior key
      // there is nothing to compare against, and refusing would make first
      // contact impossible.
      return true
    }
    return existing == identity.serialize()
  }

  func identity(for address: ProtocolAddress, context: StoreContext) throws -> IdentityKey? {
    guard let data = identities.get(addressKey(address)) else { return nil }
    return try IdentityKey(bytes: data)
  }
}

// MARK: - PreKeyStore

extension SplitCircleSignalStore: PreKeyStore {
  func loadPreKey(id: UInt32, context: StoreContext) throws -> PreKeyRecord {
    guard let data = preKeys.get(String(id)) else {
      throw SignalStoreError.missingRecord("preKey \(id)")
    }
    return try PreKeyRecord(bytes: data)
  }

  func storePreKey(_ record: PreKeyRecord, id: UInt32, context: StoreContext) throws {
    try preKeys.set(record.serialize(), for: String(id))
  }

  func removePreKey(id: UInt32, context: StoreContext) throws {
    // One-time prekeys are consumed on use; libsignal calls this to enforce
    // that. Deleting is the point — it must not be a no-op.
    preKeys.delete(String(id))
  }
}

// MARK: - SignedPreKeyStore

extension SplitCircleSignalStore: SignedPreKeyStore {
  func loadSignedPreKey(id: UInt32, context: StoreContext) throws -> SignedPreKeyRecord {
    guard let data = signedPreKeys.get(String(id)) else {
      throw SignalStoreError.missingRecord("signedPreKey \(id)")
    }
    return try SignedPreKeyRecord(bytes: data)
  }

  func storeSignedPreKey(_ record: SignedPreKeyRecord, id: UInt32, context: StoreContext) throws {
    try signedPreKeys.set(record.serialize(), for: String(id))
  }
}

// MARK: - KyberPreKeyStore

extension SplitCircleSignalStore: KyberPreKeyStore {
  func loadKyberPreKey(id: UInt32, context: StoreContext) throws -> KyberPreKeyRecord {
    guard let data = kyberPreKeys.get(String(id)) else {
      throw SignalStoreError.missingRecord("kyberPreKey \(id)")
    }
    return try KyberPreKeyRecord(bytes: data)
  }

  func storeKyberPreKey(_ record: KyberPreKeyRecord, id: UInt32, context: StoreContext) throws {
    try kyberPreKeys.set(record.serialize(), for: String(id))
  }

  func markKyberPreKeyUsed(
    id: UInt32,
    signedPreKeyId: UInt32,
    baseKey: PublicKey,
    context: StoreContext
  ) throws {
    // Kyber prekeys published here are the SIGNED (reusable) kind, not one-time
    // — §3.3 publishes one per device and rotates it, so "used" is not a delete.
    // Retaining it is what lets a second peer complete a handshake against the
    // same published bundle; rotation is driven by the app, not by this call.
  }
}

// MARK: - SessionStore

extension SplitCircleSignalStore: SessionStore {
  func loadSession(for address: ProtocolAddress, context: StoreContext) throws -> SessionRecord? {
    guard let data = sessions.get(addressKey(address)) else { return nil }
    return try SessionRecord(bytes: data)
  }

  func loadExistingSessions(for addresses: [ProtocolAddress], context: StoreContext) throws -> [SessionRecord] {
    // Contract is strict: this must return one record PER address, in order,
    // and throw if any is missing — callers (group send) index the results
    // positionally, so returning a short array would silently misroute
    // ciphertext to the wrong device.
    try addresses.map { address in
      guard let data = sessions.get(addressKey(address)) else {
        throw SignalStoreError.missingRecord("session \(addressKey(address))")
      }
      return try SessionRecord(bytes: data)
    }
  }

  func storeSession(_ record: SessionRecord, for address: ProtocolAddress, context: StoreContext) throws {
    try sessions.set(record.serialize(), for: addressKey(address))
  }
}

// MARK: - SenderKeyStore

extension SplitCircleSignalStore: SenderKeyStore {
  private func senderKeyKey(_ sender: ProtocolAddress, _ distributionId: UUID) -> String {
    "\(addressKey(sender))::\(distributionId.uuidString)"
  }

  func storeSenderKey(
    from sender: ProtocolAddress,
    distributionId: UUID,
    record: SenderKeyRecord,
    context: StoreContext
  ) throws {
    try senderKeys.set(record.serialize(), for: senderKeyKey(sender, distributionId))
  }

  func loadSenderKey(
    from sender: ProtocolAddress,
    distributionId: UUID,
    context: StoreContext
  ) throws -> SenderKeyRecord? {
    guard let data = senderKeys.get(senderKeyKey(sender, distributionId)) else { return nil }
    return try SenderKeyRecord(bytes: data)
  }
}
