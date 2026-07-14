import Foundation
import SQLite3

/// Read side of the Siri/App-Intents/widget data layer. Primary source is the App
/// Group `widget.json` snapshot `widgetService.ts` publishes (rich per-group data:
/// balances, per-member, categories, who-you-owe, recent expenses). Falls back to the
/// expo-sqlite `ai_index.db` for the basic group list/balance when no snapshot exists
/// yet (e.g. right after this build first installs). Read-only, best-effort — a
/// headless intent degrades to "no data" rather than crashing Siri's process. Numbers
/// are authored by the JS `expenseAnalytics` engine; nothing is recomputed here.
enum SplitCircleIndexReader {
  // MARK: - Models

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

  struct MemberBalance { let id: String; let name: String; let balance: Double }
  struct CategoryTotal { let category: String; let total: Double }
  struct OwedEntry { let name: String; let amount: Double }

  struct ExpenseSummary: Identifiable {
    let id: String            // "<groupId>::<expenseId>"
    let title: String
    let amount: Double
    let category: String
    let date: Double          // epoch ms
    let paidByName: String
    let groupName: String
    let currency: String
  }

  struct RichGroup {
    let id: String
    let name: String
    let memberCount: Int
    let balance: Double
    let currency: String
    let totalSpend: Double
    let count: Int
    let members: [MemberBalance]
    let categories: [CategoryTotal]
    let youOwe: [OwedEntry]
    let owesYou: [OwedEntry]
    let recent: [ExpenseSummary]
  }

  // MARK: - Public API

  static func groups(forUser userId: String) -> [GroupSummary] {
    let rich = richGroups(forUser: userId)
    if !rich.isEmpty {
      return rich.map { GroupSummary(id: $0.id, name: $0.name, memberCount: $0.memberCount, balance: $0.balance, currency: $0.currency) }
    }
    return sqliteGroups(forUser: userId)
  }

  static func group(id groupId: String, userId: String) -> GroupSummary? {
    groups(forUser: userId).first { $0.id == groupId }
  }

  static func balance(groupId: String, userId: String) -> Balance? {
    if let g = richGroups(forUser: userId).first(where: { $0.id == groupId }) {
      return Balance(userBalance: g.balance, currency: g.currency)
    }
    return sqliteBalance(groupId: groupId, userId: userId)
  }

  /// Net position across ALL groups (sum of per-group balances). Currency is taken
  /// from the first group — a mixed-currency total is only meaningful as a hint.
  static func netBalance(userId: String) -> Balance? {
    let rich = richGroups(forUser: userId)
    guard !rich.isEmpty else { return nil }
    let sum = rich.reduce(0.0) { $0 + $1.balance }
    return Balance(userBalance: sum, currency: rich.first?.currency)
  }

  /// Recent expenses, optionally scoped to one group, newest first.
  static func recentExpenses(userId: String, groupId: String? = nil, limit: Int = 10) -> [ExpenseSummary] {
    let groups = richGroups(forUser: userId)
    let pool: [ExpenseSummary]
    if let groupId {
      pool = groups.first(where: { $0.id == groupId })?.recent ?? []
    } else {
      pool = groups.flatMap { $0.recent }.sorted { $0.date > $1.date }
    }
    return Array(pool.prefix(max(0, limit)))
  }

  static func expense(id: String, userId: String) -> ExpenseSummary? {
    richGroups(forUser: userId).flatMap { $0.recent }.first { $0.id == id }
  }

  /// (amount you owe them, amount they owe you, currency) for a person by name.
  static func amountOwed(groupId: String, userId: String, personName: String) -> (owe: Double, owed: Double, currency: String)? {
    guard let g = richGroups(forUser: userId).first(where: { $0.id == groupId }) else { return nil }
    let needle = personName.lowercased()
    let owe = g.youOwe.first { $0.name.lowercased() == needle }?.amount ?? 0
    let owed = g.owesYou.first { $0.name.lowercased() == needle }?.amount ?? 0
    return (owe, owed, g.currency)
  }

  /// Members of one group (id + display name), for the Siri "who's in the split"
  /// participant picker and for defaulting a headless expense to everyone. Members
  /// without a resolvable id (pre-id snapshots) are dropped — they can't be split to.
  static func members(forGroup groupId: String, userId: String) -> [(id: String, name: String)] {
    guard let g = richGroups(forUser: userId).first(where: { $0.id == groupId }) else { return [] }
    return g.members.filter { !$0.id.isEmpty }.map { (id: $0.id, name: $0.name) }
  }

  /// Every member across all the user's groups, as (personId "groupId::userId",
  /// name, groupName). Backs the participant EntityQuery (union across groups; the
  /// intent filters to the chosen group at perform time).
  static func allPeople(forUser userId: String) -> [(personId: String, name: String, groupName: String)] {
    richGroups(forUser: userId).flatMap { g in
      g.members.filter { !$0.id.isEmpty }.map {
        (personId: "\(g.id)::\($0.id)", name: $0.name, groupName: g.name)
      }
    }
  }

  static func categorySpend(groupId: String, userId: String, category: String) -> (total: Double, currency: String)? {
    guard let g = richGroups(forUser: userId).first(where: { $0.id == groupId }) else { return nil }
    let needle = category.lowercased()
    guard let match = g.categories.first(where: { $0.category.lowercased() == needle }) else {
      return (0, g.currency)
    }
    return (match.total, g.currency)
  }

  // MARK: - Source 1: App Group snapshot (rich parse)

  static func richGroups(forUser userId: String) -> [RichGroup] {
    // 1. App Group snapshot — the ONLY source the SEPARATE widget process can read,
    //    so it stays primary. Requires the App Group entitlement (docs/19 runbook).
    if let data = appGroupSnapshotData(),
       let groups = parseRichSnapshot(data, expectedUser: userId), !groups.isEmpty {
      return groups
    }
    // 2. SQLite mirror in the app's OWN container — written alongside the App Group
    //    copy by widgetService.ts (`widget_snapshot` table). A headless App Intent
    //    runs in the app process and can read its Documents DB, so this makes reads
    //    ("balance", "recent expenses", "what do I owe X") work BEFORE the App Group
    //    capability is provisioned — the current state.
    if let data = sqliteSnapshotData(forUser: userId),
       let groups = parseRichSnapshot(data, expectedUser: userId) {
      return groups
    }
    return []
  }

  private static func appGroupSnapshotData() -> Data? {
    guard let dir = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: SplitCircleSharedStore.appGroupId
    ) else { return nil }
    let url = dir.appendingPathComponent(SplitCircleSharedStore.widgetSnapshotFile)
    return try? Data(contentsOf: url)
  }

  private static func parseRichSnapshot(_ data: Data, expectedUser userId: String) -> [RichGroup]? {
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          (obj["userId"] as? String) == userId,
          let rawGroups = obj["groups"] as? [[String: Any]]
    else { return nil }

    return rawGroups.compactMap { g -> RichGroup? in
      guard let id = g["id"] as? String, let name = g["name"] as? String else { return nil }
      let currency = (g["currency"] as? String) ?? "USD"
      let entries = (g["recentExpenses"] as? [[String: Any]]) ?? []
      let recent: [ExpenseSummary] = entries.compactMap { e in
        guard let eid = e["id"] as? String, let title = e["title"] as? String else { return nil }
        return ExpenseSummary(
          id: eid,
          title: title,
          amount: (e["amount"] as? NSNumber)?.doubleValue ?? 0,
          category: (e["category"] as? String) ?? "General",
          date: (e["date"] as? NSNumber)?.doubleValue ?? 0,
          paidByName: (e["paidByName"] as? String) ?? "Someone",
          groupName: name,
          currency: currency
        )
      }
      func owed(_ key: String) -> [OwedEntry] {
        ((g[key] as? [[String: Any]]) ?? []).compactMap {
          guard let n = $0["name"] as? String else { return nil }
          return OwedEntry(name: n, amount: ($0["amount"] as? NSNumber)?.doubleValue ?? 0)
        }
      }
      let members: [MemberBalance] = ((g["members"] as? [[String: Any]]) ?? []).compactMap {
        guard let n = $0["name"] as? String else { return nil }
        return MemberBalance(
          id: ($0["id"] as? String) ?? "",
          name: n,
          balance: ($0["balance"] as? NSNumber)?.doubleValue ?? 0
        )
      }
      let categories: [CategoryTotal] = ((g["categories"] as? [[String: Any]]) ?? []).compactMap {
        guard let c = $0["category"] as? String else { return nil }
        return CategoryTotal(category: c, total: ($0["total"] as? NSNumber)?.doubleValue ?? 0)
      }
      return RichGroup(
        id: id,
        name: name,
        memberCount: (g["memberCount"] as? NSNumber)?.intValue ?? members.count,
        balance: (g["balance"] as? NSNumber)?.doubleValue ?? 0,
        currency: currency,
        totalSpend: (g["totalSpend"] as? NSNumber)?.doubleValue ?? 0,
        count: (g["count"] as? NSNumber)?.intValue ?? 0,
        members: members,
        categories: categories,
        youOwe: owed("youOwe"),
        owesYou: owed("owesYou"),
        recent: recent
      )
    }
  }

  // MARK: - Source 2: expo-sqlite ai_index.db fallback (basic only)

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

  /// Read the full rich snapshot JSON (published by widgetService.ts) for a user.
  /// Returns raw bytes so `parseRichSnapshot` handles it identically to the App
  /// Group copy. Missing table (first run, before any snapshot write) → nil.
  private static func sqliteSnapshotData(forUser userId: String) -> Data? {
    withReadOnlyDb { db -> Data? in
      var stmt: OpaquePointer?
      let sql = "SELECT json FROM widget_snapshot WHERE userId = ?;"
      guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let statement = stmt else { return nil }
      defer { sqlite3_finalize(statement) }
      sqlite3_bind_text(statement, 1, userId, -1, SQLITE_TRANSIENT_STATIC)
      guard sqlite3_step(statement) == SQLITE_ROW, let jsonC = sqlite3_column_text(statement, 0) else { return nil }
      return String(cString: jsonC).data(using: .utf8)
    } ?? nil
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
