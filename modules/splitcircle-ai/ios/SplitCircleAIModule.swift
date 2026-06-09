import ExpoModulesCore
import Foundation
import Intents

/// Keep the donated activity alive — `becomeCurrent()` does not retain it.
private var currentAskActivity: NSUserActivity?

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
  }
}
