import Foundation
import Security

/// Persistence primitives for the Signal protocol stores (doc 31 §3.3, Phase 3).
///
/// Two tiers, split by sensitivity and by how often they change:
///
/// - `SignalKeychain` — the long-lived device secret (identity keypair,
///   registration id, libsignal device id). Small, written once, and the single
///   most sensitive material we hold, so it lives in the Keychain rather than in
///   the app container.
/// - `SignalBlobStore` — everything libsignal mutates as messages flow
///   (sessions, prekeys, sender keys). One file per record: a Signal session is
///   rewritten on *every* message, so a single-blob store would mean rewriting
///   the whole corpus per message.
///
/// Deliberately NOT SQLite: CLAUDE.md flags an unverified linker risk between
/// system libsqlite3 and expo-sqlite's vendored static copy. Plain files with
/// iOS data protection avoid that question entirely.
///
/// File protection is `completeUntilFirstUserAuthentication`, not `complete`:
/// messages must still decrypt while the phone is locked (background push
/// delivery), which `complete` would prevent after the screen locks.

// MARK: - Keychain

enum SignalKeychainError: Error {
  case unexpectedStatus(OSStatus)
}

/// Thin wrapper over the Keychain for a handful of small, device-bound secrets.
///
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: `ThisDeviceOnly` keeps the
/// identity key out of any iCloud/iTunes backup — a restored clone must pair as
/// its own device with its own identity (§3.3's per-device identity model),
/// never silently inherit this one's. `AfterFirstUnlock` (rather than
/// `WhenUnlocked`) is required for background decryption while locked.
enum SignalKeychain {
  private static let service = "com.splitcircle.app.signal"

  static func set(_ data: Data, for account: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    // Update-then-add rather than delete-then-add: a delete+add pair is not
    // atomic, and a crash between the two would lose the identity key
    // irrecoverably (every existing session would then be undecryptable).
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if updateStatus == errSecSuccess { return }
    guard updateStatus == errSecItemNotFound else {
      throw SignalKeychainError.unexpectedStatus(updateStatus)
    }
    var insert = query
    insert[kSecValueData as String] = data
    insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let addStatus = SecItemAdd(insert as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
      throw SignalKeychainError.unexpectedStatus(addStatus)
    }
  }

  static func get(_ account: String) throws -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else {
      throw SignalKeychainError.unexpectedStatus(status)
    }
    return item as? Data
  }

  static func delete(_ account: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw SignalKeychainError.unexpectedStatus(status)
    }
  }
}

// MARK: - Blob store

/// File-backed `String -> Data` store for libsignal's mutable records.
///
/// Keys are namespaced (`"session"`, `"prekey"`, …) and become one file each.
/// Filenames are the hex of the UTF-8 key: libsignal keys embed user ids and
/// device ids, and hex is collision-free, case-insensitive-filesystem-safe, and
/// avoids `/`, `:` and Unicode-normalization surprises that would silently
/// alias two distinct addresses onto one file.
final class SignalBlobStore {
  private let root: URL
  private let lock = NSLock()

  init(namespace: String) throws {
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    self.root = base.appendingPathComponent("signal", isDirectory: true)
      .appendingPathComponent(namespace, isDirectory: true)
    try FileManager.default.createDirectory(
      at: root,
      withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    )
    // Signal state is reconstructible only by re-pairing; it is app-private
    // state, not user documents, so keep it out of iCloud/iTunes backups. This
    // also matches the ThisDeviceOnly identity key above — a restored backup
    // must not resurrect half a Signal store whose identity key is gone.
    var resourceValues = URLResourceValues()
    resourceValues.isExcludedFromBackup = true
    var mutableRoot = root
    try? mutableRoot.setResourceValues(resourceValues)
  }

  private func url(for key: String) -> URL {
    let hex = Data(key.utf8).map { String(format: "%02x", $0) }.joined()
    return root.appendingPathComponent(hex)
  }

  func get(_ key: String) -> Data? {
    lock.lock()
    defer { lock.unlock() }
    return try? Data(contentsOf: url(for: key))
  }

  func set(_ data: Data, for key: String) throws {
    lock.lock()
    defer { lock.unlock() }
    try data.write(to: url(for: key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  func delete(_ key: String) {
    lock.lock()
    defer { lock.unlock() }
    try? FileManager.default.removeItem(at: url(for: key))
  }

  func has(_ key: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return FileManager.default.fileExists(atPath: url(for: key).path)
  }

  /// Wipes every record in this namespace. Used by device-revocation
  /// (§3.4/§3.7) and account deletion (doc 28), where leaving stale sessions
  /// behind would let a revoked peer's ciphertext still decrypt.
  func removeAll() {
    lock.lock()
    defer { lock.unlock() }
    let contents = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
    for url in contents {
      try? FileManager.default.removeItem(at: url)
    }
  }
}
