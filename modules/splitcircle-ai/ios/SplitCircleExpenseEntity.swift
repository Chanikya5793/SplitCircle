import AppIntents
import Foundation

/// `AppEntity` for a single expense, so Shortcuts can pass expenses between actions
/// ("Get Recent Expenses" → repeat → use each) and Siri can reference them
/// ("the dinner expense"). Backed by the App Group snapshot (`SplitCircleIndexReader`)
/// so it resolves headless. `public` for cross-module App-Intents discovery (see the
/// note atop SplitCircleEntities.swift).
@available(iOS 16.0, *)
public struct SplitCircleExpenseEntity: AppEntity {
  public let id: String            // "<groupId>::<expenseId>"
  public let title: String
  public let amount: Double
  public let currency: String
  public let category: String
  public let paidByName: String
  public let groupName: String
  public let date: Date

  // `internal` (not public): its parameter is the internal `ExpenseSummary`, and
  // Swift forbids a public init exposing an internal type. Only ever called inside
  // this pod module (queries, intents, indexer), so internal is sufficient.
  init(from e: SplitCircleIndexReader.ExpenseSummary) {
    self.id = e.id
    self.title = e.title
    self.amount = e.amount
    self.currency = e.currency
    self.category = e.category
    self.paidByName = e.paidByName
    self.groupName = e.groupName
    self.date = Date(timeIntervalSince1970: e.date / 1000.0)
  }

  public static var typeDisplayRepresentation: TypeDisplayRepresentation = "Expense"

  public var displayRepresentation: DisplayRepresentation {
    let money = SplitCircleFormat.money(amount, currency: currency)
    return DisplayRepresentation(
      title: "\(title)",
      subtitle: "\(money) · \(category) · \(groupName)"
    )
  }

  public static var defaultQuery = SplitCircleExpenseQuery()
}

/// Resolves expense entities for Shortcuts pickers, by-id lookups, and text search
/// ("find the taxi expense"). Reads the current user's recent expenses across groups.
@available(iOS 16.0, *)
public struct SplitCircleExpenseQuery: EntityQuery {
  public init() {}

  public func entities(for identifiers: [String]) async throws -> [SplitCircleExpenseEntity] {
    guard let userId = SplitCircleCurrentUser.read() else { return [] }
    let wanted = Set(identifiers)
    return SplitCircleIndexReader.recentExpenses(userId: userId, limit: 200)
      .filter { wanted.contains($0.id) }
      .map(SplitCircleExpenseEntity.init)
  }

  public func suggestedEntities() async throws -> [SplitCircleExpenseEntity] {
    guard let userId = SplitCircleCurrentUser.read() else { return [] }
    return SplitCircleIndexReader.recentExpenses(userId: userId, limit: 20)
      .map(SplitCircleExpenseEntity.init)
  }
}

@available(iOS 16.0, *)
extension SplitCircleExpenseQuery: EntityStringQuery {
  public func entities(matching string: String) async throws -> [SplitCircleExpenseEntity] {
    guard let userId = SplitCircleCurrentUser.read() else { return [] }
    let needle = string.lowercased()
    return SplitCircleIndexReader.recentExpenses(userId: userId, limit: 200)
      .filter { $0.title.lowercased().contains(needle) || $0.category.lowercased().contains(needle) }
      .map(SplitCircleExpenseEntity.init)
  }
}

// iOS 27 semantic index conformance (additive, guarded — same pattern as the group
// entity). Lets Siri resolve vaguer references to expenses once indexed.
#if compiler(>=6.4)
@available(iOS 27.0, *)
extension SplitCircleExpenseEntity: IndexedEntity {}
#endif
