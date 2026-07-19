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

// P6 (doc 24): OnDeviceQueryPlan, the doc-17 spike (OnDeviceRouterDecision,
// FMSessionStore, routerInstructions), and their functions are DELETED —
// superseded by the agentic pipeline structs below. Stateless per-call
// sessions replaced native transcripts by design (doc 23, app-wide).

// MARK: - Agentic pipeline (doc 24) -------------------------------------------
// The "one brain" turn structs. ALL prompt text is assembled in JS (aiLoop.ts)
// and tools execute deterministically in JS (aiTools.ts) — these structs only
// give the model a strict shape to decide into. Calls are STATELESS (fresh
// session per call, serialized app-wide by the JS serializeFm queue).

/// One data request the model wants the JS tool registry to execute.
@available(iOS 26.0, *)
@Generable
struct OnDeviceAgentToolRequest {
  @Guide(description: "Tool name copied EXACTLY from the catalog in the instructions.")
  var tool: String
  @Guide(description: "Period like 'april 2026', '2026-04', 'last month', '2025'. Empty when the tool doesn't need one.")
  var month: String
  @Guide(description: "Second period, ONLY for compare_ranges. Empty otherwise.")
  var monthB: String
  @Guide(description: "Category name for category tools. Empty otherwise.")
  var category: String
  @Guide(description: "Member name copied EXACTLY from the member list. Empty otherwise.")
  var member: String
  @Guide(description: "Merchant/store name for merchant_stats. Empty otherwise.")
  var merchant: String
  @Guide(description: "Search text, ONLY for search_expenses. Empty otherwise.")
  var query: String
  @Guide(description: "Row count for top_expenses. 0 means the default.")
  var n: Int
  @Guide(description: "Months of history for category_trail. 0 means the default.")
  var months: Int
}

/// The router's whole-turn decision (doc 24 §3 step 2).
@available(iOS 26.0, *)
@Generable
struct OnDeviceAgentDecision {
  @Guide(description: "EXACTLY one of: answer, clarify, abstain.")
  var intent: String
  @Guide(description: "Confidence 0.0-1.0 that you understood the request.")
  var confidence: Double
  @Guide(description: "EXACTLY one of: simple, moderate, deep.")
  var complexity: String
  @Guide(description: "When mildly ambiguous and you proceed anyway: the reading you chose (e.g. 'April means April 2026'). Empty when unambiguous.")
  var assumption: String
  @Guide(description: "The ONE short question to ask when intent is clarify. Empty otherwise.")
  var clarifyQuestion: String
  @Guide(description: "2-4 short tappable answer options when intent is clarify. Empty otherwise.")
  var clarifyOptions: [String]
  @Guide(description: "One friendly line to show when intent is abstain. Empty otherwise.")
  var abstainReply: String
  @Guide(description: "Data requests needed before answering, up to 3. Empty when the FACTS already suffice or intent is not answer.")
  var requests: [OnDeviceAgentToolRequest]
}

/// One data-loop hop: keep gathering or stop (doc 24 §3 step 4).
@available(iOS 26.0, *)
@Generable
struct OnDeviceAgentLoopStep {
  @Guide(description: "True when the gathered TOOL RESULTS are enough to answer well.")
  var done: Bool
  @Guide(description: "The missing data requests when done is false, up to 3. Empty when done.")
  var requests: [OnDeviceAgentToolRequest]
}

@available(iOS 26.0, *)
private func agentRequestDict(_ r: OnDeviceAgentToolRequest) -> [String: Any] {
  [
    "tool": r.tool, "month": r.month, "monthB": r.monthB, "category": r.category,
    "member": r.member, "merchant": r.merchant, "query": r.query, "n": r.n, "months": r.months,
  ]
}
#endif

// MARK: - P2 stream cancellation registry ------------------------------------
// Cancel flags for in-flight FM streams, keyed by the JS-supplied requestId.
// Best-effort: consumption stops at the next snapshot. Lock-guarded because
// cancelFmStream is called from the JS thread while the stream loop runs on a
// concurrent executor.

nonisolated(unsafe) private var _fmCancelledStreams = Set<String>()
private let _fmCancelLock = NSLock()

private func fmCancelStream(_ id: String) {
  _fmCancelLock.lock()
  _fmCancelledStreams.insert(id)
  _fmCancelLock.unlock()
}

private func fmStreamCancelled(_ id: String) -> Bool {
  _fmCancelLock.lock()
  defer { _fmCancelLock.unlock() }
  return _fmCancelledStreams.contains(id)
}

private func fmClearCancel(_ id: String) {
  _fmCancelLock.lock()
  _fmCancelledStreams.remove(id)
  _fmCancelLock.unlock()
}

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
    Events("onSearchTabEvent", "onFmChunk")

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

    /// P2 (doc 24) — STREAMED free-form generation. Cumulative snapshots from
    /// `streamResponse` are diffed to deltas and emitted as 'onFmChunk' events
    /// ({requestId, delta, done}); the promise resolves with the FULL final
    /// text only when the stream ends, so the JS serializeFm queue naturally
    /// holds until completion — one in-flight model call app-wide stays law.
    AsyncFunction("generateTextStreamed") { (requestId: String, prompt: String, instructions: String) async throws -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else {
          throw OnDeviceAiUnavailableException()
        }
        fmClearCancel(requestId)
        let instr = instructions.isEmpty
          ? "Follow the instructions in the prompt exactly. Reply with plain sentences only — no lists, no markdown, no preamble."
          : instructions
        let session = LanguageModelSession(instructions: instr)
        var full = ""
        for try await snapshot in session.streamResponse(to: prompt) {
          if fmStreamCancelled(requestId) { break }
          let text = snapshot.content
          guard text.count > full.count else { continue }
          let delta = String(text.dropFirst(full.count))
          full = text
          self.sendEvent("onFmChunk", ["requestId": requestId, "delta": delta, "done": false])
        }
        let cancelled = fmStreamCancelled(requestId)
        fmClearCancel(requestId)
        self.sendEvent("onFmChunk", ["requestId": requestId, "delta": "", "done": true])
        return ["answer": full, "cancelled": cancelled]
      }
      #endif
      throw OnDeviceAiUnavailableException()
    }

    /// P2 — cancel an in-flight stream (best-effort; the partial still returns).
    Function("cancelFmStream") { (requestId: String) -> Void in
      fmCancelStream(requestId)
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

    // ── Agentic pipeline (doc 24): stateless guided-generation hops ─────────

    /// Whole-turn router decision. Instructions + prompt arrive fully assembled
    /// from JS (aiLoop.ts) so prompt iteration never needs a native rebuild; a
    /// fresh session per call keeps the turn stateless and replayable. Greedy
    /// sampling — routing must be stable run-to-run.
    AsyncFunction("routeTurn") { (instructions: String, prompt: String) async throws -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else {
          throw OnDeviceAiUnavailableException()
        }
        let session = LanguageModelSession(instructions: instructions)
        let r = try await session.respond(
          to: prompt,
          generating: OnDeviceAgentDecision.self,
          options: GenerationOptions(sampling: .greedy)
        ).content
        return [
          "intent": r.intent,
          "confidence": r.confidence,
          "complexity": r.complexity,
          "assumption": r.assumption,
          "clarifyQuestion": r.clarifyQuestion,
          "clarifyOptions": r.clarifyOptions,
          "abstainReply": r.abstainReply,
          "requests": r.requests.map(agentRequestDict),
        ]
      }
      #endif
      throw OnDeviceAiUnavailableException()
    }

    /// One data-loop hop: enough gathered, or request more (doc 24 §3 step 4).
    AsyncFunction("agentLoopStep") { (instructions: String, prompt: String) async throws -> [String: Any] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard case .available = SystemLanguageModel.default.availability else {
          throw OnDeviceAiUnavailableException()
        }
        let session = LanguageModelSession(instructions: instructions)
        let r = try await session.respond(
          to: prompt,
          generating: OnDeviceAgentLoopStep.self,
          options: GenerationOptions(sampling: .greedy)
        ).content
        return [
          "done": r.done,
          "requests": r.requests.map(agentRequestDict),
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

    /// P3 (doc 24) — PCC ask with a caller-picked REASONING LEVEL and
    /// STRUCTURED quota. The depth engine's door: 'moderate' for router-judged
    /// deep turns, 'deep' for explicit analyze asks, 'light' otherwise.
    /// Supersedes `pccAsk` for new JS (which falls back on older binaries).
    AsyncFunction("pccAskDeep") { (question: String, instructions: String, reasoningLevel: String) async throws -> [String: Any] in
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
          return ["available": false, "reason": reason, "answer": "", "quota": "", "limitReached": false, "resetDate": ""]
        }
        let level: ContextOptions.ReasoningLevel =
          reasoningLevel == "deep" ? .deep : reasoningLevel == "moderate" ? .moderate : .light
        let instr = instructions.isEmpty ? "You are SplitCircle's expense assistant." : instructions
        let session = LanguageModelSession(model: model, instructions: instr)
        let response = try await session.respond(
          to: question,
          contextOptions: ContextOptions(reasoningLevel: level)
        )
        // Structured quota (P3): the pill menu renders these, not a debug string.
        let quota = model.quotaUsage
        let resetIso = quota.resetDate.map { ISO8601DateFormatter().string(from: $0) } ?? ""
        return [
          "available": true,
          "reason": reason,
          "answer": response.content,
          "quota": String(describing: quota.status),
          "limitReached": quota.isLimitReached,
          "resetDate": resetIso,
        ]
      }
      #endif
      return ["available": false, "reason": "unsupportedOS", "answer": "", "quota": "", "limitReached": false, "resetDate": ""]
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
