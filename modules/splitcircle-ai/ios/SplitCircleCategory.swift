import AppIntents

/// The app's expense categories, exposed as an `AppEnum` so Siri and the Shortcuts
/// app present a friendly category picker on the Add Expense action. Each case's raw
/// value is the EXACT category string the JS side stores (`ALL_EXPENSE_CATEGORIES` in
/// src/utils/categoryMatch.ts) — it travels verbatim in the queued pending-expense
/// record and the JS drain (pendingExpenseService) trusts it as-is. Keep these in sync
/// with that list (guarded by categoryEnumSync.test.ts). Give EVERY case an explicit
/// `= "…"` raw value — a bare `case food` would default to "food" and silently miss the
/// capitalized JS match, falling back to "General".
///
/// `public` for cross-module App-Intents discovery (see SplitCircleEntities.swift).
@available(iOS 17.0, *)
public enum SplitCircleCategoryAppEnum: String, AppEnum {
  case general = "General"
  case food = "Food"
  case transport = "Transport"
  case utilities = "Utilities"
  case entertainment = "Entertainment"
  case shopping = "Shopping"
  case travel = "Travel"
  case health = "Health"
  case rent = "Rent"
  case subscriptions = "Subscriptions"
  case other = "Other"

  public static var typeDisplayRepresentation: TypeDisplayRepresentation = "Expense Category"

  public static var caseDisplayRepresentations: [SplitCircleCategoryAppEnum: DisplayRepresentation] = [
    .general: DisplayRepresentation(title: "General", image: .init(systemName: "tag")),
    .food: DisplayRepresentation(title: "Food", image: .init(systemName: "fork.knife")),
    .transport: DisplayRepresentation(title: "Transport", image: .init(systemName: "car")),
    .utilities: DisplayRepresentation(title: "Utilities", image: .init(systemName: "bolt")),
    .entertainment: DisplayRepresentation(title: "Entertainment", image: .init(systemName: "film")),
    .shopping: DisplayRepresentation(title: "Shopping", image: .init(systemName: "bag")),
    .travel: DisplayRepresentation(title: "Travel", image: .init(systemName: "airplane")),
    .health: DisplayRepresentation(title: "Health", image: .init(systemName: "heart")),
    .rent: DisplayRepresentation(title: "Rent", image: .init(systemName: "house")),
    .subscriptions: DisplayRepresentation(title: "Subscriptions", image: .init(systemName: "repeat")),
    .other: DisplayRepresentation(title: "Other", image: .init(systemName: "ellipsis.circle")),
  ]
}
