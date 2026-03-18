import Foundation
import UIKit
import VisionKit
import Vision
internal import React

/// Native iOS module that wraps VNDocumentCameraViewController for document scanning
/// and VNRecognizeTextRequest for on-device OCR text extraction.
/// Returns structured receipt data (items, tax, tip, total) back to React Native.
@objc(VisionKitReceiptScanner)
class VisionKitReceiptScanner: RCTEventEmitter, VNDocumentCameraViewControllerDelegate {

  private var scanResolve: RCTPromiseResolveBlock?
  private var scanReject: RCTPromiseRejectBlock?

  // MARK: - RCTEventEmitter

  override static func requiresMainQueueSetup() -> Bool {
    return true
  }

  override func supportedEvents() -> [String]! {
    return ["onScanProgress"]
  }

  // MARK: - Public API

  @objc func isAvailable(_ resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    if #available(iOS 13.0, *) {
      resolve(VNDocumentCameraViewController.isSupported)
    } else {
      resolve(false)
    }
  }

  @objc func scanDocument(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 13.0, *), VNDocumentCameraViewController.isSupported else {
      reject("UNSUPPORTED", "VisionKit document scanning is not supported on this device.", nil)
      return
    }

    self.scanResolve = resolve
    self.scanReject = reject

    DispatchQueue.main.async { [weak self] in
      let scannerVC = VNDocumentCameraViewController()
      scannerVC.delegate = self
      scannerVC.modalPresentationStyle = .fullScreen

      guard let rootVC = self?.topViewController() else {
        reject("NO_VIEW_CONTROLLER", "Could not find a view controller to present the scanner.", nil)
        self?.scanResolve = nil
        self?.scanReject = nil
        return
      }

      rootVC.present(scannerVC, animated: true)
    }
  }

  // MARK: - VNDocumentCameraViewControllerDelegate

  @available(iOS 13.0, *)
  func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                     didFinishWith scan: VNDocumentCameraScan) {
    controller.dismiss(animated: true) { [weak self] in
      self?.processScannedDocument(scan)
    }
  }

  @available(iOS 13.0, *)
  func documentCameraViewController(_ controller: VNDocumentCameraViewController,
                                     didFailWithError error: Error) {
    controller.dismiss(animated: true) { [weak self] in
      self?.scanReject?("SCAN_FAILED", error.localizedDescription, error)
      self?.scanResolve = nil
      self?.scanReject = nil
    }
  }

  @available(iOS 13.0, *)
  func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
    controller.dismiss(animated: true) { [weak self] in
      self?.scanResolve?(["cancelled": true])
      self?.scanResolve = nil
      self?.scanReject = nil
    }
  }

  // MARK: - OCR Processing

  @available(iOS 13.0, *)
  private func processScannedDocument(_ scan: VNDocumentCameraScan) {
    DispatchQueue.main.async { [weak self] in
      self?.sendEvent(withName: "onScanProgress", body: ["status": "processing", "message": "Processing scanned document..."])
    }

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self = self else { return }

      var allObservations: [(String, CGRect)] = []
      var savedImageUri: String?

      for pageIndex in 0..<scan.pageCount {
        let image = scan.imageOfPage(at: pageIndex)

        if pageIndex == 0 {
          savedImageUri = self.saveImageToTemp(image)
        }

        guard let cgImage = image.cgImage else { continue }

        let requestHandler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        let textRequest = VNRecognizeTextRequest()
        textRequest.recognitionLevel = .accurate
        textRequest.recognitionLanguages = ["en-US"]
        textRequest.usesLanguageCorrection = true

        do {
          try requestHandler.perform([textRequest])

          if let results = textRequest.results {
            for observation in results {
              if let topCandidate = observation.topCandidates(1).first {
                allObservations.append((topCandidate.string, observation.boundingBox))
              }
            }
          }
        } catch {
          NSLog("[VisionKitReceiptScanner] OCR error on page \(pageIndex): \(error.localizedDescription)")
        }
      }

      NSLog("[VisionKitReceiptScanner] Raw OCR found \(allObservations.count) text observations")
      for (i, obs) in allObservations.enumerated() {
        NSLog("[VisionKitReceiptScanner] Observation \(i): \"\(obs.0)\" y=\(obs.1.origin.y) h=\(obs.1.size.height)")
      }

      DispatchQueue.main.async { [weak self] in
        self?.sendEvent(withName: "onScanProgress", body: [
          "status": "parsing",
          "message": "Extracting receipt items...",
          "textLinesFound": allObservations.count
        ])
      }

      let receiptData = self.parseReceiptFromObservations(allObservations)

      NSLog("[VisionKitReceiptScanner] Parsed \(receiptData.items.count) items, total=\(receiptData.total ?? -1), tax=\(receiptData.tax ?? -1)")

      DispatchQueue.main.async {
        var result: [String: Any] = [
          "cancelled": false,
          "rawText": allObservations.map { $0.0 }.joined(separator: "\n"),
          "items": receiptData.items.map { item -> [String: Any] in
            return [
              "name": item.name,
              "price": item.price,
              "quantity": item.quantity
            ]
          },
          "subtotal": receiptData.subtotal ?? NSNull(),
          "tax": receiptData.tax ?? NSNull(),
          "tip": receiptData.tip ?? NSNull(),
          "total": receiptData.total ?? NSNull(),
          "merchantName": receiptData.merchantName ?? NSNull(),
          "date": receiptData.date ?? NSNull()
        ]

        if let imageUri = savedImageUri {
          result["imageUri"] = imageUri
        }

        self.sendEvent(withName: "onScanProgress", body: [
          "status": "complete",
          "message": "Receipt scanned successfully!",
          "itemCount": receiptData.items.count
        ])

        self.scanResolve?(result)
        self.scanResolve = nil
        self.scanReject = nil
      }
    }
  }

  // MARK: - Receipt Parsing

  private struct ReceiptItem {
    let name: String
    let price: Double
    let quantity: Int
  }

  private struct ParsedReceipt {
    var items: [ReceiptItem] = []
    var subtotal: Double?
    var tax: Double?
    var tip: Double?
    var total: Double?
    var merchantName: String?
    var date: String?
  }

  /// Main parsing entry point — takes raw OCR observations and returns structured receipt data.
  private func parseReceiptFromObservations(_ observations: [(String, CGRect)]) -> ParsedReceipt {
    var receipt = ParsedReceipt()

    // Sort observations top-to-bottom (Vision uses bottom-left origin, so higher Y = higher on image)
    let sortedObservations = observations.sorted { $0.1.origin.y > $1.1.origin.y }
    let allTextLines = sortedObservations.map { $0.0 }

    // Extract merchant name and date from top of receipt
    receipt.merchantName = extractMerchantName(from: allTextLines)
    receipt.date = extractDate(from: allTextLines)

    // Group text observations on the same horizontal line into single receipt lines
    let receiptLines = groupIntoReceiptLines(sortedObservations)

    NSLog("[VisionKitReceiptScanner] Grouped into \(receiptLines.count) receipt lines")
    for (i, line) in receiptLines.enumerated() {
      NSLog("[VisionKitReceiptScanner] Line \(i): \"\(line.text)\"")
    }

    // ── Price regex: matches $12.34, 12.34, $ 12.34 ──
    // Handles trailing single letter (Walmart uses R, F, T; Hy-Vee uses other letters)
    let pricePattern = try! NSRegularExpression(pattern: #"(?:\$\s*)?(\d{1,6}\.\d{2})\s*[A-Z]?\s*$"#, options: .caseInsensitive)
    // Fallback: price anywhere in the line (with or without $)
    let priceAnywhere = try! NSRegularExpression(pattern: #"(?:\$\s*)(\d{1,6}\.\d{2})"#)
    // Quantity patterns: "2 @", "2x", "QTY 2", "QTY: 2"
    let quantityPattern = try! NSRegularExpression(pattern: #"(\d+)\s*[xX@]|(?:QTY|Qty|qty)[:\s]*(\d+)"#)

    // ── Keywords that identify NON-item summary/footer lines ──
    // These must contain one of these keywords to be skipped as summary lines.
    // IMPORTANT: Only skip lines where the keyword IS the topic, not just a substring;
    // e.g. "TAX $0.52" is a summary, but "TAXIDERMY KIT $19.99" is an item.
    let summaryPatterns: [(pattern: String, isRegex: Bool)] = [
      ("subtotal", false), ("sub total", false), ("sub-total", false),
      ("grand total", false),
      ("sales tax", false), (" tax ", false), ("tax$", true), ("^tax\\d?\\s", true),
      ("hst ", false), ("gst ", false), (" vat ", false), ("^vat ", true),
      ("tip", false), ("gratuity", false), ("service charge", false),
      ("change due", false), ("cash tend", false), ("credit tend", false),
      ("visa tend", false), ("wmp ", false), ("walmart pay", false),
      ("total purchase", false),
      ("amount tend", false), ("amount due", false), ("amount paid", false),
      ("balance due", false), ("balance ", false),
      ("visa", false), ("mastercard", false), ("amex", false), ("discover", false),
      ("debit", false), ("cash", false), ("check", false),
      ("card ending", false), ("card #", false), ("card no", false),
      ("account #", false), ("appr#", false),
      ("approval", false), ("auth code", false), ("ref #", false), ("ref:", false),
      ("thank you", false), ("thanks", false),
      ("receipt", false), ("invoice", false), ("transaction", false),
      ("store #", false), ("store:", false), ("register", false), ("cashier", false),
      ("you saved", false), ("your savings", false), ("member", false),
      ("loyalty", false), ("rewards", false), ("points", false),
      ("refund", false), ("return", false), ("exchange", false),
      ("coupon", false), ("discount", false), ("promo", false),
      ("# items", false), ("items sold", false), ("item count", false),
    ]

    // ── Lines that are just headers / column labels ──
    let headerPatterns = ["qty", "price", "amount", "description", "dept", "upc"]

    // ── For handling multi-line items (e.g., GRANNY APPLE on one line, weight+price on next) ──
    var pendingName: String? = nil
    var pendingPrice: Double? = nil

    for line in receiptLines {
      let text = line.text
      let trimmed = text.trimmingCharacters(in: .whitespaces)
      let lower = trimmed.lowercased()

      // Skip empty / very short lines
      guard trimmed.count >= 3 else { continue }

      // Skip lines that are ALL numbers/separators (dates, phone numbers, barcodes)
      let alphaCount = trimmed.filter { $0.isLetter }.count
      if alphaCount == 0 { continue }

      // ── Check for TOTAL line first (special handling, last total wins) ──
      if matchesTotal(lower) {
        if let price = extractBestPrice(from: trimmed, primary: pricePattern, fallback: priceAnywhere) {
          receipt.total = price
        }
        continue
      }

      // ── Check for SUBTOTAL ──
      if lower.contains("subtotal") || lower.contains("sub total") || lower.contains("sub-total") {
        if let price = extractBestPrice(from: trimmed, primary: pricePattern, fallback: priceAnywhere) {
          receipt.subtotal = price
        }
        continue
      }

      // ── Check for TAX ──
      if matchesTax(lower) {
        if let price = extractBestPrice(from: trimmed, primary: pricePattern, fallback: priceAnywhere) {
          receipt.tax = price
        }
        continue
      }

      // ── Check for TIP ──
      if lower.contains("tip") || lower.contains("gratuity") || lower.contains("service charg") {
        if let price = extractBestPrice(from: trimmed, primary: pricePattern, fallback: priceAnywhere) {
          receipt.tip = price
        }
        continue
      }

      // ── Check if this is a summary / footer line (skip it) ──
      if isSummaryLine(lower, patterns: summaryPatterns) { continue }

      // ── Check if this is a header row ──
      let isHeader = headerPatterns.allSatisfy { lower.contains($0) } ||
                     (lower.hasPrefix("qty") && lower.contains("price"))
      if isHeader { continue }

      // ── Try to parse as an ITEM line ──
      let maybePrice = extractBestPrice(from: trimmed, primary: pricePattern, fallback: priceAnywhere)

      if let price = maybePrice, price > 0, price < 10000 {
        // If there's a pending name from a previous line (name-only line),
        // merge this price with that name.
        if let pName = pendingName {
          receipt.items.append(ReceiptItem(name: pName, price: price, quantity: 1))
          NSLog("[VisionKitReceiptScanner] ✅ Merged Item: \"\(pName)\" $\(price)")
          pendingName = nil
          continue
        }

        // Extract quantity (default 1)
        var quantity = 1
        let qtyRange = NSRange(trimmed.startIndex..., in: trimmed)
        if let qtyMatch = quantityPattern.firstMatch(in: trimmed, range: qtyRange) {
          let g1 = qtyMatch.range(at: 1)
          let g2 = qtyMatch.range(at: 2)
          if g1.location != NSNotFound, let r = Range(g1, in: trimmed) {
            quantity = Int(trimmed[r]) ?? 1
          } else if g2.location != NSNotFound, let r = Range(g2, in: trimmed) {
            quantity = Int(trimmed[r]) ?? 1
          }
        }

        // Extract item name: remove prices, quantity patterns, UPCs, and trailing tax indicators
        let itemName = cleanItemName(from: trimmed, pricePattern: priceAnywhere, qtyPattern: quantityPattern)

        // Only add items with a meaningful name
        if itemName.count >= 2 {
          receipt.items.append(ReceiptItem(name: itemName, price: price, quantity: quantity))
          NSLog("[VisionKitReceiptScanner] ✅ Item: \"\(itemName)\" $\(price) qty=\(quantity)")
        } else {
          // No name but has price — could be a weight/continuation line.
          NSLog("[VisionKitReceiptScanner] ⚠️ Price $\(price) with no name, saving for merge")
          pendingPrice = price
        }
      } else {
        // No price found. This might be a name-only line (e.g., "GRANNY APPLE 000000040170 F")
        // where the item name is here but the price is on the next line (weight calculation)
        let candidateName = cleanItemName(from: trimmed, pricePattern: priceAnywhere, qtyPattern: quantityPattern)
        if candidateName.count >= 2 && !isSummaryLine(lower, patterns: summaryPatterns) {
          // Check if this looks like an item name line (has some alpha characters, not just codes)
          let alphaRatio = Double(candidateName.filter { $0.isLetter }.count) / Double(max(1, candidateName.count))
          if alphaRatio > 0.4 {
            pendingName = candidateName
            NSLog("[VisionKitReceiptScanner] 📝 Name-only line saved: \"\(candidateName)\"")
          }
        }
      }
    }

    // ── Post-processing: compute total if missing ──
    if receipt.total == nil {
      if let subtotal = receipt.subtotal {
        receipt.total = subtotal + (receipt.tax ?? 0) + (receipt.tip ?? 0)
      } else if !receipt.items.isEmpty {
        let itemsTotal = receipt.items.reduce(0.0) { $0 + $1.price * Double($1.quantity) }
        receipt.total = itemsTotal + (receipt.tax ?? 0) + (receipt.tip ?? 0)
      }
    }

    return receipt
  }

  // MARK: - Line Grouping

  private struct ReceiptLine {
    let text: String
    let y: CGFloat
  }

  /// Groups OCR observations into receipt lines based on vertical position.
  /// Text blocks at approximately the same Y coordinate are joined into one line (left to right).
  private func groupIntoReceiptLines(_ observations: [(String, CGRect)]) -> [ReceiptLine] {
    guard !observations.isEmpty else { return [] }

    // Use a more generous Y threshold — receipt text can be slightly off-axis.
    // 0.008 works well for most receipt heights (a pixel or two of skew).
    let yThreshold: CGFloat = 0.015

    var groups: [(y: CGFloat, segments: [(text: String, x: CGFloat)])] = []

    for (text, box) in observations {
      let centerY = box.origin.y + box.size.height / 2.0
      let centerX = box.origin.x

      var merged = false
      for i in 0..<groups.count {
        if abs(groups[i].y - centerY) < yThreshold {
          // Update group Y to weighted average for better grouping
          let oldCount = CGFloat(groups[i].segments.count)
          groups[i].y = (groups[i].y * oldCount + centerY) / (oldCount + 1)
          groups[i].segments.append((text: text, x: centerX))
          merged = true
          break
        }
      }

      if !merged {
        groups.append((y: centerY, segments: [(text: text, x: centerX)]))
      }
    }

    // Sort each group's segments left-to-right, join with spacing
    return groups.map { group in
      let sorted = group.segments.sorted { $0.x < $1.x }
      let joined = sorted.map { $0.text }.joined(separator: "  ")
      return ReceiptLine(text: joined, y: group.y)
    }.sorted { $0.y > $1.y } // top to bottom (higher Y = closer to top of image)
  }

  // MARK: - Price Extraction

  /// Tries the primary pattern first (price at end of line), then falls back to price anywhere.
  private func extractBestPrice(from text: String, primary: NSRegularExpression, fallback: NSRegularExpression) -> Double? {
    let range = NSRange(text.startIndex..., in: text)

    // Primary: price near end of line (most accurate for receipts)
    let primaryMatches = primary.matches(in: text, range: range)
    if let lastMatch = primaryMatches.last,
       let priceRange = Range(lastMatch.range(at: 1), in: text),
       let price = Double(text[priceRange]) {
      return price
    }

    // Fallback: any $X.XX in the line — use the last occurrence
    let fallbackMatches = fallback.matches(in: text, range: range)
    if let lastMatch = fallbackMatches.last,
       let priceRange = Range(lastMatch.range(at: 1), in: text),
       let price = Double(text[priceRange]) {
      return price
    }

    // Last resort: bare number pattern X.XX at end of string, optionally followed by a single letter
    let barePattern = try! NSRegularExpression(pattern: #"(\d{1,6}\.\d{2})\s*[A-Z]?\s*$"#, options: .caseInsensitive)
    let bareMatches = barePattern.matches(in: text, range: range)
    if let lastMatch = bareMatches.last,
       let priceRange = Range(lastMatch.range(at: 1), in: text),
       let price = Double(text[priceRange]) {
      return price
    }

    return nil
  }

  // MARK: - Item Name Cleaning

  /// Strips prices, quantities, tax indicators and trailing junk from an item line to get just the name.
  private func cleanItemName(from text: String, pricePattern: NSRegularExpression, qtyPattern: NSRegularExpression) -> String {
    var name = text

    // Remove ALL price occurrences ($X.XX or X.XX)
    let allPricePattern = try! NSRegularExpression(pattern: #"\$?\s*\d{1,6}\.\d{2}"#)
    name = allPricePattern.stringByReplacingMatches(in: name, range: NSRange(name.startIndex..., in: name), withTemplate: "")

    // Remove quantity patterns (2x, 3 @, QTY 2, etc.)
    name = qtyPattern.stringByReplacingMatches(in: name, range: NSRange(name.startIndex..., in: name), withTemplate: "")

    // Remove UPC/barcode codes: sequences of 8+ digits (can appear ANYWHERE in the line)
    let upcPattern = try! NSRegularExpression(pattern: #"\d{8,}"#)
    name = upcPattern.stringByReplacingMatches(in: name, range: NSRange(name.startIndex..., in: name), withTemplate: "")

    // Remove standalone single letters (tax indicators like F, T, R, N, X, A, B, O)
    // Only remove if they stand alone (surrounded by spaces or at line edges)
    let taxIndicator = try! NSRegularExpression(pattern: #"(?:^|\s)[FTNXABORW](?:\s|$)"#, options: .caseInsensitive)
    name = taxIndicator.stringByReplacingMatches(in: name, range: NSRange(name.startIndex..., in: name), withTemplate: " ")

    // Remove weight/unit info like "1.97 lb. @ 1.00 lb. / 1.53" (weight calculation lines)
    let weightCalc = try! NSRegularExpression(pattern: #"\d+\.?\d*\s*(?:lb|lbs|oz|kg)\s*\.?\s*@.*"#, options: .caseInsensitive)
    name = weightCalc.stringByReplacingMatches(in: name, range: NSRange(name.startIndex..., in: name), withTemplate: "")

    // Remove leading item/dept codes like "004011" (5+ consecutive digits at start)
    let codePattern = try! NSRegularExpression(pattern: #"^\d{5,}\s*"#)
    name = codePattern.stringByReplacingMatches(in: name, range: NSRange(name.startIndex..., in: name), withTemplate: "")

    // Remove leading/trailing special characters
    name = name
      .trimmingCharacters(in: .whitespaces)
      .trimmingCharacters(in: CharacterSet(charactersIn: ".-–—:*#/"))
      .trimmingCharacters(in: .whitespaces)

    // Remove stray $ signs
    name = name.replacingOccurrences(of: "$", with: "").trimmingCharacters(in: .whitespaces)

    // Collapse multiple spaces
    while name.contains("  ") {
      name = name.replacingOccurrences(of: "  ", with: " ")
    }

    return name
  }

  // MARK: - Summary / Footer Detection

  /// Checks if a line is a "TOTAL" line (not subtotal)
  private func matchesTotal(_ lower: String) -> Bool {
    // Must contain "total" but NOT "subtotal" / "sub total"
    guard lower.contains("total") else { return false }
    if lower.contains("subtotal") || lower.contains("sub total") || lower.contains("sub-total") { return false }
    return true
  }

  /// Checks if a line is a TAX line.
  /// Handles TAX, TAX1, TAX2, SALES TAX, STATE TAX, etc.
  private func matchesTax(_ lower: String) -> Bool {
    // "tax" followed by optional digit, then space or colon or end
    if let regex = try? NSRegularExpression(pattern: #"^tax\d?\s"#),
       regex.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)) != nil { return true }
    if lower.hasPrefix("tax:") || lower == "tax" { return true }
    if lower.hasSuffix(" tax") { return true }
    if lower.contains("sales tax") { return true }
    if lower.contains("state tax") || lower.contains("local tax") || lower.contains("county tax") { return true }
    if lower.hasPrefix("hst") || lower.hasPrefix("gst") || lower.hasPrefix("vat") { return true }
    return false
  }

  /// Checks if a line matches any of the summary/footer patterns.
  private func isSummaryLine(_ lower: String, patterns: [(pattern: String, isRegex: Bool)]) -> Bool {
    for p in patterns {
      if p.isRegex {
        if let regex = try? NSRegularExpression(pattern: p.pattern, options: .caseInsensitive) {
          let range = NSRange(lower.startIndex..., in: lower)
          if regex.firstMatch(in: lower, range: range) != nil {
            return true
          }
        }
      } else {
        if lower.contains(p.pattern) { return true }
      }
    }
    return false
  }

  // MARK: - Merchant & Date Extraction

  private func extractMerchantName(from lines: [String]) -> String? {
    for line in lines.prefix(5) {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      // Need at least 3 chars and some letters
      if trimmed.count >= 3 {
        let letters = trimmed.filter { $0.isLetter }
        guard letters.count >= 2 else { continue }
        let lower = trimmed.lowercased()
        // Skip common non-merchant lines
        if lower.contains("receipt") || lower.contains("invoice") || lower.contains("order #") { continue }
        if lower.allSatisfy({ $0.isNumber || $0 == "/" || $0 == "-" || $0 == " " || $0 == "." || $0 == "(" || $0 == ")" }) { continue }
        return String(trimmed.prefix(60))
      }
    }
    return nil
  }

  private func extractDate(from lines: [String]) -> String? {
    let datePatterns = [
      try! NSRegularExpression(pattern: #"(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})"#),
      try! NSRegularExpression(pattern: #"(\w{3,9}\s+\d{1,2},?\s+\d{4})"#, options: .caseInsensitive),
      try! NSRegularExpression(pattern: #"(\d{4}[/\-]\d{2}[/\-]\d{2})"#),
    ]

    for line in lines {
      let range = NSRange(line.startIndex..., in: line)
      for pattern in datePatterns {
        if let match = pattern.firstMatch(in: line, range: range),
           let dateRange = Range(match.range(at: 1), in: line) {
          return String(line[dateRange])
        }
      }
    }
    return nil
  }

  // MARK: - Utilities

  private func saveImageToTemp(_ image: UIImage) -> String? {
    guard let data = image.jpegData(compressionQuality: 0.85) else { return nil }

    let fileName = "receipt_scan_\(Int(Date().timeIntervalSince1970 * 1000)).jpg"
    let tempDir = NSTemporaryDirectory()
    let filePath = (tempDir as NSString).appendingPathComponent(fileName)
    let fileURL = URL(fileURLWithPath: filePath)

    do {
      try data.write(to: fileURL)
      return fileURL.absoluteString
    } catch {
      NSLog("[VisionKitReceiptScanner] Failed to save image: \(error.localizedDescription)")
      return nil
    }
  }

  private func topViewController() -> UIViewController? {
    guard let windowScene = UIApplication.shared.connectedScenes
      .compactMap({ $0 as? UIWindowScene })
      .first,
      let rootVC = windowScene.windows.first(where: { $0.isKeyWindow })?.rootViewController else {
      return nil
    }
    return findTopViewController(from: rootVC)
  }

  private func findTopViewController(from vc: UIViewController) -> UIViewController {
    if let presented = vc.presentedViewController {
      return findTopViewController(from: presented)
    }
    if let nav = vc as? UINavigationController, let top = nav.topViewController {
      return findTopViewController(from: top)
    }
    if let tab = vc as? UITabBarController, let selected = tab.selectedViewController {
      return findTopViewController(from: selected)
    }
    return vc
  }
}
