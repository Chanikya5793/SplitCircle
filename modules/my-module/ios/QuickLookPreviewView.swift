import ExpoModulesCore
import WebKit

class QuickLookPreviewView: ExpoView {
  let webView = WKWebView()
  let onLoad = EventDispatcher()
  var delegate: WebViewDelegate?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    delegate = WebViewDelegate { url in
      self.onLoad(["url": url])
    }
    webView.navigationDelegate = delegate
    addSubview(webView)
  }

  override func layoutSubviews() {
    webView.frame = bounds
  }

  func loadFileURL(_ urlString: String) {
    let url: URL
    if urlString.starts(with: "file://") {
      if let parsed = URL(string: urlString) {
        url = parsed
      } else if let encoded = urlString.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
                let parsed = URL(string: encoded) {
        url = parsed
      } else {
        return
      }
    } else {
      url = URL(fileURLWithPath: urlString)
    }
    webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
  }
}

class WebViewDelegate: NSObject, WKNavigationDelegate {
  let onUrlChange: (String) -> Void

  init(onUrlChange: @escaping (String) -> Void) {
    self.onUrlChange = onUrlChange
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation) {
    if let url = webView.url {
      onUrlChange(url.absoluteString)
    }
  }
}
