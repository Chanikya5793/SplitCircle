import AppIntents
import Foundation

// All App Intents are `public` — this pod compiles as a separate Swift module from
// the app target, and App Intents declared `internal` in a dependency module are a
// known cause of "the shortcut silently doesn't register" (see the access-control
// note atop SplitCircleEntities.swift and ai_layer/docs/18 §3.1).

// MARK: - Read intents (headless — answer without launching the app)

/// "How much do I owe in [group]?" Answered HEADLESS from the App Group snapshot /
/// SQLite index (`SplitCircleIndexReader`). Deterministic — no LLM does arithmetic,
/// matching the app-wide rule; a headless intent has no Foundation Models session
/// available anyway.
@available(iOS 16.0, *)
public struct GetGroupBalanceIntent: AppIntent {
  public static var title: LocalizedStringResource = "Check SplitCircle Balance"
  public static var description = IntentDescription("Ask what you owe or are owed in a SplitCircle group.")

  @Parameter(title: "Group")
  public var group: SplitCircleGroupEntity

  public static var parameterSummary: some ParameterSummary {
    Summary("Check my balance in \(\.$group)")
  }

  public init() {}

  // Returns the signed balance (+ owed to you, − you owe) so Shortcuts can use the
  // number in a later action, plus a spoken dialog for Siri.
  public func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<Double> {
    guard let userId = SplitCircleCurrentUser.read() else {
      return .result(value: 0, dialog: "Sign in to SplitCircle first, then ask me again.")
    }
    guard let balance = SplitCircleIndexReader.balance(groupId: group.id, userId: userId) else {
      return .result(value: 0, dialog: "I don't have \(group.name) indexed yet — open SplitCircle once, then ask me again.")
    }
    let amount = SplitCircleFormat.money(abs(balance.userBalance), currency: balance.currency)
    let dialog: String
    if abs(balance.userBalance) < 0.01 {
      dialog = "You're settled up in \(group.name)."
    } else if balance.userBalance < 0 {
      dialog = "You owe \(amount) in \(group.name)."
    } else {
      dialog = "You're owed \(amount) in \(group.name)."
    }
    return .result(value: balance.userBalance, dialog: IntentDialog(stringLiteral: dialog))
  }
}

/// "What's my overall SplitCircle balance?" — net across every group. Returns the
/// number + a spoken summary. Headless.
@available(iOS 16.0, *)
public struct GetNetBalanceIntent: AppIntent {
  public static var title: LocalizedStringResource = "Check Overall SplitCircle Balance"
  public static var description = IntentDescription("Your net balance across all SplitCircle groups.")

  public init() {}

  public func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<Double> {
    guard let userId = SplitCircleCurrentUser.read() else {
      return .result(value: 0, dialog: "Sign in to SplitCircle first, then ask me again.")
    }
    guard let net = SplitCircleIndexReader.netBalance(userId: userId) else {
      return .result(value: 0, dialog: "Open SplitCircle once so I can total up your groups, then ask me again.")
    }
    let amount = SplitCircleFormat.money(abs(net.userBalance), currency: net.currency)
    let dialog: String
    if abs(net.userBalance) < 0.01 {
      dialog = "You're all settled up across your groups."
    } else if net.userBalance < 0 {
      dialog = "Overall you owe \(amount)."
    } else {
      dialog = "Overall you're owed \(amount)."
    }
    return .result(value: net.userBalance, dialog: IntentDialog(stringLiteral: dialog))
  }
}

/// "Show my recent SplitCircle expenses" (optionally in one group). Returns a list of
/// Expense entities Shortcuts can loop over. Headless.
@available(iOS 16.0, *)
public struct GetRecentExpensesIntent: AppIntent {
  public static var title: LocalizedStringResource = "Get Recent SplitCircle Expenses"
  public static var description = IntentDescription("The most recent expenses, across all groups or one group.")

  @Parameter(title: "Group (optional)")
  public var group: SplitCircleGroupEntity?

  @Parameter(title: "How many", default: 5, controlStyle: .field, inclusiveRange: (1, 25))
  public var limit: Int

  public static var parameterSummary: some ParameterSummary {
    Summary("Get \(\.$limit) recent expenses in \(\.$group)")
  }

  public init() {}

  public func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<[SplitCircleExpenseEntity]> {
    guard let userId = SplitCircleCurrentUser.read() else {
      return .result(value: [], dialog: "Sign in to SplitCircle first, then ask me again.")
    }
    let expenses = SplitCircleIndexReader
      .recentExpenses(userId: userId, groupId: group?.id, limit: limit)
      .map(SplitCircleExpenseEntity.init)
    let dialog = expenses.isEmpty ? "I don't see any recent expenses." : "Here are your \(expenses.count) most recent expenses."
    return .result(value: expenses, dialog: IntentDialog(stringLiteral: dialog))
  }
}

/// "How much do I owe <person> in <group>?" Returns the signed amount (+ you owe them).
@available(iOS 16.0, *)
public struct GetAmountOwedIntent: AppIntent {
  public static var title: LocalizedStringResource = "Check What You Owe Someone"
  public static var description = IntentDescription("How much you owe or are owed by a specific person in a group.")

  @Parameter(title: "Group")
  public var group: SplitCircleGroupEntity

  @Parameter(title: "Person")
  public var person: String

  public static var parameterSummary: some ParameterSummary {
    Summary("Check what you owe \(\.$person) in \(\.$group)")
  }

  public init() {}

  public func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<Double> {
    guard let userId = SplitCircleCurrentUser.read() else {
      return .result(value: 0, dialog: "Sign in to SplitCircle first, then ask me again.")
    }
    guard let r = SplitCircleIndexReader.amountOwed(groupId: group.id, userId: userId, personName: person) else {
      return .result(value: 0, dialog: "Open SplitCircle once, then ask me again.")
    }
    let net = r.owe - r.owed // + = you owe them, − = they owe you
    let money = SplitCircleFormat.money(abs(net), currency: r.currency)
    let dialog: String
    if abs(net) < 0.01 {
      dialog = "You're settled up with \(person) in \(group.name)."
    } else if net > 0 {
      dialog = "You owe \(person) \(money) in \(group.name)."
    } else {
      dialog = "\(person) owes you \(money) in \(group.name)."
    }
    return .result(value: net, dialog: IntentDialog(stringLiteral: dialog))
  }
}

/// "How much have I spent on <category> in <group>?" Returns the category total.
@available(iOS 16.0, *)
public struct GetCategorySpendIntent: AppIntent {
  public static var title: LocalizedStringResource = "Check Category Spending"
  public static var description = IntentDescription("Total spent in a category within a SplitCircle group.")

  @Parameter(title: "Group")
  public var group: SplitCircleGroupEntity

  @Parameter(title: "Category")
  public var category: String

  public static var parameterSummary: some ParameterSummary {
    Summary("Check \(\.$category) spending in \(\.$group)")
  }

  public init() {}

  public func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<Double> {
    guard let userId = SplitCircleCurrentUser.read() else {
      return .result(value: 0, dialog: "Sign in to SplitCircle first, then ask me again.")
    }
    guard let r = SplitCircleIndexReader.categorySpend(groupId: group.id, userId: userId, category: category) else {
      return .result(value: 0, dialog: "Open SplitCircle once, then ask me again.")
    }
    let money = SplitCircleFormat.money(r.total, currency: r.currency)
    let dialog = r.total < 0.01
      ? "No \(category) spending recorded in \(group.name) yet."
      : "\(group.name) has \(money) of \(category) spending."
    return .result(value: r.total, dialog: IntentDialog(stringLiteral: dialog))
  }
}

/// "List my SplitCircle groups" — headless enumeration; also a Shortcuts building block.
@available(iOS 16.0, *)
public struct ListSplitCircleGroupsIntent: AppIntent {
  public static var title: LocalizedStringResource = "List SplitCircle Groups"
  public static var description = IntentDescription("See your SplitCircle groups and what you owe in each.")

  public init() {}

  public func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<[SplitCircleGroupEntity]> {
    guard let userId = SplitCircleCurrentUser.read() else {
      return .result(value: [], dialog: "Sign in to SplitCircle first, then ask me again.")
    }
    let groups = SplitCircleIndexReader.groups(forUser: userId)
      .map { SplitCircleGroupEntity(id: $0.id, name: $0.name, memberCount: $0.memberCount) }
    let dialog = groups.isEmpty
      ? "You don't have any SplitCircle groups yet."
      : "You're in \(groups.count) SplitCircle \(groups.count == 1 ? "group" : "groups")."
    return .result(value: groups, dialog: IntentDialog(stringLiteral: dialog))
  }
}

// MARK: - Open / control intents (foreground the app at a specific place)
//
// These "control the app" by opening it prefilled. Rather than the version-sensitive
// `requestConfirmation` API (which we can't compile-check against the pinned Xcode
// 26.4 ship image), the confirmation IS the real, tested UI: Siri gathers the params,
// the app opens the actual Add-Expense / Settle-Up / group screen prefilled, and the
// user reviews + taps Save through the existing validated flow. The handoff is a
// `splitcircle://` URL stashed in `UserDefaults.standard` (shared with the JS runtime
// because these intents run IN the app process) and consumed by deepLinkService.ts on
// the next foreground. Truly-headless queued writes remain a documented Phase 2
// (ai_layer/docs/18 §4).

/// "Open [group] in SplitCircle."
@available(iOS 16.0, *)
public struct OpenGroupIntent: AppIntent {
  public static var title: LocalizedStringResource = "Open SplitCircle Group"
  public static var description = IntentDescription("Open one of your SplitCircle groups.")
  public static var openAppWhenRun = true

  @Parameter(title: "Group")
  public var group: SplitCircleGroupEntity

  public static var parameterSummary: some ParameterSummary { Summary("Open \(\.$group)") }

  public init() {}

  public func perform() async throws -> some IntentResult {
    SplitCircleSharedStore.setPendingDeepLink("splitcircle://group/\(SplitCircleFormat.pathSafe(group.id))")
    return .result()
  }
}

/// "Add a $20 dinner to [group]." Opens Add-Expense prefilled; the user saves.
@available(iOS 16.0, *)
public struct AddExpenseIntent: AppIntent {
  public static var title: LocalizedStringResource = "Add SplitCircle Expense"
  public static var description = IntentDescription("Start a new expense in a SplitCircle group.")
  public static var openAppWhenRun = true

  @Parameter(title: "Group")
  public var group: SplitCircleGroupEntity

  @Parameter(title: "Amount")
  public var amount: Double

  @Parameter(title: "Description", default: "")
  public var title: String

  // How to split it — Siri/Shortcuts picker over the app's 11 split methods. Optional
  // (defaults to equal). A non-equal choice opens the Split Options editor prefilled
  // on that method so the user can customize the actual shares/percentages/game.
  @Parameter(title: "Split method")
  public var splitMethod: SplitCircleSplitMethodAppEnum?

  public static var parameterSummary: some ParameterSummary {
    Summary("Add \(\.$amount) for \(\.$title) to \(\.$group)") {
      \.$splitMethod
    }
  }

  public init() {}

  public func perform() async throws -> some IntentResult {
    var url = "splitcircle://add-expense?group=\(SplitCircleFormat.pathSafe(group.id))&amount=\(amount)"
    if !title.isEmpty {
      url += "&title=\(SplitCircleFormat.queryEncoded(title))"
    }
    if let splitMethod, splitMethod != .equal {
      url += "&split=\(splitMethod.rawValue)"
    }
    SplitCircleSharedStore.setPendingDeepLink(url)
    return .result()
  }
}

/// "Settle up in [group]." Opens the group's settle-up flow.
@available(iOS 16.0, *)
public struct SettleUpIntent: AppIntent {
  public static var title: LocalizedStringResource = "Settle Up in SplitCircle"
  public static var description = IntentDescription("Open the settle-up flow for a SplitCircle group.")
  public static var openAppWhenRun = true

  @Parameter(title: "Group")
  public var group: SplitCircleGroupEntity

  public static var parameterSummary: some ParameterSummary { Summary("Settle up in \(\.$group)") }

  public init() {}

  public func perform() async throws -> some IntentResult {
    SplitCircleSharedStore.setPendingDeepLink("splitcircle://settle?group=\(SplitCircleFormat.pathSafe(group.id))")
    return .result()
  }
}

/// Open-ended Q&A — needs the on-device Foundation Models pipeline, which needs the
/// app process, so this opens the app and hands the question off via the existing
/// `com.splitcircle.ask-ai` NSUserActivity (donateAskActivity path).
@available(iOS 16.0, *)
public struct AskSplitCircleIntent: AppIntent {
  public static var title: LocalizedStringResource = "Ask SplitCircle"
  public static var description = IntentDescription("Ask SplitCircle a question about a group's shared expenses.")
  public static var openAppWhenRun = true

  // SplitCircle's assistant is per-group (it grounds answers in one group's
  // expenses), so the question needs a group to open into.
  @Parameter(title: "Group")
  public var group: SplitCircleGroupEntity

  @Parameter(title: "Question")
  public var question: String

  public static var parameterSummary: some ParameterSummary {
    Summary("Ask SplitCircle \(\.$question) about \(\.$group)")
  }

  public init() {}

  public func perform() async throws -> some IntentResult {
    let url = "splitcircle://ask?group=\(SplitCircleFormat.pathSafe(group.id))&q=\(SplitCircleFormat.queryEncoded(question))"
    SplitCircleSharedStore.setPendingDeepLink(url)
    return .result()
  }
}

// MARK: - Shortcuts / Siri phrase donation

@available(iOS 16.0, *)
public struct SplitCircleShortcuts: AppShortcutsProvider {
  public static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: GetGroupBalanceIntent(),
      phrases: [
        "Check my \(.applicationName) balance",
        "What do I owe in \(\.$group) on \(.applicationName)",
      ],
      shortTitle: "Check Balance",
      systemImageName: "creditcard"
    )
    AppShortcut(
      intent: ListSplitCircleGroupsIntent(),
      phrases: ["List my \(.applicationName) groups", "Show my \(.applicationName) groups"],
      shortTitle: "My Groups",
      systemImageName: "person.3"
    )
    AppShortcut(
      intent: GetNetBalanceIntent(),
      phrases: [
        "What's my overall \(.applicationName) balance",
        "Am I up or down on \(.applicationName)",
      ],
      shortTitle: "Overall Balance",
      systemImageName: "chart.line.uptrend.xyaxis"
    )
    // NOTE: AppShortcut phrases may interpolate at most ONE parameter and it must be
    // an AppEntity/AppEnum (not a String, not an optional). So these phrases stay
    // param-free or reference only the required group entity; Siri prompts for the
    // rest (person, category, count) when the shortcut runs.
    AppShortcut(
      intent: GetRecentExpensesIntent(),
      phrases: ["Show my recent \(.applicationName) expenses"],
      shortTitle: "Recent Expenses",
      systemImageName: "list.bullet.rectangle"
    )
    AppShortcut(
      intent: GetAmountOwedIntent(),
      phrases: ["What do I owe in \(\.$group) on \(.applicationName)"],
      shortTitle: "What You Owe",
      systemImageName: "arrow.left.arrow.right"
    )
    AppShortcut(
      intent: GetCategorySpendIntent(),
      phrases: ["Check category spending in \(\.$group) on \(.applicationName)"],
      shortTitle: "Category Spend",
      systemImageName: "chart.pie"
    )
    AppShortcut(
      intent: AddExpenseIntent(),
      phrases: ["Add an expense in \(.applicationName)", "New \(.applicationName) expense in \(\.$group)"],
      shortTitle: "Add Expense",
      systemImageName: "plus.circle"
    )
    AppShortcut(
      intent: SettleUpIntent(),
      phrases: ["Settle up in \(.applicationName)", "Settle up \(\.$group) on \(.applicationName)"],
      shortTitle: "Settle Up",
      systemImageName: "checkmark.circle"
    )
    AppShortcut(
      intent: OpenGroupIntent(),
      phrases: ["Open \(\.$group) in \(.applicationName)"],
      shortTitle: "Open Group",
      systemImageName: "arrow.up.forward.app"
    )
    AppShortcut(
      intent: AskSplitCircleIntent(),
      phrases: ["Ask \(.applicationName) about \(\.$group)"],
      shortTitle: "Ask SplitCircle",
      systemImageName: "bubble.left.and.bubble.right"
    )
  }
}

// MARK: - Small formatting helpers (shared by the intents)

enum SplitCircleFormat {
  static func money(_ value: Double, currency: String?) -> String {
    let n = String(format: "%.2f", value)
    if let c = currency, !c.isEmpty { return "\(n) \(c)" }
    return n
  }

  /// Percent-encode a value for a URL query component.
  static func queryEncoded(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: .urlQueryValueAllowed) ?? s
  }

  /// Percent-encode a value for a URL path component (group ids are Firebase push
  /// ids — already URL-safe, but encode defensively).
  static func pathSafe(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
  }
}

private extension CharacterSet {
  /// `urlQueryAllowed` still permits `&` and `=`; strip them so a value can't break
  /// out of its query component.
  static var urlQueryValueAllowed: CharacterSet {
    var set = CharacterSet.urlQueryAllowed
    set.remove(charactersIn: "&=?#")
    return set
  }
}
