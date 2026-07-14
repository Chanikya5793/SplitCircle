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

  public func perform() async throws -> some IntentResult & ProvidesDialog {
    guard let userId = SplitCircleCurrentUser.read() else {
      return .result(dialog: "Sign in to SplitCircle first, then ask me again.")
    }
    guard let balance = SplitCircleIndexReader.balance(groupId: group.id, userId: userId) else {
      return .result(dialog: "I don't have \(group.name) indexed yet — open SplitCircle once, then ask me again.")
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
    return .result(dialog: IntentDialog(stringLiteral: dialog))
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

  public static var parameterSummary: some ParameterSummary {
    Summary("Add \(\.$amount) for \(\.$title) to \(\.$group)")
  }

  public init() {}

  public func perform() async throws -> some IntentResult {
    var url = "splitcircle://add-expense?group=\(SplitCircleFormat.pathSafe(group.id))&amount=\(amount)"
    if !title.isEmpty {
      url += "&title=\(SplitCircleFormat.queryEncoded(title))"
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
