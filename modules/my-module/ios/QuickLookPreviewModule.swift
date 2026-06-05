import ExpoModulesCore
import QuickLook
import UIKit

public class QuickLookPreviewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("QuickLookPreview")

    AsyncFunction("previewFile") { (uri: String, title: String?, promise: Promise) in
      let localURL: URL
      if uri.starts(with: "file://") {
        if let url = URL(string: uri) {
          localURL = url
        } else if let encoded = uri.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
                  let url = URL(string: encoded) {
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
        let dataSource = QuickLookDataSource(fileURL: localURL, title: title)
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

    View(QuickLookPreviewView.self) {
      Events("onLoad")

      Prop("url") { (view: QuickLookPreviewView, url: String) in
        view.loadFileURL(url)
      }
    }
  }
}

private var dataSourceKey: UInt8 = 0

class QuickLookDataSource: NSObject, QLPreviewControllerDataSource {
  let fileURL: URL
  let customTitle: String?

  init(fileURL: URL, title: String? = nil) {
    self.fileURL = fileURL
    self.customTitle = title
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    return 1
  }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    if let title = customTitle {
      return QuickLookPreviewItem(fileURL: fileURL, title: title)
    }
    return fileURL as QLPreviewItem
  }
}

class QuickLookPreviewItem: NSObject, QLPreviewItem {
  let previewItemURL: URL?
  let previewItemTitle: String?

  init(fileURL: URL, title: String) {
    self.previewItemURL = fileURL
    self.previewItemTitle = title
  }
}
