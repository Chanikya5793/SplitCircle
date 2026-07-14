import Foundation

// A Widget Extension is a SEPARATE process and can't link the SplitCircleAI Expo pod
// (that would drag in ExpoModulesCore/React). So this is an INTENTIONAL minimal
// duplicate of the read side of SplitCircleSharedStore/SplitCircleIndexReader — read
// only, Foundation only. The three constants below MUST stay byte-identical to
// `SplitCircleSharedStore.swift` (pod) and `widgetService.ts` (JS writer).

enum WidgetSharedStore {
  static let appGroupId = "group.com.splitcircle.app"       // ⚠️ keep in sync
  static let widgetSnapshotFile = "widget.json"             // ⚠️ keep in sync

  struct GroupBalance: Identifiable {
    let id: String
    let name: String
    let memberCount: Int
    let balance: Double
    let currency: String
  }

  struct Snapshot {
    let userId: String
    let updatedAt: Double
    let groups: [GroupBalance]
  }

  /// Read the balance snapshot the app published into the App Group. Returns nil if
  /// the entitlement isn't granted, no snapshot exists yet, or it can't be parsed —
  /// the widget then shows its signed-out / empty state.
  static func read() -> Snapshot? {
    guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
      return nil
    }
    let url = dir.appendingPathComponent(widgetSnapshotFile)
    guard let data = try? Data(contentsOf: url),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }

    let userId = (obj["userId"] as? String) ?? ""
    let updatedAt = (obj["updatedAt"] as? NSNumber)?.doubleValue ?? 0
    let rawGroups = (obj["groups"] as? [[String: Any]]) ?? []
    let groups: [GroupBalance] = rawGroups.compactMap { g in
      guard let id = g["id"] as? String, let name = g["name"] as? String else { return nil }
      return GroupBalance(
        id: id,
        name: name,
        memberCount: (g["memberCount"] as? NSNumber)?.intValue ?? 0,
        balance: (g["balance"] as? NSNumber)?.doubleValue ?? 0,
        currency: (g["currency"] as? String) ?? "USD"
      )
    }
    return Snapshot(userId: userId, updatedAt: updatedAt, groups: groups)
  }

  /// The user's net position across all groups (sum of per-group balances).
  static func netBalance(_ groups: [GroupBalance]) -> Double {
    groups.reduce(0) { $0 + $1.balance }
  }

  static func money(_ value: Double, currency: String) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = currency
    formatter.maximumFractionDigits = 2
    if let s = formatter.string(from: NSNumber(value: value)) { return s }
    return String(format: "%.2f %@", value, currency)
  }
}
