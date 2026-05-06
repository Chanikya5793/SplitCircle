import Foundation

#if canImport(QuickLook)
import QuickLook
#endif

#if canImport(React)
internal import React
#endif

#if canImport(UIKit)
import UIKit
#endif

#if canImport(QuickLook)
@objc(QuickLookPreview)
class QuickLookPreview: NSObject, RCTBridgeModule, QLPreviewControllerDataSource {
  
  static func moduleName() -> String! {
    return "QuickLookPreview"
  }
  
  static func requiresMainQueueSetup() -> Bool {
    return true
  }
  
  var fileURL: URL?

  @objc
  func previewFile(_ uri: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard let url = URL(string: uri) else {
        reject("INVALID_URI", "The provided URI is invalid", nil)
        return
      }
      
      // Ensure it is treated as a file URL
      var localURL = url
      if !url.isFileURL {
        localURL = URL(fileURLWithPath: url.path)
      }
      
      self.fileURL = localURL
      
      let previewController = QLPreviewController()
      previewController.dataSource = self
      
      guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
            let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else {
        reject("NO_UI", "Could not find root view controller", nil)
        return
      }
      
      var topController = root
      while let presented = topController.presentedViewController {
        topController = presented
      }
      
      topController.present(previewController, animated: true) {
        resolve(true)
      }
    }
  }
  
  // MARK: - QLPreviewControllerDataSource
  func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    return self.fileURL != nil ? 1 : 0
  }
  
  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    return self.fileURL! as QLPreviewItem
  }
}
#endif
