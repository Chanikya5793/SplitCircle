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

  struct Copy {
    let title: String
    let subtitle: String?
    let body: String
  }

  /**
   Reads the device identity key from the SHARED keychain access group.

   The app group doubles as the keychain access group (see
   `SignalKeychain.sharedAccessGroup`), so this needs only the App Group
   entitlement — no separate Keychain Sharing capability, and no further
   provisioning invalidation.

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
      kSecAttrAccessGroup as String: "group.com.splitcircle.app",
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data else { return nil }
    return try? IdentityKeyPair(bytes: data)
  }

  static func open(sealed: String, chatId: String, deviceId: String) async -> Copy? {
    guard
      let ciphertext = Data(base64Encoded: sealed),
      let identity = loadIdentityKeyPair()
    else { return nil }

    // Associated data MUST be byte-identical to the sender's:
    // base64(JSON({chatId, deviceId})), with keys in that order.
    guard
      let adJson = try? JSONSerialization.data(
        withJSONObject: ["chatId": chatId, "deviceId": deviceId],
        options: [.sortedKeys]
      )
    else { return nil }
    let associatedData = adJson.base64EncodedData()

    do {
      // Identical to `SignalSessionEngine.openWithIdentity`, which is what the
      // app uses — same primitive, same argument order. Deliberately NOT a call
      // into that engine: it is an Expo module needing the React Native
      // runtime, which does not exist in an extension process.
      let plaintext = try identity.privateKey.open(
        ciphertext,
        info: info,
        associatedData: associatedData
      )
      // The JS side base64s the JSON before sealing, so unwrap twice.
      guard
        let inner = Data(base64Encoded: plaintext),
        let object = try? JSONSerialization.jsonObject(with: inner) as? [String: Any]
      else { return nil }
      return copy(from: object)
    } catch {
      NSLog("PreviewOpener: could not open preview: %@", String(describing: error))
      return nil
    }
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
