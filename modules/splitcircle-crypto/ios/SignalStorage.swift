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

  /**
   Shared access group, so the Notification Service Extension can read the
   identity key (ai_layer/docs/36 §4).

   An App Group is not a Keychain access group. Keychain Sharing identifiers
   use the Apple team prefix, and both the app and Notification Service
   Extension declare this same group in their entitlements.

   Items are keyed by service+account, and the access group is part of an item's
   IDENTITY: writing with a group and reading without one will not find the same
   item. That is why `get` searches both, and why `migrateToSharedAccessGroup`
   exists — an install predating this change has its key in the app-private
   group, where the extension can never see it.
   */
  static let sharedAccessGroup = "YDF2TB9967.com.splitcircle.app"

  /**
   Whether the shared group is usable in this process.

   False in a build whose entitlements do not yet carry the App Group — every
   keychain call with an unentitled access group fails `errSecMissingEntitlement`
   (-34018), which would take out identity storage entirely and with it every
   Signal session. Probed once, cheaply, and cached: this is on the crypto hot
   path.
   */
  private static let sharedGroupUsable: Bool = {
    let probeAccount = "__accessgroup_probe__"
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: probeAccount,
      kSecAttrAccessGroup as String: sharedAccessGroup,
      kSecValueData as String: Data([0x01]),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let addStatus = SecItemAdd(query as CFDictionary, nil)
    if addStatus == errSecSuccess || addStatus == errSecDuplicateItem {
      query.removeValue(forKey: kSecValueData as String)
      query.removeValue(forKey: kSecAttrAccessible as String)
      SecItemDelete(query as CFDictionary)
      return true
    }
    // -34018 (missing entitlement) is the expected answer in a build without
    // the App Group. NSLog because this decides whether notification previews
    // can work at all, and a Release build surfaces nothing else.
    NSLog("SignalKeychain: shared access group unavailable (OSStatus %d); falling back to app-private", addStatus)
    return false
  }()

  /** Access-group attribute for writes, omitted when the group is unusable. */
  private static func accessGroupAttributes() -> [String: Any] {
    sharedGroupUsable ? [kSecAttrAccessGroup as String: sharedAccessGroup] : [:]
  }

  static func set(_ data: Data, for account: String) throws {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    query.merge(accessGroupAttributes()) { current, _ in current }
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

  /**
   Moves existing keychain items into the shared access group.

   MUST RUN FROM THE APP, never the extension. An item's access group is part of
   its identity, so a process that cannot see the app-private group cannot move
   what is in it — and the extension, by definition, cannot. Called on crypto
   init, which the app always reaches before any notification can arrive.

   Copy-then-verify-then-delete, in that order. A delete-first sequence that
   crashed midway would lose the identity key permanently, taking every existing
   Signal session with it — the single worst outcome available here, and worse
   than never migrating at all. Anything unexpected leaves the private copy in
   place; `get` reads both groups, so a failed migration costs the notification
   preview and nothing else.
   */
  @discardableResult
  static func migrateToSharedAccessGroup(_ accounts: [String]) -> Int {
    guard sharedGroupUsable else { return 0 }
    var moved = 0

    for account in accounts {
      // Already shared? Nothing to do.
      if (try? read(account, accessGroup: sharedAccessGroup)) ?? nil != nil { continue }
      guard let existing = (try? read(account, accessGroup: nil)) ?? nil else { continue }

      let insert: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrAccessGroup as String: sharedAccessGroup,
        kSecValueData as String: existing,
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      ]
      let addStatus = SecItemAdd(insert as CFDictionary, nil)
      guard addStatus == errSecSuccess || addStatus == errSecDuplicateItem else {
        NSLog("SignalKeychain: migrate add failed for %@ (OSStatus %d)", account, addStatus)
        continue
      }

      // VERIFY before deleting. Trusting errSecSuccess and deleting is how a
      // key gets lost to a subtly wrong query.
      guard let copied = (try? read(account, accessGroup: sharedAccessGroup)) ?? nil,
            copied == existing else {
        NSLog("SignalKeychain: migrate verify failed for %@; keeping private copy", account)
        continue
      }

      let deleteQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        // Explicitly the PRIVATE group, or this deletes the copy just made.
        kSecAttrAccessGroup as String: Bundle.main.bundleIdentifier ?? "",
      ]
      let deleteStatus = SecItemDelete(deleteQuery as CFDictionary)
      if deleteStatus != errSecSuccess && deleteStatus != errSecItemNotFound {
        // Harmless: `get` prefers the shared copy, so a leftover private item is
        // dead weight rather than a correctness problem.
        NSLog("SignalKeychain: migrate cleanup left a private copy for %@ (OSStatus %d)", account, deleteStatus)
      }
      moved += 1
    }

    if moved > 0 { NSLog("SignalKeychain: migrated %d item(s) to the shared access group", moved) }
    return moved
  }

  static func get(_ account: String) throws -> Data? {
    // Shared group first, then app-private. An item's access group is part of
    // its identity, so a key written before this change lives ONLY in the
    // private group and a shared-group-only query would report it missing —
    // which reads as "no identity yet" and would regenerate one, breaking every
    // existing Signal session on the device.
    if sharedGroupUsable, let shared = try read(account, accessGroup: sharedAccessGroup) {
      return shared
    }
    return try read(account, accessGroup: nil)
  }

  private static func read(_ account: String, accessGroup: String?) throws -> Data? {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
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
