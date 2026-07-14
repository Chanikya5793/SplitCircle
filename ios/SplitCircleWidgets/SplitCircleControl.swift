import WidgetKit
import SwiftUI
import AppIntents

// Control Center / Lock Screen / Action-button control (iOS 18+). A tap opens the
// app to the groups list. Kept deliberately minimal: a control runs in the widget
// EXTENSION process, whose `UserDefaults.standard` is NOT the app's, so it can't use
// the pending-deep-link handoff the in-app intents use. Opening to the default
// screen avoids a second cross-process channel for v1.

@available(iOS 18.0, *)
struct OpenSplitCircleControlIntent: AppIntent {
  static var title: LocalizedStringResource = "Open SplitCircle"
  static var openAppWhenRun = true
  init() {}
  func perform() async throws -> some IntentResult { .result() }
}

@available(iOS 18.0, *)
struct SplitCircleBalanceControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "com.splitcircle.app.control.balance") {
      ControlWidgetButton(action: OpenSplitCircleControlIntent()) {
        Label("SplitCircle", systemImage: "creditcard")
      }
    }
    .displayName("Open SplitCircle")
    .description("Jump to your SplitCircle balances.")
  }
}
