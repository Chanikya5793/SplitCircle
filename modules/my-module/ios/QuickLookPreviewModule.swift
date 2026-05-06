import ExpoModulesCore
import QuickLook
import UIKit

public class QuickLookPreviewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("QuickLookPreview")

    AsyncFunction("previewFile") { (uri: String, promise: Promise) in
      let localURL: URL
      if uri.starts(with: "file://") {
        if let url = URL(string: uri) {
          localURL = url
        } else if let encoded = uri.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed), let url = URL(string: encoded) {
          localURL = url
        } else {
          promise.reject("INVALID_URI", "Invalid URI provided: \(uri)")
          return
        }
      } else {
        localURL = URL(fileURLWithPath: uri)
      }
      
      DispatchQueue.main.async {
        let previewController = QLPreviewController()
        let dataSource = QuickLookDataSource(fileURL: localURL)
        // retain the data source
        objc_setAssociatedObject(previewController, &dataSourceKey, dataSource, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        previewController.dataSource = dataSource
        
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else {
          promise.reject("NO_UI", "Could not find root view controller")
          return
        }
        
        var topController = root
        while let presented = topController.presentedViewController {
          topController = presented
        }
        
        topController.present(previewController, animated: true) {
          promise.resolve(true)
        }
      }
    }
  }
}

private var dataSourceKey: UInt8 = 0

class QuickLookDataSource: NSObject, QLPreviewControllerDataSource {
  let fileURL: URL
  
  init(fileURL: URL) {
    self.fileURL = fileURL
  }
  
  func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    return 1
  }
  
  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    return fileURL as QLPreviewItem
  }
}
