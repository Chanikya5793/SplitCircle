internal import Expo
internal import React
internal import ReactAppDependencyProvider

@UIApplicationMain
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    // Prevent white flash during tab transitions by giving the window an explicit
    // background that matches the app's dark/light theme at the native level.
    if #available(iOS 13.0, *) {
      window?.backgroundColor = UIColor { traitCollection in
        traitCollection.userInterfaceStyle == .dark
          ? UIColor(red: 18/255, green: 18/255, blue: 18/255, alpha: 1)
          : UIColor(red: 253/255, green: 251/255, blue: 251/255, alpha: 1)
      }
      // If the user previously chose a theme in-app, apply it immediately so
      // the UITabBarController (and all native views) use the correct appearance
      // before JavaScript even loads. Updated live via userDefaultsDidChange.
      if let stored = UserDefaults.standard.object(forKey: "RNThemeIsDark") as? Int {
        window?.overrideUserInterfaceStyle = stored == 1 ? .dark : .light
      }
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(userDefaultsDidChange(_:)),
        name: UserDefaults.didChangeNotification,
        object: nil
      )
    } else {
      window?.backgroundColor = UIColor(red: 253/255, green: 251/255, blue: 251/255, alpha: 1)
    }
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Called whenever JS writes a theme preference via Settings.set({ RNThemeIsDark: 0|1 }).
  // Updates window.overrideUserInterfaceStyle so the UITabBarController and all other
  // native views reflect the in-app theme rather than the system setting.
  @available(iOS 13.0, *)
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

  // Universal Links
  override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
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
