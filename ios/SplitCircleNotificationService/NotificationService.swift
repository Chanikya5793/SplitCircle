import UserNotifications

/**
 Notification Service Extension — decrypts message previews before display
 (ai_layer/docs/36 §3.2, §4).

 The server sends message pushes with GENERIC visible copy ("ManaSplit / New
 message") plus an opaque `preview` blob, because it cannot read the message.
 This extension opens that blob and rewrites the notification before iOS shows
 it, so the user sees the real text with no flicker and nothing readable ever
 leaves the device.

 WHY AN EXTENSION AND NOT THE APP. iOS presents a notification before the app
 gets a chance to run, so the app can only dismiss-and-repost — two banners for
 one message. Only an NSE can rewrite content pre-display. Android has no such
 constraint and does it in the app's background task instead.

 WHY HPKE AND NOT THE SIGNAL SESSION. This is a SEPARATE PROCESS from the app,
 with no shared lock on the Signal session store. Signal decryption advances a
 ratchet; two processes advancing one ratchet corrupts it, which is exactly the
 "arrived but cannot be opened" failure this project has chased at length. HPKE
 (RFC 9180) is stateless — opening the same blob from two processes is
 harmless — and needs only the device identity key, read from the shared
 keychain access group.

 EVERY FAILURE PATH SHOWS THE ORIGINAL. `contentHandler` is called with the
 unmodified request on any problem: no preview, a wrong chat, a tampered blob, a
 missing key, or the 30-second budget expiring. The user then sees "New
 message", which is correct-but-less rather than wrong. `serviceExtensionTimeWillExpire`
 exists for the last of those — without it iOS silently drops the notification
 entirely when the budget runs out.
 */
final class NotificationService: UNNotificationServiceExtension {

  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttempt: UNMutableNotificationContent?

  /// A tiny, content-free flight recorder in the shared App Group. It lets us
  /// distinguish “APNs never carried a preview” from “the extension could not
  /// open it” on a real TestFlight device without logging sender names or
  /// message text. The app never depends on this data; it is solely an iOS
  /// transport diagnostic and is overwritten for every delivery.
  private func recordPreviewResult(_ state: String) {
    guard let defaults = UserDefaults(suiteName: "group.com.splitcircle.app") else { return }
    defaults.set(state, forKey: "splitcircle.notificationPreview.lastResult")
    defaults.set(Date().timeIntervalSince1970, forKey: "splitcircle.notificationPreview.lastAt")
    defaults.synchronize()
  }

  /**
   Finds the app's data dictionary, which sits in a DIFFERENT PLACE depending
   on which transport delivered the push.

   `sendMessagePushes` is mid-migration and uses both (doc 36 §6): a device is
   sent direct the moment it has a native token on file, and via Expo until
   then. `directPush.ts` assigns `note.payload = target.data`, so those keys
   land at the APNs payload's TOP LEVEL. Expo's relay instead nests the whole
   `data` object under a `body` key — see expo-notifications'
   `NotificationRecords.serializedNotificationData`, which reads exactly
   `userInfo["body"]` for any remote notification.

   Reading only the top level therefore worked for direct pushes and found
   nothing at all for Expo-relayed ones, which — while native tokens are still
   propagating — is most deliveries. That is indistinguishable here from a
   sender that never sealed a preview, so it failed as the generic notification
   with the flight recorder honestly reporting "missing-preview-or-chat".

   Top level wins when both carry the key: it is the transport we are moving
   to, and Expo's own `body` is only ever a nested copy of the same map.
   */
  private static func messageData(in userInfo: [AnyHashable: Any]) -> [AnyHashable: Any] {
    guard let nested = userInfo["body"] as? [AnyHashable: Any] else { return userInfo }
    return userInfo.merging(nested) { top, _ in top }
  }

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    let mutable = request.content.mutableCopy() as? UNMutableNotificationContent
    self.bestAttempt = mutable

    guard let mutable else {
      recordPreviewResult("mutable-copy-failed")
      contentHandler(request.content)
      return
    }

    let info = Self.messageData(in: request.content.userInfo)
    guard
      let sealed = info["preview"] as? String, !sealed.isEmpty,
      let chatId = info["chatId"] as? String, !chatId.isEmpty
    else {
      // No preview: an older sender, or a device the sender had no cached
      // identity key for. The generic copy is correct here.
      recordPreviewResult("missing-preview-or-chat")
      contentHandler(request.content)
      return
    }

    Task {
      guard
        let deviceId = SharedDeviceIdentity.installationId(),
        let preview = await PreviewOpener.open(sealed: sealed, chatId: chatId, deviceId: deviceId)
      else {
        recordPreviewResult("open-failed")
        contentHandler(mutable)
        return
      }

      recordPreviewResult("opened")
      mutable.title = preview.title
      if let subtitle = preview.subtitle { mutable.subtitle = subtitle }
      mutable.body = preview.body
      contentHandler(mutable)
    }
  }

  /**
   Called when the ~30s budget is nearly up.

   Delivering `bestAttempt` here is mandatory: an extension that neither calls
   `contentHandler` nor returns something on expiry has its notification DROPPED
   by iOS, so a slow decrypt would cost the user the message entirely rather
   than its preview.
   */
  override func serviceExtensionTimeWillExpire() {
    recordPreviewResult("timed-out")
    if let contentHandler, let bestAttempt {
      contentHandler(bestAttempt)
    }
  }
}
