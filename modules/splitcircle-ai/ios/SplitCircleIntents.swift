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
@available(iOS 17.0, *)
public struct GetGroupBalanceIntent: AppIntent {
  public static var title: LocalizedStringResource = "Check ManaSplit Balance"
  public static var description = IntentDescription("Ask what you owe or are owed in a ManaSplit group.")

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
      return .result(value: 0, dialog: "Sign in to ManaSplit first, then ask me again.")
    }
    guard let balance = SplitCircleIndexReader.balance(groupId: group.id, userId: userId) else {
      return .result(value: 0, dialog: "I don't have \(group.name) indexed yet — open ManaSplit once, then ask me again.")
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

/// "What's my overall ManaSplit balance?" — net across every group. Returns the
/// number + a spoken summary. Headless.
@available(iOS 17.0, *)
public struct GetNetBalanceIntent: AppIntent {
  public static var title: LocalizedStringResource = "Check Overall ManaSplit Balance"
  public static var description = IntentDescription("Your net balance across all ManaSplit groups.")

  public init() {}

  public func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<Double> {
    guard let userId = SplitCircleCurrentUser.read() else {
      return .result(value: 0, dialog: "Sign in to ManaSplit first, then ask me again.")
    }
    guard let net = SplitCircleIndexReader.netBalance(userId: userId) else {
      return .result(value: 0, dialog: "Open ManaSplit once so I can total up your groups, then ask me again.")
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

/// "Show my recent ManaSplit expenses" (optionally in one group). Returns a list of
/// Expense entities Shortcuts can loop over. Headless.
@available(iOS 17.0, *)
public struct GetRecentExpensesIntent: AppIntent {
  public static var title: LocalizedStringResource = "Get Recent ManaSplit Expenses"
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
      return .result(value: [], dialog: "Sign in to ManaSplit first, then ask me again.")
    }
    let expenses = SplitCircleIndexReader
      .recentExpenses(userId: userId, groupId: group?.id, limit: limit)
      .map(SplitCircleExpenseEntity.init)
    let dialog = expenses.isEmpty ? "I don't see any recent expenses." : "Here are your \(expenses.count) most recent expenses."
    return .result(value: expenses, dialog: IntentDialog(stringLiteral: dialog))
  }
}

/// "How much do I owe <person> in <group>?" Returns the signed amount (+ you owe them).
@available(iOS 17.0, *)
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
      return .result(value: 0, dialog: "Sign in to ManaSplit first, then ask me again.")
    }
    guard let r = SplitCircleIndexReader.amountOwed(groupId: group.id, userId: userId, personName: person) else {
      return .result(value: 0, dialog: "Open ManaSplit once, then ask me again.")
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
@available(iOS 17.0, *)
public struct GetCategorySpendIntent: AppIntent {
  public static var title: LocalizedStringResource = "Check Category Spending"
  public static var description = IntentDescription("Total spent in a category within a ManaSplit group.")

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
      return .result(value: 0, dialog: "Sign in to ManaSplit first, then ask me again.")
    }
    guard let r = SplitCircleIndexReader.categorySpend(groupId: group.id, userId: userId, category: category) else {
      return .result(value: 0, dialog: "Open ManaSplit once, then ask me again.")
    }
    let money = SplitCircleFormat.money(r.total, currency: r.currency)
    let dialog = r.total < 0.01
      ? "No \(category) spending recorded in \(group.name) yet."
      : "\(group.name) has \(money) of \(category) spending."
    return .result(value: r.total, dialog: IntentDialog(stringLiteral: dialog))
  }
}

/// "List my ManaSplit groups" — headless enumeration; also a Shortcuts building block.
@available(iOS 17.0, *)
public struct ListSplitCircleGroupsIntent: AppIntent {
  public static var title: LocalizedStringResource = "List ManaSplit Groups"
  public static var description = IntentDescription("See your ManaSplit groups and what you owe in each.")

  public init() {}

  public func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<[SplitCircleGroupEntity]> {
    guard let userId = SplitCircleCurrentUser.read() else {
      return .result(value: [], dialog: "Sign in to ManaSplit first, then ask me again.")
    }
    let groups = SplitCircleIndexReader.groups(forUser: userId)
      .map { SplitCircleGroupEntity(id: $0.id, name: $0.name, memberCount: $0.memberCount) }
    let dialog = groups.isEmpty
      ? "You don't have any ManaSplit groups yet."
      : "You're in \(groups.count) ManaSplit \(groups.count == 1 ? "group" : "groups")."
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
@available(iOS 17.0, *)
public struct OpenGroupIntent: AppIntent {
  public static var title: LocalizedStringResource = "Open ManaSplit Group"
  public static var description = IntentDescription("Open one of your ManaSplit groups.")
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

/// "Add a $60 dinner to [group] split by percentage 40, 30, 30." Creates the expense
/// FULLY HEADLESSLY for ANY split method — no app UI. `openAppWhenRun` is off: the
/// expense is queued on-device (SplitCircleSharedStore.enqueuePendingExpense) and
/// committed the next time the app runs, where GroupContext.addExpense de-dupes by
/// requestId. The actual split math is done JS-side (pendingExpenseService) by the
/// app's real `computeParticipantsFromSplitMetadata` engine so numbers never diverge.
///
/// `values` are the per-person numbers a non-equal method needs (percentages / shares /
/// exact amounts / adjustments / income weights / days / parts), comma-separated and
/// aligned to the `participants` order. Equal ignores them; Roulette/Karma ignores them
/// and Siri instead picks a random member to cover the bill (announced in the dialog).
@available(iOS 17.0, *)
public struct AddExpenseIntent: AppIntent {
  public static var title: LocalizedStringResource = "Add ManaSplit Expense"
  public static var description = IntentDescription("Add an expense to a ManaSplit group with any split method — no app needed.")

  // Root-cause fix (plan §10, Step 2): make headlessness EXPLICIT rather than relying
  // on the implicit background default. Apple documents that performing an intent does
  // not foreground the app by default (WWDC25), so this is a no-regression change — but
  // it removes any dependency on that default, the only thing an old/differently-linked
  // binary could plausibly disagree about (the incident's fallback hypothesis).
  // `IntentModes`/`supportedModes` are iOS 26+-only APIs, so this member carries its own
  // `@available(iOS 26.0, *)` — NOT a blanket change to the struct's iOS 17 availability
  // (that would break the build below iOS 26).
  @available(iOS 26.0, *)
  public static var supportedModes: IntentModes = .background

  @Parameter(title: "Group")
  public var group: SplitCircleGroupEntity

  @Parameter(title: "Amount")
  public var amount: Double

  @Parameter(title: "Description", default: "")
  public var title: String

  @Parameter(title: "Split method", default: .equal)
  public var splitMethod: SplitCircleSplitMethodAppEnum

  // Category defaults to .general so the fast voice flow ("add a $20 expense") never
  // forces a prompt — parity with the old hardcoded "General", now overridable.
  @Parameter(title: "Category", default: .general)
  public var category: SplitCircleCategoryAppEnum

  // Who's in the split. Empty ⇒ everyone in the group. Scoped to `group` by the person
  // query (SplitCirclePersonEntity) and re-filtered here defensively.
  @Parameter(title: "Split with")
  public var participants: [SplitCirclePersonEntity]?

  // Per-person numbers for non-equal methods, comma-separated, aligned to the chosen
  // participants (e.g. "40, 30, 30" for percentages). Ignored by equal / roulette.
  @Parameter(title: "Per-person values", default: "")
  public var values: String

  public static var parameterSummary: some ParameterSummary {
    Summary("Add \(\.$amount) for \(\.$title) to \(\.$group)") {
      \.$splitMethod
      \.$category
      \.$participants
      \.$values
    }
  }

  public init() {}

  public func perform() async throws -> some IntentResult & ProvidesDialog {
    guard let userId = SplitCircleCurrentUser.read() else {
      return .result(dialog: "Sign in to ManaSplit first, then try again.")
    }
    // Root-cause fix (plan §10, Step 1): the required `group` param is resolved by
    // SplitCircleGroupQuery, which returns [] on a resolution miss (e.g. a cold
    // background launch racing the JS-side current-user write, or before the index is
    // populated). An unresolved/garbage Group must not silently flow into
    // enqueuePendingExpense — verify it maps to a real group (same groups(forUser:)
    // source the entity query uses) and fail with a spoken error first. This can't
    // suppress Siri's own undocumented "just open the app" fallback (no public API for
    // that), but it removes the silent bad-data path and gives the intent a chance to
    // speak before Siri decides to foreground.
    guard SplitCircleIndexReader.group(id: group.id, userId: userId) != nil else {
      return .result(dialog: "I couldn't find that group — try again and pick one from the list.")
    }
    guard amount > 0 else {
      return .result(dialog: "That amount doesn't look right — try a positive number.")
    }
    // Itemized needs per-item receipt data (price/assignedTo per line) that there's no
    // way to voice/Shortcuts-enter headlessly. Without it the JS drain runs
    // computeItemized([], 0, 0, …), which returns all-zero shares — but toParticipantShares
    // filters by `included`, not by nonzero amount, so a real full-amount expense that
    // charges nobody would be written. Reject it here before anything is queued.
    guard splitMethod != .itemized else {
      return .result(dialog: "Itemized splits need a receipt — open ManaSplit for \(group.name) to split this by item.")
    }
    let everyone = SplitCircleIndexReader.members(forGroup: group.id, userId: userId).map { $0.id }
    var chosen: [String]
    if let participants, !participants.isEmpty {
      chosen = participants.filter { $0.groupId == group.id }.map { $0.userId }
    } else {
      chosen = everyone
    }
    if chosen.isEmpty { chosen = everyone }
    guard !chosen.isEmpty else {
      return .result(dialog: "Open \(group.name) in ManaSplit once so I can see who's in it, then try again.")
    }

    // Parse per-person values aligned to `chosen` order → { userId: value }.
    var valueMap: [String: Double] = [:]
    let parsed = values
      .split(whereSeparator: { $0 == "," || $0 == " " })
      .compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    for (i, uid) in chosen.enumerated() where i < parsed.count {
      valueMap[uid] = parsed[i]
    }

    // Roulette/Karma: pick a random member to cover the whole bill (headless — no spin).
    var rouletteLoserId: String? = nil
    if splitMethod == .gamified {
      rouletteLoserId = chosen.randomElement()
    }

    let cleanTitle = title.isEmpty ? "Expense" : title
    var record: [String: Any] = [
      "requestId": "siri-\(UUID().uuidString)",
      "groupId": group.id,
      "title": cleanTitle,
      "amount": amount,
      "category": category.rawValue,
      "paidByUserId": userId,
      "participantUserIds": chosen,
      "splitMethod": splitMethod.rawValue,
      "values": valueMap,
      "createdAt": Date().timeIntervalSince1970 * 1000,
    ]
    if let rouletteLoserId { record["rouletteLoserId"] = rouletteLoserId }
    SplitCircleSharedStore.enqueuePendingExpense(record)

    let currency = SplitCircleIndexReader.balance(groupId: group.id, userId: userId)?.currency
    let money = SplitCircleFormat.money(amount, currency: currency)
    if let loser = rouletteLoserId {
      let name = SplitCircleIndexReader.members(forGroup: group.id, userId: userId)
        .first(where: { $0.id == loser })?.name ?? "someone"
      return .result(dialog: "Roulette picked \(name) — they cover the \(money) for \(cleanTitle) in \(group.name). It'll sync next time you open ManaSplit.")
    }
    let who = chosen.count == 1 ? "1 person" : "\(chosen.count) people"
    return .result(dialog: "Added \(money) for \(cleanTitle) to \(group.name), split \(splitMethodPhrase(splitMethod)) between \(who). It'll sync next time you open ManaSplit.")
  }
}

/// A short spoken phrase for the split method, for the Add Expense confirmation dialog.
@available(iOS 17.0, *)
private func splitMethodPhrase(_ m: SplitCircleSplitMethodAppEnum) -> String {
  switch m {
  case .equal: return "equally"
  case .percentage: return "by percentage"
  case .shares: return "by shares"
  case .exact: return "by exact amounts"
  case .adjustment: return "with adjustments"
  case .income: return "by income"
  case .consumption: return "by consumption"
  case .timeBased: return "by time"
  case .itemized: return "by items"
  case .itemType: return "by item type"
  case .gamified: return "by roulette"
  }
}

/// Direction of a settlement, from the current user's perspective.
@available(iOS 17.0, *)
public enum SplitCircleSettleDirectionAppEnum: String, AppEnum {
  case iPaid
  case theyPaid

  public static var typeDisplayRepresentation: TypeDisplayRepresentation = "Who Paid"
  public static var caseDisplayRepresentations: [SplitCircleSettleDirectionAppEnum: DisplayRepresentation] = [
    .iPaid: "I paid them",
    .theyPaid: "They paid me",
  ]
}

/// "Settle up: I paid Sarah $20 in [group]." Records the settlement HEADLESSLY — no app
/// UI. Queued on-device (SplitCircleSharedStore.enqueuePendingSettlement) and committed
/// next launch through GroupContext.settleUp (idempotent by requestId, durable outbox).
@available(iOS 17.0, *)
public struct SettleUpIntent: AppIntent {
  public static var title: LocalizedStringResource = "Settle Up in ManaSplit"
  public static var description = IntentDescription("Record a settlement in a ManaSplit group — no app needed.")

  // Root-cause fix (plan §10, Step 2): explicit headless mode, same rationale and same
  // iOS 26+ availability gating as AddExpenseIntent above.
  @available(iOS 26.0, *)
  public static var supportedModes: IntentModes = .background

  @Parameter(title: "Group")
  public var group: SplitCircleGroupEntity

  @Parameter(title: "Person")
  public var person: SplitCirclePersonEntity

  @Parameter(title: "Amount")
  public var amount: Double

  @Parameter(title: "Direction", default: .iPaid)
  public var direction: SplitCircleSettleDirectionAppEnum

  public static var parameterSummary: some ParameterSummary {
    Summary("Settle \(\.$amount) with \(\.$person) in \(\.$group)") {
      \.$direction
    }
  }

  public init() {}

  public func perform() async throws -> some IntentResult & ProvidesDialog {
    guard let userId = SplitCircleCurrentUser.read() else {
      return .result(dialog: "Sign in to ManaSplit first, then try again.")
    }
    // Root-cause fix (plan §10, Step 1): same required-entity resolution guard as
    // AddExpenseIntent — reject an unresolved/garbage `group` with a spoken error
    // before it can reach enqueuePendingSettlement, rather than letting it fall through
    // to Siri's silent app-opening fallback.
    guard SplitCircleIndexReader.group(id: group.id, userId: userId) != nil else {
      return .result(dialog: "I couldn't find that group — try again and pick one from the list.")
    }
    guard amount > 0 else {
      return .result(dialog: "That amount doesn't look right — try a positive number.")
    }
    guard person.groupId == group.id else {
      return .result(dialog: "\(person.name) isn't in \(group.name) — pick someone from that group.")
    }
    // The person picker (SplitCirclePersonQuery.all) includes the signed-in user, so a
    // self-selection is an easy accident. A settlement with fromUserId == toUserId nets to
    // zero but lands a nonsensical "you paid yourself" record — reject it before queueing.
    guard person.userId != userId else {
      return .result(dialog: "You can't settle up with yourself — pick someone else in \(group.name).")
    }
    let other = person.userId
    let fromUserId = direction == .iPaid ? userId : other
    let toUserId = direction == .iPaid ? other : userId

    let record: [String: Any] = [
      "requestId": "siri-\(UUID().uuidString)",
      "groupId": group.id,
      "fromUserId": fromUserId,
      "toUserId": toUserId,
      "amount": amount,
      "createdAt": Date().timeIntervalSince1970 * 1000,
    ]
    SplitCircleSharedStore.enqueuePendingSettlement(record)

    let currency = SplitCircleIndexReader.balance(groupId: group.id, userId: userId)?.currency
    let money = SplitCircleFormat.money(amount, currency: currency)
    let dialog = direction == .iPaid
      ? "Recorded: you paid \(person.name) \(money) in \(group.name). It'll sync next time you open ManaSplit."
      : "Recorded: \(person.name) paid you \(money) in \(group.name). It'll sync next time you open ManaSplit."
    return .result(dialog: IntentDialog(stringLiteral: dialog))
  }
}

/// Open-ended Q&A — needs the on-device Foundation Models pipeline, which needs the
/// app process, so this opens the app and hands the question off via the existing
/// `com.splitcircle.ask-ai` NSUserActivity (donateAskActivity path).
@available(iOS 17.0, *)
public struct AskSplitCircleIntent: AppIntent {
  public static var title: LocalizedStringResource = "Ask ManaSplit"
  public static var description = IntentDescription("Ask ManaSplit a question about a group's shared expenses.")
  public static var openAppWhenRun = true

  // SplitCircle's assistant is per-group (it grounds answers in one group's
  // expenses), so the question needs a group to open into.
  @Parameter(title: "Group")
  public var group: SplitCircleGroupEntity

  @Parameter(title: "Question")
  public var question: String

  public static var parameterSummary: some ParameterSummary {
    Summary("Ask ManaSplit \(\.$question) about \(\.$group)")
  }

  public init() {}

  public func perform() async throws -> some IntentResult {
    let url = "splitcircle://ask?group=\(SplitCircleFormat.pathSafe(group.id))&q=\(SplitCircleFormat.queryEncoded(question))"
    SplitCircleSharedStore.setPendingDeepLink(url)
    return .result()
  }
}

// MARK: - Shortcuts / Siri phrase donation

@available(iOS 17.0, *)
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
      phrases: [
        "Add an expense in \(.applicationName)",
        "Record a new expense in \(.applicationName)",
        "New \(.applicationName) expense in \(\.$group)",
      ],
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
      shortTitle: "Ask ManaSplit",
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
