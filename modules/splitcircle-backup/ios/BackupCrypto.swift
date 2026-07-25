import CommonCrypto
import CryptoKit
import Foundation

/// Passphrase-derived encryption for backups (doc 31 §3.5, Phase 4).
///
/// This is the layer that wraps every chunk before it reaches a
/// `BackupProvider`, so CloudKit only ever holds ciphertext the user's
/// passphrase can open. It sits ON TOP of §3.3's Signal encryption — message
/// content is already ciphertext by the time it gets here; this protects the
/// backup as a whole, including from Apple.
///
/// KEY DERIVATION HAPPENS ONCE PER SESSION, NOT PER CHUNK. That is the central
/// design constraint: a correct passphrase KDF is deliberately expensive, and a
/// bulk export writes thousands of chunks, so re-deriving per chunk would make
/// a backup take hours. The derived key lives in native memory for the session
/// and is zeroized on `endSession`; a fresh random nonce per chunk is what
/// keeps reuse safe under one key.
///
/// NOTE ON THE KDF: §3.5 specifies "Argon2id, PBKDF2 fallback". This is the
/// PBKDF2 fallback. Argon2id is memory-hard and materially better against GPU
/// cracking of a backup passphrase — which is exactly the offline attack this
/// defends against — but it is not available in CryptoKit and libsignal's Swift
/// bindings expose only HKDF, so adopting it means taking a new native
/// dependency. The wrapped format below is versioned precisely so Argon2id can
/// be added as `kdf = 2` without breaking existing backups.
public enum BackupCryptoError: Error, LocalizedError {
  case noActiveSession
  case malformedPayload
  case decryptionFailed

  public var errorDescription: String? {
    switch self {
    case .noActiveSession:
      return "No backup encryption session is active"
    case .malformedPayload:
      return "Backup payload is malformed or truncated"
    case .decryptionFailed:
      return "Could not decrypt backup — the passphrase is wrong or the data is corrupt"
    }
  }
}

public final class BackupCrypto {
  /// Format version, stored in every wrapped blob. Bump when the envelope or
  /// KDF changes so old backups stay readable.
  private static let formatVersion: UInt8 = 1
  /// KDF identifier: 1 = PBKDF2-HMAC-SHA256. Reserve 2 for Argon2id.
  private static let kdfPbkdf2: UInt8 = 1

  /// OWASP's current floor for PBKDF2-HMAC-SHA256. Stored per-blob rather than
  /// assumed, so raising it later doesn't strand backups written today.
  /// Internal-but-visible so it can serve as a public default argument.
  public static let defaultIterations: UInt32 = 600_000
  private static let saltBytes = 16

  private var activeKey: SymmetricKey?
  private var activeSalt: Data?
  private var activeIterations: UInt32 = defaultIterations
  /// Retained for the session so `unwrap` can RE-DERIVE when it meets a blob
  /// sealed under a different salt. Restore is otherwise impossible: the salt
  /// lives inside the backup, but reading the backup needs the key, which needs
  /// the salt. Holding the passphrase for the session breaks that circle. It is
  /// cleared by `endSession` along with the key.
  private var activePassphrase: String?

  public init() {}

  // MARK: - Session lifecycle

  /// Derives the backup key from a passphrase.
  ///
  /// Pass `salt` when RESTORING (it comes from the backup being read); omit it
  /// when starting a new backup and a fresh random salt is generated. Returns
  /// the salt so the caller can persist it alongside the backup — without it
  /// the backup is permanently unreadable even with the correct passphrase.
  @discardableResult
  public func beginSession(
    passphrase: String,
    salt: Data? = nil,
    iterations: UInt32 = BackupCrypto.defaultIterations
  ) throws -> Data {
    let resolvedSalt: Data
    if let salt {
      resolvedSalt = salt
    } else {
      var bytes = Data(count: Self.saltBytes)
      let status = bytes.withUnsafeMutableBytes { buffer -> Int32 in
        guard let base = buffer.baseAddress else { return errSecParam }
        return SecRandomCopyBytes(kSecRandomDefault, Self.saltBytes, base)
      }
      guard status == errSecSuccess else { throw BackupCryptoError.malformedPayload }
      resolvedSalt = bytes
    }

    let derived = try Self.pbkdf2(passphrase: passphrase, salt: resolvedSalt, iterations: iterations)
    activeKey = SymmetricKey(data: derived)
    activeSalt = resolvedSalt
    activeIterations = iterations
    activePassphrase = passphrase
    return resolvedSalt
  }

  /// Drops the derived key. Call as soon as a backup/restore finishes — an
  /// unlocked backup key sitting in memory for the app's lifetime is a
  /// needlessly long exposure window.
  public func endSession() {
    activeKey = nil
    activeSalt = nil
    activePassphrase = nil
  }

  public var hasActiveSession: Bool { activeKey != nil }

  // MARK: - Wrap / unwrap

  /// Envelope: version | kdf | iterations(4, BE) | saltLen(1) | salt | AES-GCM combined.
  /// Self-describing on purpose — a restore must be able to read a blob written
  /// by an older build without out-of-band knowledge of the parameters used.
  public func wrap(_ plaintext: Data) throws -> Data {
    guard let key = activeKey, let salt = activeSalt else {
      throw BackupCryptoError.noActiveSession
    }

    // Fresh nonce per chunk (CryptoKit generates one when omitted). Reusing a
    // nonce under the same key would be catastrophic for AES-GCM, which is why
    // the key is per-session but the nonce never is.
    let sealed = try AES.GCM.seal(plaintext, using: key)
    guard let combined = sealed.combined else { throw BackupCryptoError.malformedPayload }

    var out = Data()
    out.append(Self.formatVersion)
    out.append(Self.kdfPbkdf2)
    var iterationsBE = activeIterations.bigEndian
    withUnsafeBytes(of: &iterationsBE) { out.append(contentsOf: $0) }
    out.append(UInt8(salt.count))
    out.append(salt)
    out.append(combined)
    return out
  }

  public func unwrap(_ blob: Data) throws -> Data {
    guard activeKey != nil else { throw BackupCryptoError.noActiveSession }
    guard blob.count > 7 else { throw BackupCryptoError.malformedPayload }

    // Re-derive when this blob was sealed under a different salt than the
    // current session's. A restore cannot know the salt up front — it lives
    // inside the backup — so beginSession(passphrase) alone mints a FRESH salt
    // and a key that decrypts nothing. Reading the salt back out of the
    // envelope here is what makes the format genuinely self-describing.
    // (Caught by the first real device round trip: export succeeded, import
    // failed with "wrong passphrase" against a backup written seconds earlier.)
    let (blobSalt, blobIterations) = try Self.extractSalt(from: blob)
    if blobSalt != activeSalt || blobIterations != activeIterations {
      guard let passphrase = activePassphrase else { throw BackupCryptoError.noActiveSession }
      let derived = try Self.pbkdf2(passphrase: passphrase, salt: blobSalt, iterations: blobIterations)
      activeKey = SymmetricKey(data: derived)
      activeSalt = blobSalt
      activeIterations = blobIterations
    }
    guard let key = activeKey else { throw BackupCryptoError.noActiveSession }

    var offset = blob.startIndex
    let version = blob[offset]; offset += 1
    guard version == Self.formatVersion else { throw BackupCryptoError.malformedPayload }
    let kdf = blob[offset]; offset += 1
    guard kdf == Self.kdfPbkdf2 else { throw BackupCryptoError.malformedPayload }
    offset += 4 // iterations — already applied when the session key was derived
    let saltLength = Int(blob[offset]); offset += 1
    guard blob.count > offset + saltLength else { throw BackupCryptoError.malformedPayload }
    offset += saltLength

    let ciphertext = blob[offset...]
    do {
      let box = try AES.GCM.SealedBox(combined: ciphertext)
      return try AES.GCM.open(box, using: key)
    } catch {
      // AEAD failure is indistinguishable from a wrong passphrase by design,
      // and that is the desired UX (§3.5: "AEAD clean-failure on wrong
      // passphrase") — never leak which of the two it was.
      throw BackupCryptoError.decryptionFailed
    }
  }

  /// Reads the salt out of a wrapped blob WITHOUT a session, so a restore can
  /// learn the parameters it needs before it can derive anything.
  public static func extractSalt(from blob: Data) throws -> (salt: Data, iterations: UInt32) {
    guard blob.count > 7 else { throw BackupCryptoError.malformedPayload }
    var offset = blob.startIndex
    offset += 2 // version, kdf
    var iterations: UInt32 = 0
    for i in 0..<4 {
      iterations = (iterations << 8) | UInt32(blob[offset + i])
    }
    offset += 4
    let saltLength = Int(blob[offset]); offset += 1
    guard blob.count > offset + saltLength else { throw BackupCryptoError.malformedPayload }
    return (Data(blob[offset..<(offset + saltLength)]), iterations)
  }

  // MARK: - KDF

  private static func pbkdf2(passphrase: String, salt: Data, iterations: UInt32) throws -> Data {
    let passphraseBytes = Array(passphrase.utf8)
    var derived = Data(count: 32)

    let status: Int32 = derived.withUnsafeMutableBytes { derivedBuffer in
      salt.withUnsafeBytes { saltBuffer in
        guard
          let derivedBase = derivedBuffer.bindMemory(to: UInt8.self).baseAddress,
          let saltBase = saltBuffer.bindMemory(to: UInt8.self).baseAddress
        else { return Int32(kCCParamError) }
        return CCKeyDerivationPBKDF(
          CCPBKDFAlgorithm(kCCPBKDF2),
          passphraseBytes.map { Int8(bitPattern: $0) }, passphraseBytes.count,
          saltBase, salt.count,
          CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
          iterations,
          derivedBase, 32
        )
      }
    }

    guard status == kCCSuccess else { throw BackupCryptoError.malformedPayload }
    return derived
  }
}
