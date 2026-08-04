import Foundation
import LibSignalClient

/**
 Opens an HPKE-sealed notification preview (doc 36 §3.2).

 Mirrors `src/services/notificationPreview.ts` exactly — same info string, same
 associated-data shape, same JSON body — because the two are a wire protocol
 across two languages that cannot import from each other. A drift in any of the
 three produces a silent failure: the blob simply never opens and every
 notification stays generic, with nothing in any log to say why.

 Stateless by construction: `openWithIdentity` needs only the device identity
 key and advances nothing, which is what makes it safe to run in a process that
 does not share a lock with the app.
 */
enum PreviewOpener {
  /// MUST match NOTIFICATION_PREVIEW_HPKE_INFO in notificationPreview.ts.
  static let info = "splitcircle/notification-preview/v1"
  private static let appGroupId = "group.com.splitcircle.app"
  private static let previewIdentityFileName = "notification-preview-identity.bin"

  struct Copy {
    let title: String
    let subtitle: String?
    let body: String
  }

  /**
   Reads the device identity key from the SHARED keychain access group.

   It shares the app's Keychain Sharing group (see
   `SignalKeychain.sharedAccessGroup`). App Groups and Keychain Sharing are
   distinct capabilities, so both targets declare the team-prefixed group.

   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` on the stored item is what
   makes this work on a LOCKED phone, which is when notifications matter most.
   That accessibility was already chosen deliberately by the app; this extension
   depends on it.

   Returns nil if the app has not yet run the migration in
   `SignalKeychain.migrateToSharedAccessGroup` — the key is then still in the
   app-private group, invisible here, and the generic notification stands.
   */
  private static func loadIdentityKeyPair() -> IdentityKeyPair? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.splitcircle.app.signal",
      kSecAttrAccount as String: "identityKeyPair",
      kSecAttrAccessGroup as String: "YDF2TB9967.com.splitcircle.app",
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data else { return nil }
    return try? IdentityKeyPair(bytes: data)
  }

  /**
   The current preview key lives in the App Group shared by the app and this
   extension. It avoids the TestFlight Keychain-sharing edge case that made the
   otherwise-valid primary Signal identity intermittently invisible here. The
   old Keychain identity stays as a migration fallback until every sender has
   observed the new public key.
   */
  private static func loadAppGroupPreviewIdentityKeyPair() -> IdentityKeyPair? {
    let fileManager = FileManager.default
    if let url = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)?
      .appendingPathComponent(previewIdentityFileName, isDirectory: false),
      let data = try? Data(contentsOf: url),
      let identity = try? IdentityKeyPair(bytes: data) {
      return identity
    }

    guard let defaults = UserDefaults(suiteName: appGroupId) else { return nil }
    // A message may arrive immediately after the foreground app generated its
    // preview identity. Synchronize before the compatibility fallback so this
    // independently launched extension sees the newest shared value.
    defaults.synchronize()
    guard let data = defaults.data(forKey: "splitcircle.notificationPreview.identityKeyPair")
    else { return nil }
    return try? IdentityKeyPair(bytes: data)
  }

  static func open(sealed: String, chatId: String, deviceId: String) async -> Copy? {
    guard let ciphertext = Data(base64Encoded: sealed) else { return nil }
    // New senders seal to the App-Group preview identity. Keep the old
    // Keychain identity as a *decryption* fallback during rollout: a sender
    // on an already-installed build still only knows that public key. Merely
    // choosing the new key first would make every such message generic until
    // every sender was updated, even though the extension can open it safely.
    let identities = [
      loadAppGroupPreviewIdentityKeyPair(),
      loadIdentityKeyPair(),
    ].compactMap { $0 }
    guard !identities.isEmpty else { return nil }

    // Associated data MUST be byte-identical to the sender's: the UTF-8 bytes
    // of JSON({chatId, deviceId}), keys in that order.
    //
    // NOT its base64 form, which is the trap this got wrong. The JS half's
    // `previewAssociatedData` returns base64(JSON) only because the Expo
    // bridge moves bytes as strings — `sealToIdentity` in
    // SplitCircleCryptoModule.swift immediately calls `Data(base64Encoded:)`
    // on it, so what HPKE actually authenticates is the decoded JSON. Sealing
    // over JSON while opening over base64(JSON) is an AEAD mismatch: every
    // `open` below threw, every iOS notification fell back to "New message",
    // and — exactly as this file's header warns — nothing logged why.
    guard
      let associatedData = try? JSONSerialization.data(
        withJSONObject: ["chatId": chatId, "deviceId": deviceId],
        options: [.sortedKeys]
      )
    else { return nil }

    for identity in identities {
      do {
        // Identical to `SignalSessionEngine.openWithIdentity`, which is what
        // the app uses — same primitive, same argument order. Deliberately NOT
        // a call into that engine: it is an Expo module needing the React
        // Native runtime, which does not exist in an extension process.
        let plaintext = try identity.privateKey.open(
          ciphertext,
          info: info,
          associatedData: associatedData
        )
        // What comes out is ALREADY the preview JSON. The JS half's
        // `encodeUtf8Base64(JSON.stringify(preview))` is a bridge transport
        // encoding, decoded by `sealToIdentity` before anything is sealed —
        // so the sealed plaintext is the JSON itself. Unwrapping a second
        // base64 layer here found none: `Data(base64Encoded:)` rejected the
        // leading `{` and returned nil on every single delivery.
        guard
          let object = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
          let resolved = copy(from: object)
        else { continue }
        return resolved
      } catch {
        // Try the migration fallback. The blob is authenticated, so a wrong
        // key cannot produce a false preview.
        continue
      }
    }

    NSLog("PreviewOpener: could not open preview with any local identity")
    return nil
  }

  /**
   Maps the decoded body to what the tray shows.

   Same rule as `previewToNotificationCopy` in the TS half: group name as title
   with the sender as subtitle, sender as title for a direct chat. A body
   missing either required field is rejected rather than rendered — decrypting
   is not the same as being well-formed, and a half-filled notification is worse
   than the generic one it would replace.
   */
  private static func copy(from object: [String: Any]) -> Copy? {
    let sender = (object["senderName"] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let body = (object["body"] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !sender.isEmpty, !body.isEmpty else { return nil }

    let group = (object["groupName"] as? String)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return group.isEmpty
      ? Copy(title: sender, subtitle: nil, body: body)
      : Copy(title: group, subtitle: sender, body: body)
  }
}
