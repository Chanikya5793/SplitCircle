import Foundation

/**
 The installation id, shared from the app to the extension (doc 36 §4).

 The extension needs it because a preview's associated data is
 `{chatId, deviceId}` — without the right device id the blob will not open, and
 the sealed-to-this-device binding is exactly what stops a blob from one device
 being replayed at another.

 APP GROUP `UserDefaults`, NOT the keychain. The id is a device identifier, not
 a secret: it is already sent to the server on every push registration and
 appears in the payload. Putting it in the shared container avoids a second
 keychain access-group migration for something that does not need protecting,
 and keeps the keychain change scoped to the one item that genuinely does — the
 identity private key.

 Written by the app (`SplitCircleCryptoModule.publishInstallationId`) and only
 read here. A missing value means the app has not run since this shipped; the
 extension then leaves the generic notification alone.
 */
enum SharedDeviceIdentity {
  static let suiteName = "group.com.splitcircle.app"
  static let installationIdKey = "splitcircle.installationId"

  static func installationId() -> String? {
    guard let defaults = UserDefaults(suiteName: suiteName) else { return nil }
    let value = defaults.string(forKey: installationIdKey)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return (value?.isEmpty == false) ? value : nil
  }
}
