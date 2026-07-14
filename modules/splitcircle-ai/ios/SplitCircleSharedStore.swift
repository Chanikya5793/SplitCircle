import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

/// Cross-process/cross-runtime shared storage for the Siri + widget surfaces.
///
/// Two distinct channels, deliberately kept separate because they have different
/// process-visibility needs:
///
/// 1. **App Group container** (`group.com.splitcircle.app`) — the ONLY storage a
///    Widget Extension (a *separate* process with its own sandbox) can read. The
///    app writes `widget.json` here; the widget reads it. See `WidgetSharedStore`
///    in the widget target for the read side (an intentional minimal duplicate —
///    the widget can't link this Expo pod without dragging in ExpoModulesCore).
///
/// 2. **`UserDefaults.standard`** — shared between the app's JS runtime (via
///    react-native `Settings`) and App Intents that run IN the app process (the
///    pod's intents launch a background instance of the main app, same standard
///    defaults domain). Used for the current-user id and the pending-deep-link
///    handoff. A Widget Extension can NOT see this (different process) — that's
///    why balances go through the App Group instead.
///
/// Every method is best-effort and never throws outward: a Siri/widget path must
/// degrade to "no data" rather than crash. If the App Group entitlement isn't
/// granted yet (see ai_layer/docs/19 runbook), `appGroupURL` is nil and the widget
/// simply shows its empty state.
public enum SplitCircleSharedStore {
  // These three constants are a CONTRACT with the JS side (widgetService.ts) and
  // the widget target (WidgetSharedStore.swift). Change them in all places at once.
  public static let appGroupId = "group.com.splitcircle.app"
  public static let widgetSnapshotFile = "widget.json"
  public static let pendingDeepLinkKey = "SplitCirclePendingDeepLink"

  private static var appGroupURL: URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
  }

  // MARK: - Widget snapshot (App Group)

  /// Persist the compact balance snapshot the widget renders, then nudge WidgetKit
  /// to refresh its timelines. `json` is authored JS-side (widgetService.ts) so the
  /// numbers come from the same `expenseAnalytics` engine as everything else — this
  /// only relays bytes, it never computes a balance (same "native never does the
  /// arithmetic" discipline as the rest of the AI layer).
  public static func writeWidgetSnapshot(_ json: String) {
    guard let dir = appGroupURL else { return }
    let url = dir.appendingPathComponent(widgetSnapshotFile)
    guard let data = json.data(using: .utf8) else { return }
    try? data.write(to: url, options: .atomic)
    reloadWidgets()
  }

  public static func reloadWidgets() {
    #if canImport(WidgetKit)
    if #available(iOS 14.0, *) {
      WidgetCenter.shared.reloadAllTimelines()
    }
    #endif
  }

  // MARK: - Pending deep link (UserDefaults.standard, in-process only)

  /// Stash a `splitcircle://…` URL an App Intent wants the app to open on next
  /// foreground. Read + cleared JS-side by deepLinkService.ts. Uses standard
  /// defaults (NOT the app group) because only the in-process app + its JS runtime
  /// need it — never the widget.
  public static func setPendingDeepLink(_ url: String) {
    UserDefaults.standard.set(url, forKey: pendingDeepLinkKey)
  }
}
