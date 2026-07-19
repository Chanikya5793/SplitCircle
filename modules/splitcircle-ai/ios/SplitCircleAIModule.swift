import ExpoModulesCore
import Foundation
import Intents
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Keep the donated activity alive — `becomeCurrent()` does not retain it.
private var currentAskActivity: NSUserActivity?

#if canImport(FoundationModels)
/// Structured answer the on-device model fills in (FoundationModels @Generable).
/// Keeping the shape minimal preserves the 4096-token combined budget.
@available(iOS 26.0, *)
@Generable
struct OnDeviceExpenseAnswer {
  @Guide(description: "Direct, concise answer to the user's question, based ONLY on the numbered expense lines provided. If the expenses don't contain the answer, say so plainly.")
  var answer: String

  @Guide(description: "The 1-based numbers of the expense lines actually used to answer. Empty if none were relevant.")
  var sourceIndexes: [Int]
}

/// One parsed receipt line item.
@available(iOS 26.0, *)
@Generable
struct OnDeviceReceiptItem {
  @Guide(description: "Cleaned, concise item name. Fix obvious OCR typos only when confident.")
  var name: String
  @Guide(description: "Unit price as a number, e.g. 5.99")
  var price: Double
  @Guide(description: "Quantity; default 1 when not stated.")
  var quantity: Int
}

/// Extra "more info" details extracted from a receipt (best-effort).
@available(iOS 26.0, *)
@Generable
struct OnDeviceReceiptInsights {
  @Guide(description: "Store street address as printed, or empty string.")
  var merchantAddress: String
  @Guide(description: "Store phone number, or empty string.")
  var merchantPhone: String
  @Guide(description: "Payment method, e.g. 'Visa ****1234' or 'Cash'; empty if unknown.")
  var paymentMethod: String
  @Guide(description: "Total discounts/coupons/savings amount, or 0 if none.")
  var savings: Double
  @Guide(description: "Return or exchange policy/window text, or empty string.")
  var returnPolicy: String
}

/// Structured receipt extracted on-device from OCR text.
@available(iOS 26.0, *)
@Generable
struct OnDeviceReceipt {
  @Guide(description: "Merchandise/food line items ONLY. Never include subtotal, tax, tip, total, payment, card, approval, or 'items sold' lines.")
  var items: [OnDeviceReceiptItem]
  @Guide(description: "Merchant/store name, or empty string if unknown.")
  var merchantName: String
  @Guide(description: "Purchase date as YYYY-MM-DD, or empty string if not present.")
  var date: String
  @Guide(description: "Subtotal amount, or 0 if not present.")
  var subtotal: Double
  @Guide(description: "Tax amount, or 0 if not present.")
  var tax: Double
  @Guide(description: "Tip/gratuity amount, or 0 if not present.")
  var tip: Double
  @Guide(description: "Grand total amount, or 0 if not present.")
  var total: Double
  @Guide(description: "Additional details for the user's reference.")
  var insights: OnDeviceReceiptInsights
}

/// Single expense category chosen by the on-device model.
@available(iOS 26.0, *)
@Generable
struct OnDeviceCategory {
  @Guide(description: "The single best category, EXACTLY one of: General, Food, Transport, Utilities, Entertainment, Shopping, Travel, Health.")
  var category: String
}

/// A natural-language expense draft parsed from a sentence.
@available(iOS 26.0, *)
@Generable
struct OnDeviceParsedExpense {
  @Guide(description: "Short expense title (e.g. 'Dinner'), inferred from the text.")
  var title: String
  @Guide(description: "Total amount as a number, e.g. 42.50. 0 if not stated.")
  var amount: Double
  @Guide(description: "Category, EXACTLY one of: General, Food, Transport, Utilities, Entertainment, Shopping, Travel, Health.")
  var category: String
  @Guide(description: "Name of who paid, copied from the provided member names; empty means the current user.")
  var paidByName: String
  @Guide(description: "Names of people sharing the expense, copied from the provided member names. Empty list means everyone.")
  var participantNames: [String]
  @Guide(description: "True if split equally (the default); false only if the text clearly says otherwise.")
  var splitEqually: Bool
  @Guide(description: "Date as YYYY-MM-DD if explicitly stated, otherwise empty string.")
  var date: String
}

/// A structured plan parsed from a free-form question about expenses.
@available(iOS 26.0, *)
@Generable
struct OnDeviceQueryPlan {
  @Guide(description: "One of: spend, balance, settle_up, biggest, count, average, who_most, leaderboard, breakdown, paid_for, recent, summary, compare, trend, unknown. Use unknown if it isn't about this group's expenses/balances.")
  var intent: String
  @Guide(description: "Who it's about: 'me', 'group', or a member's EXACT name from the provided list. Empty for the whole group.")
  var scope: String
  @Guide(description: "Category if mentioned: General, Food, Transport, Utilities, Entertainment, Shopping, Travel, Health. Empty if none.")
  var category: String
  @Guide(description: "A member's EXACT name for a balance question like 'how much do I owe X'. Empty otherwise.")
  var member: String
  @Guide(description: "'paid' or 'share' for who_most/leaderboard. Empty otherwise.")
  var metric: String
  @Guide(description: "Timeframe token: this_month, last_month, this_week, last_week, this_year, today, a month name optionally with year (april, april_2025), a quarter (q2, q2_2025), a year (year_2025), or previous_period for 'the month/period before that'. Empty for all-time.")
  var timeframe: String
}

/// One agentic answering step: the model either answers from the provided data
/// or names the data packs it still needs (read-only; the JS layer fetches and
/// re-prompts). Numbers still come only from the verified facts it was given.
@available(iOS 26.0, *)
@Generable
struct OnDeviceAgentStep {
  @Guide(description: "The final answer when the provided data is sufficient. Empty ONLY when more data is needed.")
  var answer: String
  @Guide(description: "1-based numbers of the expense lines actually used. Empty if none.")
  var sourceIndexes: [Int]
  @Guide(description: "Data kinds still needed to answer, chosen ONLY from the 'Available data kinds' list in the prompt. Empty when the answer is complete.")
  var needsData: [String]
}

// MARK: - Pipeline v2 spike (doc 17, branch spike/fm-ios27) -------------------
// Additive + guarded. Proves three things compile on the iOS 27 SDK before the
// Phase A rewrite: (S2) a persistent multi-turn session, (S3) a single abstaining
// router @Generable, (S5) the iOS-27 Private Cloud Compute model. Existing
// functions are left untouched.

/// S3 — one structured router decision the JS layer routes on. `abstain` lets the
/// model decline non-money / greeting messages instead of fabricating a plan
/// (the root cause of "Hello" → settle-up dump). `queryPlan` reuses the existing
/// @Generable plan, proving nested guided generation compiles.
@available(iOS 26.0, *)
@Generable
struct OnDeviceRouterDecision {
  @Guide(description: "Intent, EXACTLY one of: question, add_expense, settle_up, delete_expense, edit_expense, delete_settlement, navigate, chitchat.")
  var intent: String
  @Guide(description: "Your confidence from 0.0 to 1.0 that the intent is correct.")
  var confidence: Double
  @Guide(description: "True if this message is a greeting, small talk, an app/meta command, or NOT about this group's money. When true, leave the query plan empty.")
  var abstain: Bool
  @Guide(description: "A short, friendly reply to show ONLY when abstain is true (e.g. answer a greeting). Empty otherwise.")
  var chitchatReply: String
  @Guide(description: "For a 'question' intent: the structured query plan. For any other intent, leave its fields empty.")
  var queryPlan: OnDeviceQueryPlan
}

/// S2 — persistent `LanguageModelSession` cache keyed by a caller string (per
/// group / per role) so the model keeps a real multi-turn Transcript across
/// turns. Today every call spins a fresh session and loses continuity; this is
/// the highest-value fix. Stored behind a `nonisolated(unsafe)` global because
/// the type is iOS-26-gated. NOTE: a session handles one request at a time —
/// the JS layer serializes turns; revisit locking before shipping.
nonisolated(unsafe) private var _fmSessionStore: AnyObject?

@available(iOS 26.0, *)
final class FMSessionStore {
  private static let storeLock = NSLock()

  static func shared() -> FMSessionStore {
    storeLock.lock()
    defer { storeLock.unlock() }
    if let s = _fmSessionStore as? FMSessionStore { return s }
    let s = FMSessionStore()
    _fmSessionStore = s
    return s
  }

  private let lock = NSLock()
  private var sessions: [String: LanguageModelSession] = [:]

  func session(id: String, instructions: String) -> LanguageModelSession {
    lock.lock()
    defer { lock.unlock() }
    if let existing = sessions[id] { return existing }
    let created = LanguageModelSession(instructions: instructions)
    created.prewarm()
    sessions[id] = created
    return created
  }

  func reset(id: String) {
    lock.lock()
    defer { lock.unlock() }
    sessions.removeValue(forKey: id)
  }

  func resetAll() {
    lock.lock()
    defer { lock.unlock() }
    sessions.removeAll()
  }
}

/// S3 — the richer system prompt (session `instructions`). Carries persona, the
/// fixed category list, the abstain rule, the "never compute numbers" rule, and
/// today's date (the model has no clock) so relative timeframes resolve.
@available(iOS 26.0, *)
func routerInstructions(memberNames: String, isoDate: String) -> String {
  """
  You are SplitCircle's assistant for a shared-expense group. Today is \(isoDate). \
  Group members: \(memberNames).

  Classify each user message into ONE intent. For a 'question', also fill the \
  query plan. Rules:
  - NEVER compute, total, or invent numbers — return only a plan; the app computes \
    exact amounts deterministically.
  - If the message is a greeting, small talk, an app/meta command (e.g. "clear the \
    chat"), or not about this group's money, set abstain=true, intent='chitchat', \
    and put a short friendly reply in chitchatReply. Do NOT fabricate a plan. \
    When you are unsure what the user means, also abstain — never guess a plan.
  - Copy member names EXACTLY from the list above; never invent people.
  - Pick categories only from: General, Food, Transport, Utilities, Entertainment, \
    Shopping, Travel, Health.
  - Timeframe tokens: this_month, last_month, this_week, last_week, this_year, \
    today, a month name like april or april_2025, a quarter like q2, a year like \
    year_2025, or previous_period for "the month/period before that". Empty means \
    all-time — do NOT default to this_month when no time is mentioned.
  - Use the conversation so far to resolve follow-ups like "what about April?" or \
    "the month before that".

  Examples:
  - "Hello" → abstain=true, intent=chitchat, chitchatReply="Hey! Ask me about \
    this group's spending, or tell me to add an expense."
  - "Aprils total?" → intent=question, plan{intent=spend, scope=group, timeframe=april}
  - "what about the month before that?" → intent=question, \
    plan{intent=spend, scope=group, timeframe=previous_period}
  - "add 20 for lunch with Sam" → intent=add_expense, confidence high, no plan
  """
}
#endif

public class SplitCircleAIModule: Module {
  private var searchTabObservers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("SplitCircleAI")

    // ── Native search-tab bridge ─────────────────────────────────────────────
    // The react-native-screens patch (see patches/react-native-screens+*.patch)
    // hosts a real UISearchTab on iOS 26: the tab bar itself morphs into the
    // system search field. That field lives entirely in UIKit, so the patch
    // broadcasts its activity via NSNotificationCenter and this module relays
    // it to JS — SearchScreen mirrors the text instead of drawing its own field.
    // `onAiStreamChunk` carries snapshot-streamed answer partials
    // ({ requestId, text, done }) from askOnDeviceStreamed.
    Events("onSearchTabEvent", "onAiStreamChunk")

    /// True when this build carries the UISearchTab bridge (both this module and
    /// the react-native-screens patch ship in the same binary). JS uses this to
    /// decide between the native tab-bar search field and its own fallback field.
    Function("hasNativeSearchTab") { () -> Bool in
      if #available(iOS 26.0, *) { return true }
      return false
    }

    /// Fill the native tab-bar search field from JS (recents / suggestion taps).
    Function("setSearchTabText") { (text: String) in
      DispatchQueue.main.async {
        NotificationCenter.default.post(
          name: Notification.Name("RNSSearchTabSetText"),
          object: nil,
          userInfo: ["text": text]
        )
      }
    }

    OnStartObserving {
      let center = NotificationCenter.default
      let pairs: [(Notification.Name, String)] = [
        (Notification.Name("RNSSearchTabTextDidChange"), "textChange"),
        (Notification.Name("RNSSearchTabDidActivate"), "activate"),
        (Notification.Name("RNSSearchTabDidDeactivate"), "deactivate"),
        (Notification.Name("RNSSearchTabDidSubmit"), "submit"),
      ]
      self.searchTabObservers = pairs.map { name, type in
        center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
          self?.sendEvent("onSearchTabEvent", [
            "type": type,
            "text": (note.userInfo?["text"] as? String) ?? "",
          ])
        }
      }
    }

    OnStopObserving {
      self.searchTabObservers.forEach(NotificationCenter.default.removeObserver(_:))
      self.searchTabObservers = []
    }

    /// On-device PII redaction (Critical Rule #3, client side).
    /// Uses NSDataDetector — far more accurate than regex for phone numbers and
    /// catches emails via mailto links — so contact details never leave the
    /// device inside an AI query or expense note. Synchronous and pure.
    Function("redactPII") { (text: String) -> String in
      guard !text.isEmpty else { return text }
      guard let detector = try? NSDataDetector(
        types: NSTextCheckingResult.CheckingType.phoneNumber.rawValue
          | NSTextCheckingResult.CheckingType.link.rawValue
      ) else {
        return text
      }

      let ns = text as NSString
      var result = text
      let matches = detector.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length))

      // Replace back-to-front so earlier ranges stay valid.
      for match in matches.reversed() {
        guard let range = Range(match.range, in: result) else { continue }
        switch match.resultType {
        case .phoneNumber:
          result.replaceSubrange(range, with: "[phone]")
        case .link:
          // Only emails (mailto) are PII here; leave ordinary URLs intact.
          if match.url?.scheme == "mailto" {
            result.replaceSubrange(range, with: "[email]")
          }
        default:
          break
        }
      }
      return result
    }

    /// Donate an "Ask SplitCircle" NSUserActivity so iOS surfaces it in
    /// Spotlight / Siri Suggestions after the user asks the AI about spending.
    /// The activity deep-links back into the app (handled in AppDelegate via
    /// the standard continueUserActivity flow → React Navigation linking).
    AsyncFunction("donateAskActivity") { (query: String?) in
      DispatchQueue.main.async {
        let activity = NSUserActivity(activityType: "com.splitcircle.ask-ai")
        activity.title = "Ask SplitCircle about my spending"
        activity.isEligibleForSearch = true
        activity.isEligibleForPrediction = true
        activity.suggestedInvocationPhrase = "Ask ManaSplit"
        if let query, !query.isEmpty {
          // Persist only the (already-redacted) query text for resume.
          activity.userInfo = ["query": query]
          activity.requiredUserInfoKeys = ["query"]
        }
        activity.becomeCurrent()
        currentAskActivity = activity
      }
    }

    /// Persist the widget balance snapshot into the App Group container and refresh
    /// WidgetKit timelines. `json` is built JS-side (widgetService.ts). No-op if the
    /// App Group entitlement isn't granted yet (widget just shows its empty state).
    Function("writeWidgetSnapshot") { (json: String) -> Void in
      SplitCircleSharedStore.writeWidgetSnapshot(json)
    }

    /// Force a WidgetKit timeline refresh (e.g. after a manual "rebuild index").
    Function("reloadWidgets") { () -> Void in
      SplitCircleSharedStore.reloadWidgets()
    }

    /// The App Group identifier the widget snapshot lives under — exposed so JS can
    /// surface it on the AI/index transparency screen if desired.
    Function("getAppGroupId") { () -> String in
      SplitCircleSharedStore.appGroupId
    }

    /// Availability of the on-device Apple Foundation Models LLM (iOS 26+,
    /// Apple Intelligence-eligible hardware). Returns one of:
    /// "available" | "deviceNotEligible" | "appleIntelligenceNotEnabled" |
    /// "modelNotReady" | "unsupportedOS" — JS tailors the UX per reason.
    Function("getOnDeviceAiAvailability") { () -> String in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        switch SystemLanguageModel.default.availability {
        case .available:
          return "available"
        case .unavailable(.deviceNotEligible):
          return "deviceNotEligible"
        case .unavailable(.appleIntelligenceNotEnabled):
          return "appleIntelligenceNotEnabled"
        case .unavailable(.modelNotReady):
          return "modelNotReady"
        case .unavailable:
          return "deviceNotEligible"
        }
      }
      #endif
      return "unsupportedOS"
    }

    /// The on-device model's context window in tokens. On more capable hardware
    /// (iPhone Air / iPhone 17 Pro family, which auto-select Apple's larger
    /// "Core Advanced" on-device model) this reports a bigger window, so the JS
    /// layer can ground the answer in MORE of the group's expenses. Returns 0
    /// when the model isn't available. `contextSize` is @backDeployed to
    /// iOS 26.0 (added in 26.4), so it runs on every device that has the
    /// framework. Falls back to 0 if the running OS predates the symbol.
    Function("getOnDeviceContextSize") { () -> Int in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else { return 0 }
        return SystemLanguageModel.default.contextSize
      }
      #endif
      return 0
    }

    /// Ask the on-device model a question grounded in the numbered expense
    /// context built JS-side. Fully on-device: nothing leaves the phone and
    /// there is no per-call cost. Throws when the model is unavailable.
    AsyncFunction("askOnDevice") { (question: String, context: String) async throws -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else {
          throw OnDeviceAiUnavailableException()
        }

        let session = LanguageModelSession {
          """
          You are SplitCircle's expense assistant. Answer questions about the \
          user's shared expenses using ONLY the numbered expense lines provided \
          in the prompt. Be concise and specific with amounts. Never invent \
          expenses, people, or totals that are not derivable from the lines. \
          If the lines don't contain the answer, say you don't have enough \
          expense data for that.
          """
        }

        let prompt = """
        Expenses:
        \(context)

        Question: \(question)
        """

        let response = try await session.respond(
          to: prompt,
          generating: OnDeviceExpenseAnswer.self
        )
        return [
          "answer": response.content.answer,
          "sourceIndexes": response.content.sourceIndexes,
        ]
      }
      #endif
      throw OnDeviceAiUnavailableException()
    }

    /// Free-form text generation with CALLER-supplied instructions — the door
    /// for the narrative tier (stats insight card, insights chat turns, thread
    /// titles, rollup summaries; doc 22/23). Unlike `askOnDevice` this installs
    /// no Q&A persona, wraps no "Expenses:" block, and forces no citation
    /// struct — routing the narrator through those made the model deflect with
    /// "I don't have enough expense data" and answer in Q&A phrasing.
    /// `deterministic` uses greedy sampling so identical facts narrate
    /// identically run-to-run. Throws when the model is unavailable.
    AsyncFunction("generateText") { (prompt: String, instructions: String, deterministic: Bool) async throws -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else {
          throw OnDeviceAiUnavailableException()
        }
        let instr = instructions.isEmpty
          ? "Follow the instructions in the prompt exactly. Reply with plain sentences only — no lists, no markdown, no preamble."
          : instructions
        let session = LanguageModelSession(instructions: instr)
        let options = deterministic ? GenerationOptions(sampling: .greedy) : GenerationOptions()
        let response = try await session.respond(to: prompt, options: options)
        return ["answer": response.content]
      }
      #endif
      throw OnDeviceAiUnavailableException()
    }

    /// Parse OCR receipt text into structured data fully on-device via
    /// Foundation Models. `fewShot` is an optional plain-text block of learned
    /// merchant corrections used to bias item naming. Throws when unavailable.
    AsyncFunction("parseReceiptStructured") { (rawText: String, fewShot: String) async throws -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else {
          throw OnDeviceAiUnavailableException()
        }

        let session = LanguageModelSession {
          """
          You are a precise receipt-parsing assistant. From the raw OCR text of a \
          single receipt, extract the merchandise/food line items (name, unit \
          price, quantity), plus subtotal, tax, tip, total, merchant name, and \
          date. Never treat subtotal, tax, tip, total, change, card, approval, or \
          'items sold' lines as items. Clean item names and fix obvious OCR typos \
          only when confident. Use 0 for any missing amount and an empty string \
          for a missing merchant or date.
          """
        }

        let hints = fewShot.isEmpty ? "" : """

        The user has previously corrected this merchant's item names as below; \
        prefer these spellings when an item clearly matches:
        \(fewShot)
        """

        let prompt = """
        Raw OCR text:
        \"\"\"
        \(rawText)
        \"\"\"
        \(hints)
        """

        let response = try await session.respond(to: prompt, generating: OnDeviceReceipt.self)
        let r = response.content
        return [
          "items": r.items.map { ["name": $0.name, "price": $0.price, "quantity": $0.quantity] },
          "merchantName": r.merchantName,
          "date": r.date,
          "subtotal": r.subtotal,
          "tax": r.tax,
          "tip": r.tip,
          "total": r.total,
          "insights": [
            "merchantAddress": r.insights.merchantAddress,
            "merchantPhone": r.insights.merchantPhone,
            "paymentMethod": r.insights.paymentMethod,
            "savings": r.insights.savings,
            "returnPolicy": r.insights.returnPolicy,
          ],
        ]
      }
      #endif
      throw OnDeviceAiUnavailableException()
    }

    /// Suggest a single expense category for the given text (title/merchant/
    /// notes) fully on-device. The caller validates the result against its
    /// canonical list. Throws when the model is unavailable.
    AsyncFunction("suggestExpenseCategory") { (text: String) async throws -> String in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else {
          throw OnDeviceAiUnavailableException()
        }
        let session = LanguageModelSession {
          """
          You categorize a shared expense into exactly one category from this
          fixed list: General, Food, Transport, Utilities, Entertainment,
          Shopping, Travel, Health. Pick the closest match.
          """
        }
        let response = try await session.respond(to: "Expense: \(text)", generating: OnDeviceCategory.self)
        return response.content.category
      }
      #endif
      throw OnDeviceAiUnavailableException()
    }

    /// Parse a natural-language sentence into an expense draft, fully on-device.
    /// `memberNames` (comma-separated) and `currentUserName` ground participant
    /// resolution. The caller maps names back to user ids. Throws when unavailable.
    AsyncFunction("parseExpenseFromText") { (text: String, memberNames: String, currentUserName: String) async throws -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else {
          throw OnDeviceAiUnavailableException()
        }
        let session = LanguageModelSession {
          """
          You convert a short sentence into an expense. Only use names from the
          provided member list; copy them exactly. If a payer isn't named, leave
          paidByName empty (it means the current user). If no people are named,
          return an empty participantNames list (means everyone). Amounts are
          numbers. Pick the closest category from the fixed list.
          Members: \(memberNames). Current user: \(currentUserName).
          """
        }
        let response = try await session.respond(to: "Sentence: \(text)", generating: OnDeviceParsedExpense.self)
        let e = response.content
        return [
          "title": e.title,
          "amount": e.amount,
          "category": e.category,
          "paidByName": e.paidByName,
          "participantNames": e.participantNames,
          "splitEqually": e.splitEqually,
          "date": e.date,
        ]
      }
      #endif
      throw OnDeviceAiUnavailableException()
    }

    /// "Understand" pass of the RAG pipeline: turn a free-form question into a
    /// structured plan the JS layer maps to an exact deterministic answer.
    AsyncFunction("planExpenseQuery") { (question: String, memberNames: String) async throws -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else {
          throw OnDeviceAiUnavailableException()
        }
        let session = LanguageModelSession {
          """
          You convert a question about a shared-expense group into a structured
          plan. Use EXACT member names from this list when a person is meant:
          \(memberNames). If the question isn't about this group's expenses,
          balances, or settlements, set intent to "unknown".
          """
        }
        let r = try await session.respond(to: "Question: \(question)", generating: OnDeviceQueryPlan.self).content
        return [
          "intent": r.intent,
          "scope": r.scope,
          "category": r.category,
          "member": r.member,
          "metric": r.metric,
          "timeframe": r.timeframe,
        ]
      }
      #endif
      throw OnDeviceAiUnavailableException()
    }

    // ── Pipeline v2 spike probes (doc 17 §A0) ───────────────────────────────

    /// S2 — ask grounded in a PERSISTENT, per-session transcript so follow-ups
    /// keep continuity. `sessionId` is the caller's group/thread key.
    AsyncFunction("askOnDeviceStateful") { (sessionId: String, question: String, context: String, instructions: String) async throws -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else {
          throw OnDeviceAiUnavailableException()
        }
        let instr = instructions.isEmpty
          ? "You are SplitCircle's expense assistant. Answer ONLY from the numbered expense lines; never invent numbers."
          : instructions
        let session = FMSessionStore.shared().session(id: sessionId, instructions: instr)
        let prompt = context.isEmpty ? question : """
        Expenses:
        \(context)

        Question: \(question)
        """
        let response = try await session.respond(to: prompt, generating: OnDeviceExpenseAnswer.self)
        return [
          "answer": response.content.answer,
          "sourceIndexes": response.content.sourceIndexes,
        ]
      }
      #endif
      throw OnDeviceAiUnavailableException()
    }

    /// S2 — clear a session's transcript (e.g. "clear the chat" / new thread).
    Function("resetOnDeviceSession") { (sessionId: String) -> Void in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        if sessionId.isEmpty { FMSessionStore.shared().resetAll() }
        else { FMSessionStore.shared().reset(id: sessionId) }
      }
      #endif
    }

    /// S3 — single abstaining router over a persistent per-group session.
    AsyncFunction("routeMessage") { (sessionId: String, text: String, memberNames: String, isoDate: String) async throws -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else {
          throw OnDeviceAiUnavailableException()
        }
        let session = FMSessionStore.shared().session(
          id: "router:\(sessionId)",
          instructions: routerInstructions(memberNames: memberNames, isoDate: isoDate)
        )
        let r = try await session.respond(to: "Message: \(text)", generating: OnDeviceRouterDecision.self).content
        return [
          "intent": r.intent,
          "confidence": r.confidence,
          "abstain": r.abstain,
          "chitchatReply": r.chitchatReply,
          "queryPlan": [
            "intent": r.queryPlan.intent,
            "scope": r.queryPlan.scope,
            "category": r.queryPlan.category,
            "member": r.queryPlan.member,
            "metric": r.queryPlan.metric,
            "timeframe": r.queryPlan.timeframe,
          ],
        ]
      }
      #endif
      throw OnDeviceAiUnavailableException()
    }

    // ── Pipeline v2 (doc 17 Phases A–C): streaming, agentic reads, PCC ──────

    /// Ask over a persistent session, STREAMING the answer as it generates.
    /// Emits `onAiStreamChunk` events ({requestId, text, done}) with the
    /// answer-so-far, then resolves with the final structured result. The JS
    /// layer serializes calls per session.
    AsyncFunction("askOnDeviceStreamed") { (sessionId: String, requestId: String, question: String, context: String, instructions: String) async throws -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else {
          throw OnDeviceAiUnavailableException()
        }
        let instr = instructions.isEmpty
          ? "You are SplitCircle's expense assistant. Answer ONLY from the numbered expense lines and verified totals; never invent numbers."
          : instructions
        let session = FMSessionStore.shared().session(id: sessionId, instructions: instr)
        let prompt = context.isEmpty ? question : """
        \(context)

        Question: \(question)
        """
        var lastAnswer = ""
        var lastIndexes: [Int] = []
        let stream = session.streamResponse(to: prompt, generating: OnDeviceExpenseAnswer.self)
        for try await partial in stream {
          if let answer = partial.answer, !answer.isEmpty, answer != lastAnswer {
            lastAnswer = answer
            self.sendEvent("onAiStreamChunk", ["requestId": requestId, "text": answer, "done": false])
          }
          if let idxs = partial.sourceIndexes { lastIndexes = idxs }
        }
        self.sendEvent("onAiStreamChunk", ["requestId": requestId, "text": lastAnswer, "done": true])
        return ["answer": lastAnswer, "sourceIndexes": lastIndexes]
      }
      #endif
      throw OnDeviceAiUnavailableException()
    }

    /// One agentic answering step over a persistent session: the model answers
    /// from the provided packs OR names the data kinds it still needs (from
    /// `availableData`). The JS layer fetches requested packs and calls again —
    /// the read-only tool loop lives in JS where the data actually is.
    AsyncFunction("askOnDeviceAgentic") { (sessionId: String, question: String, context: String, availableData: String, isoDate: String) async throws -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else {
          throw OnDeviceAiUnavailableException()
        }
        let session = FMSessionStore.shared().session(
          id: sessionId,
          instructions: """
          You are SplitCircle's expense assistant. Today is \(isoDate). Answer \
          ONLY from the data sections provided; the 'Verified totals' numbers \
          are exact — phrase them, never recompute or invent numbers. If the \
          provided sections cannot answer the question but one of the available \
          data kinds could, put those kind names in needsData and leave the \
          answer empty. If nothing could answer it, say so plainly in the answer.
          """
        )
        let prompt = """
        Available data kinds you may request: \(availableData)

        \(context)

        Question: \(question)
        """
        let r = try await session.respond(to: prompt, generating: OnDeviceAgentStep.self).content
        return ["answer": r.answer, "sourceIndexes": r.sourceIndexes, "needsData": r.needsData]
      }
      #endif
      throw OnDeviceAiUnavailableException()
    }

    /// Private Cloud Compute availability: "available" | "deviceNotEligible" |
    /// "systemNotReady" | "unsupportedOS". Runtime-gated on iOS 27 + the PCC
    /// entitlement (portal capability) + network.
    Function("getPccAvailability") { () -> String in
      #if canImport(FoundationModels)
      if #available(iOS 27.0, *) {
        let model = PrivateCloudComputeLanguageModel()
        switch model.availability {
        case .available: return "available"
        case .unavailable(let r):
          switch r {
          case .deviceNotEligible: return "deviceNotEligible"
          case .systemNotReady: return "systemNotReady"
          @unknown default: return "systemNotReady"
          }
        @unknown default: return "systemNotReady"
        }
      }
      #endif
      return "unsupportedOS"
    }

    /// Ask Private Cloud Compute, grounded in the same packed context as the
    /// on-device path. 32K window + deeper reasoning for complex questions the
    /// on-device model can't hold. Fresh session per call (context is repacked
    /// each time); numbers STILL come from the verified facts, PCC only
    /// understands + phrases. `reasoningLevel`: "light" | "moderate" | "deep".
    AsyncFunction("askPcc") { (question: String, context: String, instructions: String, reasoningLevel: String) async throws -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 27.0, *) {
        let model = PrivateCloudComputeLanguageModel()
        guard model.isAvailable else { throw OnDeviceAiUnavailableException() }
        let instr = instructions.isEmpty
          ? "You are SplitCircle's expense assistant. Answer ONLY from the data sections provided; verified totals are exact — never recompute or invent numbers."
          : instructions
        let level: ReasoningLevel = reasoningLevel == "deep" ? .deep : reasoningLevel == "moderate" ? .moderate : .light
        let session = LanguageModelSession(model: model, instructions: instr)
        let prompt = context.isEmpty ? question : """
        \(context)

        Question: \(question)
        """
        let response = try await session.respond(
          to: prompt,
          generating: OnDeviceExpenseAnswer.self,
          contextOptions: ContextOptions(reasoningLevel: level)
        )
        return [
          "answer": response.content.answer,
          "sourceIndexes": response.content.sourceIndexes,
          // Best-effort transparency into the user's PCC quota (shape is
          // OS-defined; JS treats it as an opaque display string).
          "quota": String(describing: model.quotaUsage),
        ]
      }
      #endif
      throw OnDeviceAiUnavailableException()
    }

    /// S5 — Private Cloud Compute COMPILE probe (iOS 27). Proves the symbols +
    /// signatures build. At runtime `isAvailable` is false until the PCC
    /// entitlement is granted — that's the expected spike outcome.
    AsyncFunction("pccProbe") { (question: String) async throws -> [String: Any] in
      // compiler(>=6.4) == Xcode 27 toolchain. PrivateCloudComputeLanguageModel /
      // ContextOptions are iOS 27 SDK symbols — `#available` alone is a runtime
      // check and does NOT stop older SDKs (EAS stable Xcode) from failing to
      // compile them. This gate broke the production EAS build.
      #if canImport(FoundationModels) && compiler(>=6.4)
      if #available(iOS 27.0, *) {
        let model = PrivateCloudComputeLanguageModel()
        var reason = "available"
        switch model.availability {
        case .available:
          reason = "available"
        case .unavailable(let r):
          switch r {
          case .deviceNotEligible: reason = "deviceNotEligible"
          case .systemNotReady: reason = "systemNotReady"
          @unknown default: reason = "unknown"
          }
        @unknown default:
          reason = "unknown"
        }
        // PCC's contextSize getter is throwing + isolation-bound (unlike
        // SystemLanguageModel's plain Int) — read it with try/await.
        let ctxSize = (try? await model.contextSize) ?? 0
        guard model.isAvailable else {
          return ["available": false, "reason": reason, "answer": "", "contextSize": ctxSize]
        }
        let session = LanguageModelSession(model: model, instructions: "You are SplitCircle's expense assistant.")
        let response = try await session.respond(
          to: question,
          contextOptions: ContextOptions(reasoningLevel: .light)
        )
        return ["available": true, "reason": reason, "answer": response.content, "contextSize": ctxSize]
      }
      #endif
      return ["available": false, "reason": "unsupportedOS", "answer": "", "contextSize": 0]
    }

    /// PCC ask with REAL caller-supplied instructions + quota surfaced (doc 23
    /// — supersedes the spike `pccProbe` for actual answers; probe stays for
    /// diagnostics). Deliberately stateless like the JS chat layer: one
    /// model+session per call, serialized app-wide by the JS `serializeFm`
    /// queue, prompt assembly (facts/summary/turns) happens in JS.
    AsyncFunction("pccAsk") { (question: String, instructions: String) async throws -> [String: Any] in
      #if canImport(FoundationModels) && compiler(>=6.4)
      if #available(iOS 27.0, *) {
        let model = PrivateCloudComputeLanguageModel()
        var reason = "available"
        switch model.availability {
        case .available:
          reason = "available"
        case .unavailable(let r):
          switch r {
          case .deviceNotEligible: reason = "deviceNotEligible"
          case .systemNotReady: reason = "systemNotReady"
          @unknown default: reason = "unknown"
          }
        @unknown default:
          reason = "unknown"
        }
        guard model.isAvailable else {
          return ["available": false, "reason": reason, "answer": "", "quota": ""]
        }
        let instr = instructions.isEmpty ? "You are SplitCircle's expense assistant." : instructions
        let session = LanguageModelSession(model: model, instructions: instr)
        let response = try await session.respond(
          to: question,
          contextOptions: ContextOptions(reasoningLevel: .light)
        )
        // Quota shape is opaque/new — surface a best-effort description for
        // the Settings diagnostics row rather than binding to its fields.
        let quota = String(describing: model.quotaUsage)
        return ["available": true, "reason": reason, "answer": response.content, "quota": quota]
      }
      #endif
      return ["available": false, "reason": "unsupportedOS", "answer": "", "quota": ""]
    }
  }
}

internal final class OnDeviceAiUnavailableException: Exception {
  override var reason: String {
    "On-device Apple Intelligence model is not available on this device"
  }
}
