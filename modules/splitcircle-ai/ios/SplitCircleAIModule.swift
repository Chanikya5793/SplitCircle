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
#endif

public class SplitCircleAIModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SplitCircleAI")

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
        activity.suggestedInvocationPhrase = "Ask SplitCircle"
        if let query, !query.isEmpty {
          // Persist only the (already-redacted) query text for resume.
          activity.userInfo = ["query": query]
          activity.requiredUserInfoKeys = ["query"]
        }
        activity.becomeCurrent()
        currentAskActivity = activity
      }
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
  }
}

internal final class OnDeviceAiUnavailableException: Exception {
  override var reason: String {
    "On-device Apple Intelligence model is not available on this device"
  }
}
