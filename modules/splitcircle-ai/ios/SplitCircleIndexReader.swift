import Foundation
import SQLite3

/// Read side of the Siri/App-Intents data layer. Two sources, tried in order:
///
/// 1. **App Group `widget.json`** (primary) — the compact snapshot `widgetService.ts`
///    publishes on every group refresh: id, name, memberCount, balance, currency,
///    per current user. This is the preferred source because it (a) already carries
///    the balance, (b) is readable from BOTH the in-process intents AND a widget
///    extension, and (c) needs no SQLite linkage. Written via
///    `SplitCircleSharedStore.writeWidgetSnapshot`.
///
/// 2. **`<Documents>/SQLite/ai_index.db`** (fallback) — the richer expo-sqlite index
///    `aiIndexStore.ts` writes (`groups_meta` + `ai_index`). Covers the window before
///    the first widget snapshot exists (e.g. right after this build first installs,
///    before any group refresh has run). Only reachable from the in-process app, not
///    a widget extension.
///
/// Everything is best-effort/read-only: a headless intent degrades to "unavailable"
/// rather than crashing Siri's process. Currency comes through on the snapshot path.
enum SplitCircleIndexReader {
  struct GroupSummary: Identifiable {
    let id: String
    let name: String
    let memberCount: Int
    let balance: Double?
    let currency: String?
  }

  struct Balance {
    let userBalance: Double
    let currency: String?
  }

  // MARK: - Public API (source-agnostic)

  static func groups(forUser userId: String) -> [GroupSummary] {
    if let snap = snapshotGroups(forUser: userId), !snap.isEmpty { return snap }
    return sqliteGroups(forUser: userId)
  }

  static func group(id groupId: String, userId: String) -> GroupSummary? {
    groups(forUser: userId).first { $0.id == groupId }
  }

  /// Deterministic balance — NEVER computed here; read from the snapshot (or the
  /// SQLite analytics JSON), both authored by the JS `expenseAnalytics` engine.
  static func balance(groupId: String, userId: String) -> Balance? {
    if let g = snapshotGroups(forUser: userId)?.first(where: { $0.id == groupId }),
       let b = g.balance {
      return Balance(userBalance: b, currency: g.currency)
    }
    return sqliteBalance(groupId: groupId, userId: userId)
  }

  // MARK: - Source 1: App Group snapshot (widget.json)

  private static func snapshotGroups(forUser userId: String) -> [GroupSummary]? {
    guard let dir = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: SplitCircleSharedStore.appGroupId
    ) else { return nil }
    let url = dir.appendingPathComponent(SplitCircleSharedStore.widgetSnapshotFile)
    guard let data = try? Data(contentsOf: url),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    // Only trust the snapshot if it belongs to the currently signed-in user.
    guard (obj["userId"] as? String) == userId else { return nil }
    guard let rawGroups = obj["groups"] as? [[String: Any]] else { return nil }
    return rawGroups.compactMap { g in
      guard let id = g["id"] as? String, let name = g["name"] as? String else { return nil }
      return GroupSummary(
        id: id,
        name: name,
        memberCount: (g["memberCount"] as? NSNumber)?.intValue ?? 0,
        balance: (g["balance"] as? NSNumber)?.doubleValue,
        currency: g["currency"] as? String
      )
    }
  }

  // MARK: - Source 2: expo-sqlite ai_index.db (Documents)

  private static var dbPath: String? = {
    guard let docs = try? FileManager.default.url(
      for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: false
    ) else { return nil }
    let path = docs.appendingPathComponent("SQLite").appendingPathComponent("ai_index.db").path
    return FileManager.default.fileExists(atPath: path) ? path : nil
  }()

  private static func withReadOnlyDb<T>(_ body: (OpaquePointer) -> T?) -> T? {
    guard let path = dbPath else { return nil }
    var db: OpaquePointer?
    guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let handle = db else {
      if let db { sqlite3_close(db) }
      return nil
    }
    defer { sqlite3_close(handle) }
    sqlite3_busy_timeout(handle, 500)
    return body(handle)
  }

  private static func sqliteGroups(forUser userId: String) -> [GroupSummary] {
    withReadOnlyDb { db -> [GroupSummary] in
      var stmt: OpaquePointer?
      let sql = "SELECT groupId, name, memberCount FROM groups_meta WHERE userId = ? ORDER BY updatedAt DESC;"
      guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let statement = stmt else { return [] }
      defer { sqlite3_finalize(statement) }
      sqlite3_bind_text(statement, 1, userId, -1, SQLITE_TRANSIENT_STATIC)
      var results: [GroupSummary] = []
      while sqlite3_step(statement) == SQLITE_ROW {
        guard let idC = sqlite3_column_text(statement, 0), let nameC = sqlite3_column_text(statement, 1) else { continue }
        results.append(GroupSummary(
          id: String(cString: idC),
          name: String(cString: nameC),
          memberCount: Int(sqlite3_column_int(statement, 2)),
          balance: nil,
          currency: nil
        ))
      }
      return results
    } ?? []
  }

  private static func sqliteBalance(groupId: String, userId: String) -> Balance? {
    withReadOnlyDb { db -> Balance? in
      var stmt: OpaquePointer?
      let sql = "SELECT analyticsJson FROM ai_index WHERE groupId = ?;"
      guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let statement = stmt else { return nil }
      defer { sqlite3_finalize(statement) }
      let rowKey = "\(groupId)::\(userId)"
      sqlite3_bind_text(statement, 1, rowKey, -1, SQLITE_TRANSIENT_STATIC)
      guard sqlite3_step(statement) == SQLITE_ROW, let jsonC = sqlite3_column_text(statement, 0) else { return nil }
      let json = String(cString: jsonC)
      guard let data = json.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { return nil }
      return Balance(userBalance: (obj["userBalance"] as? NSNumber)?.doubleValue ?? 0, currency: nil)
    } ?? nil
  }
}

private let SQLITE_TRANSIENT_STATIC = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
