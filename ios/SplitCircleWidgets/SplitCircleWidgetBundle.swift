import WidgetKit
import SwiftUI

/// Entry point for the SplitCircle Widget Extension target. `@main` lives here — the
/// extension's Info.plist points `NSExtensionPrincipalClass` at the generated
/// `$(PRODUCT_MODULE_NAME).SplitCircleWidgetBundle` (see Info.plist / the runbook in
/// ai_layer/docs/19). Add new widgets/controls to `body` below.
@main
struct SplitCircleWidgetBundle: WidgetBundle {
  var body: some Widget {
    BalanceWidget()
    // Control Center controls are iOS 18+. WidgetBundleBuilder supports `if #available`.
    if #available(iOS 18.0, *) {
      SplitCircleBalanceControl()
    }
  }
}
