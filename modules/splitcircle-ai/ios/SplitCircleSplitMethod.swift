import AppIntents

/// The app's split methods, exposed as an `AppEnum` so Siri and the Shortcuts app
/// present a friendly picker ("split by percentage", "split with roulette"). Raw
/// values are the EXACT method identifiers the JS side understands
/// (`ExpenseSplitMethod` in src/models/expense.ts / `METHOD_ORDER` in
/// BillSplitScreen) — they travel verbatim in the `splitcircle://add-expense?split=…`
/// deep link and seed the Split Options editor. Keep these in sync with that union.
///
/// `public` for cross-module App-Intents discovery (see SplitCircleEntities.swift).
@available(iOS 16.0, *)
public enum SplitCircleSplitMethodAppEnum: String, AppEnum {
  case equal
  case exact
  case percentage
  case shares
  case adjustment
  case itemized
  case income
  case consumption
  case timeBased
  case gamified
  case itemType

  public static var typeDisplayRepresentation: TypeDisplayRepresentation = "Split Method"

  public static var caseDisplayRepresentations: [SplitCircleSplitMethodAppEnum: DisplayRepresentation] = [
    .equal: "Equally",
    .exact: "Exact amounts",
    .percentage: "By percentage",
    .shares: "By shares",
    .adjustment: "By adjustment",
    .itemized: "Itemized",
    .income: "By income",
    .consumption: "By consumption",
    .timeBased: "By time",
    .gamified: "Roulette / Karma game",
    .itemType: "By item type",
  ]
}
