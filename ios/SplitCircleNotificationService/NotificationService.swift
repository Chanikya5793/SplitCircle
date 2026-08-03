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

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    let mutable = request.content.mutableCopy() as? UNMutableNotificationContent
    self.bestAttempt = mutable

    guard let mutable else {
      contentHandler(request.content)
      return
    }

    let info = request.content.userInfo
    guard
      let sealed = info["preview"] as? String, !sealed.isEmpty,
      let chatId = info["chatId"] as? String, !chatId.isEmpty
    else {
      // No preview: an older sender, or a device the sender had no cached
      // identity key for. The generic copy is correct here.
      contentHandler(request.content)
      return
    }

    Task {
      guard
        let deviceId = SharedDeviceIdentity.installationId(),
        let preview = await PreviewOpener.open(sealed: sealed, chatId: chatId, deviceId: deviceId)
      else {
        contentHandler(mutable)
        return
      }

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
    if let contentHandler, let bestAttempt {
      contentHandler(bestAttempt)
    }
  }
}
