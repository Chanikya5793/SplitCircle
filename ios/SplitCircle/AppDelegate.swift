internal import Expo
internal import React
internal import ReactAppDependencyProvider
import PushKit
import CallKit
// RNCallKeep and RNVoipPushNotificationManager are imported through
// SplitCircle-Bridging-Header.h — they're ObjC pods without Swift modulemaps.

// iOS 27 refuses to launch apps built with the iOS 26 SDK (or later) that use
// the classic UIApplication lifecycle (TN3187 — SIGTRAP before first frame).
// The app therefore adopts the UIScene lifecycle: this delegate keeps process-
// level setup (React Native factory, VoIP PushKit, theme-override observer),
// while window creation + startReactNative live in SceneDelegate below, wired
// up via UIApplicationSceneManifest in Info.plist.

@UIApplicationMain
class AppDelegate: ExpoAppDelegate, PKPushRegistryDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?
  var voipRegistry: PKPushRegistry?
  /** Kept for SceneDelegate — startReactNative wants the launch options, and
   *  scene connection happens after didFinishLaunching returns. */
  var launchOptionsSnapshot: [UIApplication.LaunchOptionsKey: Any]?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    launchOptionsSnapshot = launchOptions

    NotificationCenter.default.addObserver(
      self,
      selector: #selector(userDefaultsDidChange(_:)),
      name: UserDefaults.didChangeNotification,
      object: nil
    )

    registerVoipPushKit()

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // MARK: - PushKit (VoIP)

  private func registerVoipPushKit() {
    let registry = PKPushRegistry(queue: DispatchQueue.main)
    registry.delegate = self
    registry.desiredPushTypes = [.voIP]
    voipRegistry = registry
  }

  func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    RNVoipPushNotificationManager.didUpdate(pushCredentials, forType: type.rawValue)
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    // The token is no longer valid. JS can react via the onDidLoadWithEvents flow if needed.
  }

  func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    // iOS 13+ contract: every VoIP push MUST result in CXProvider.reportNewIncomingCall
    // before this callback returns, or the system will throttle / disable VoIP push.
    // We therefore report the call to CallKit synchronously here using payload data,
    // then forward the payload to JS so the rest of the app state can catch up.
    let dict = payload.dictionaryPayload as? [String: Any] ?? [:]

    let uuid = (dict["uuid"] as? String)
      ?? (dict["callId"] as? String)
      ?? UUID().uuidString
    let callerName = (dict["callerName"] as? String)
      ?? (dict["initiatorName"] as? String)
      ?? "Incoming call"
    let handle = (dict["handle"] as? String)
      ?? (dict["chatId"] as? String)
      ?? uuid
    let hasVideo: Bool = {
      if let explicit = dict["hasVideo"] as? Bool { return explicit }
      if let callType = dict["callType"] as? String { return callType == "video" }
      return false
    }()

    RNCallKeep.reportNewIncomingCall(
      uuid,
      handle: handle,
      handleType: "generic",
      hasVideo: hasVideo,
      localizedCallerName: callerName,
      supportsHolding: true,
      supportsDTMF: true,
      supportsGrouping: false,
      supportsUngrouping: false,
      fromPushKit: true,
      payload: dict,
      withCompletionHandler: completion
    )

    // Stale-push guard: APNs stores a VoIP push for an offline device and
    // delivers it whenever the device comes back — minutes or hours after the
    // caller gave up. The call still MUST be reported above (iOS 13 contract),
    // but if the server's send timestamp says it's older than the ring window,
    // end it right away as "unanswered" so the phone doesn't ring for a call
    // that died long ago. The short delay lets CallKit finish presenting the
    // call before it is dismissed (ending mid-report is ignored).
    // Threshold is deliberately WIDE (3 min vs the 60s ring window): it only
    // needs to catch pushes stored by APNs while the device was offline for
    // minutes/hours. The JS-side RTDB reconcile handles the fine-grained
    // cases, and a wide margin means a device clock that runs a bit fast can
    // never kill a legitimate incoming call here.
    let sentAtMs: Double? = (dict["sentAt"] as? NSNumber)?.doubleValue
    if let sentAtMs, sentAtMs > 0 {
      let ageMs = Date().timeIntervalSince1970 * 1000 - sentAtMs
      if ageMs > 180_000 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
          // 3 = CXCallEndedReason.unanswered
          RNCallKeep.endCall(withUUID: uuid, reason: 3)
        }
      }
    }

    RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue as String)
  }

  // Called whenever JS writes a theme preference via Settings.set({ RNThemeIsDark: 0|1 }).
  // Updates window.overrideUserInterfaceStyle so the UITabBarController and all other
  // native views reflect the in-app theme rather than the system setting.
  @objc func userDefaultsDidChange(_ notification: Notification) {
    guard let stored = UserDefaults.standard.object(forKey: "RNThemeIsDark") as? Int else { return }
    let newStyle: UIUserInterfaceStyle = stored == 1 ? .dark : .light
    DispatchQueue.main.async { [weak self] in
      guard self?.window?.overrideUserInterfaceStyle != newStyle else { return }
      self?.window?.overrideUserInterfaceStyle = newStyle
    }
  }

  // Linking API
  override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links + Phone-app Recents redials.
  // A tap on a Recents entry (or a Siri "call X") arrives as an
  // INStartCallIntent user activity — RNCallKeep parses it and emits
  // didReceiveStartCallAction to JS, which resolves the handle back to a chat
  // and starts the outgoing call. Requires INStartCallIntent in the
  // Info.plist NSUserActivityTypes or iOS never delivers the activity.
  override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let callKeepResult = RNCallKeep.application(
      application,
      continue: userActivity,
      restorationHandler: { (_: [Any]?) in }
    )
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result || callKeepResult
  }
}

// MARK: - UIScene lifecycle

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    guard
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory
    else { return }

    let window = UIWindow(windowScene: windowScene)

    // Prevent white flash during tab transitions by giving the window an explicit
    // background that matches the app's dark/light theme at the native level.
    window.backgroundColor = UIColor { traitCollection in
      traitCollection.userInterfaceStyle == .dark
        ? UIColor(red: 18/255, green: 18/255, blue: 18/255, alpha: 1)
        : UIColor(red: 253/255, green: 251/255, blue: 251/255, alpha: 1)
    }
    // If the user previously chose a theme in-app, apply it immediately so
    // the UITabBarController (and all native views) use the correct appearance
    // before JavaScript even loads. Updated live via userDefaultsDidChange.
    if let stored = UserDefaults.standard.object(forKey: "RNThemeIsDark") as? Int {
      window.overrideUserInterfaceStyle = stored == 1 ? .dark : .light
    }

    self.window = window
    // Libraries (RNCallKeep, RN internals) and the theme observer read
    // UIApplication.delegate.window — keep it pointing at the scene's window.
    appDelegate.window = window

    // Synthesize the URL launch option so Linking.getInitialURL() keeps
    // working for cold-start deep links, which scenes deliver via
    // connectionOptions instead of didFinishLaunching.
    var launchOptions = appDelegate.launchOptionsSnapshot ?? [:]
    if let urlContext = connectionOptions.urlContexts.first {
      launchOptions[.url] = urlContext.url
    }

    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
  }

  // MARK: - Privacy screen (app-switcher snapshot protection)
  //
  // When the privacy guard is armed (JS writes PrivacyGuardEnabled=1 to
  // NSUserDefaults, mirroring the RNThemeIsDark bridge), cover the window with
  // a blur before iOS captures the app-switcher/background snapshot, so no
  // real content is preserved in the multitasking preview. Removed on return.
  // Gated on the flag so normal users never see a blur when switching apps.
  private var privacyCover: UIView?

  private func showPrivacyCoverIfArmed() {
    guard UserDefaults.standard.object(forKey: "PrivacyGuardEnabled") as? Int == 1 else { return }
    guard let window = self.window, privacyCover == nil else { return }
    let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
    blur.frame = window.bounds
    blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    window.addSubview(blur)
    privacyCover = blur
  }

  private func hidePrivacyCover() {
    privacyCover?.removeFromSuperview()
    privacyCover = nil
  }

  func sceneWillResignActive(_ scene: UIScene) {
    showPrivacyCoverIfArmed()
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    hidePrivacyCover()
  }

  // Deep links while running (custom scheme — expo-linking, Google auth redirect).
  // Route through the app delegate's open-url chain so every Expo module
  // subscriber receives it, same as the classic lifecycle.
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard
      let url = URLContexts.first?.url,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate
    else { return }
    _ = appDelegate.application(UIApplication.shared, open: url, options: [:])
  }

  // Universal Links while running.
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = appDelegate.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
