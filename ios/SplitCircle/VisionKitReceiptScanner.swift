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
        NSLog("[VisionKitReceiptScanner] Obs \(i): \"\(obs.0)\" x=\(String(format: "%.3f", obs.1.origin.x)) y=\(String(format: "%.3f", obs.1.origin.y)) w=\(String(format: "%.3f", obs.1.size.width)) h=\(String(format: "%.3f", obs.1.size.height))")
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

  // MARK: - Data Structures

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

  /// An individual text observation with its position info
  private struct TextBlock {
    let text: String
    let rect: CGRect // normalized: origin at bottom-left, x goes right, y goes up
    var centerY: CGFloat { rect.origin.y + rect.size.height / 2 }
    var centerX: CGFloat { rect.origin.x + rect.size.width / 2 }
    var rightEdge: CGFloat { rect.origin.x + rect.size.width }
  }

  /// A grouped receipt line containing multiple text blocks on the same horizontal line
  private struct ReceiptLine {
    let blocks: [TextBlock]
    let fullText: String
    let avgY: CGFloat

    /// The leftmost text (item name region)
    var leftText: String {
      let sorted = blocks.sorted { $0.rect.origin.x < $1.rect.origin.x }
      // Take blocks from the left until we hit a price-like block
      var parts: [String] = []
      for block in sorted {
        let t = block.text.trimmingCharacters(in: .whitespaces)
        // Stop if this block is purely a price (e.g. "12.44", "3.78 R", "$5.99")
        if isPriceBlock(t) { break }
        parts.append(t)
      }
      return parts.joined(separator: " ")
    }

    /// The rightmost price value on this line
    var rightPrice: Double? {
      let sorted = blocks.sorted { $0.rect.origin.x < $1.rect.origin.x }
      // Scan from right to find the first price
      for block in sorted.reversed() {
        if let price = extractPriceFromBlock(block.text) {
          return price
        }
      }
      return nil
    }
  }

  // MARK: - Main Parsing

  private func parseReceiptFromObservations(_ observations: [(String, CGRect)]) -> ParsedReceipt {
    var receipt = ParsedReceipt()

    let textBlocks = observations.map { TextBlock(text: $0.0, rect: $0.1) }

    // ── Extract merchant name using text HEIGHT (biggest text near top = store name) ──
    receipt.merchantName = extractMerchantNameSpatial(from: textBlocks)
    receipt.date = extractDateFromBlocks(textBlocks)

    // ── Group into receipt lines using Y-coordinate overlap ──
    let receiptLines = groupIntoLines(textBlocks)

    NSLog("[VisionKitReceiptScanner] Grouped into \(receiptLines.count) receipt lines")
    for (i, line) in receiptLines.enumerated() {
      NSLog("[VisionKitReceiptScanner] Line \(i): \"\(line.fullText)\" [blocks=\(line.blocks.count)]")
    }

    // ── Classify each line ──
    // We process top-to-bottom. Receipt structure is typically:
    // [Header/Store info] → [Items] → [Subtotal] → [Tax] → [Total] → [Payment/Footer]

    var inItemSection = false
    var lastItemName: String? = nil // for weight continuation lines

    for line in receiptLines {
      let text = line.fullText
      let trimmed = text.trimmingCharacters(in: .whitespaces)
      let lower = trimmed.lowercased()

      // Skip empty or very short lines
      guard trimmed.count >= 3 else { continue }

      // Skip lines that are ALL numbers/punctuation (barcodes, phone numbers, IDs)
      let alphaCount = trimmed.filter { $0.isLetter }.count
      if alphaCount == 0 { continue }

      // ── TOTAL ──
      if matchesTotal(lower) {
        if let price = line.rightPrice ?? extractAnyPrice(from: trimmed) {
          receipt.total = price
        }
        inItemSection = false
        continue
      }

      // ── SUBTOTAL ──
      if matchesSubtotal(lower) {
        if let price = line.rightPrice ?? extractAnyPrice(from: trimmed) {
          receipt.subtotal = price
        }
        inItemSection = false
        continue
      }

      // ── TAX ──
      if matchesTax(lower) {
        if let price = line.rightPrice ?? extractAnyPrice(from: trimmed) {
          receipt.tax = price
        }
        continue
      }

      // ── TIP ──
      if matchesTip(lower) {
        if let price = line.rightPrice ?? extractAnyPrice(from: trimmed) {
          receipt.tip = price
        }
        continue
      }

      // ── SKIP: Non-item lines (payment, footer, store info, addresses) ──
      if isSkipLine(lower) { continue }

      // ── Detect start of item section ──
      // Item sections often start after header info. We start parsing items
      // when we see the first line with a valid price that isn't a summary line.
      if let price = line.rightPrice, price > 0 && price < 5000 {
        inItemSection = true

        // Extract item name from left-side text blocks
        var itemName = extractItemName(from: line)

        // Check if this is a weight continuation line (e.g., "1.97 lb. @ 1.00 lb. / 1.53 3.01 R")
        if isWeightLine(lower) {
          // Attach price to previous item name
          if let prevName = lastItemName {
            receipt.items.append(ReceiptItem(name: prevName, price: price, quantity: 1))
            NSLog("[VisionKitReceiptScanner] ✅ Weight item: \"\(prevName)\" $\(price)")
            lastItemName = nil
            continue
          }
        }

        if itemName.count >= 2 {
          receipt.items.append(ReceiptItem(name: itemName, price: price, quantity: 1))
          NSLog("[VisionKitReceiptScanner] ✅ Item: \"\(itemName)\" $\(price)")
          lastItemName = nil
        }
      } else if inItemSection {
        // Line in item section but no price — could be name-only (e.g., weight items)
        let candidateName = extractItemName(from: line)
        if candidateName.count >= 2 && !isAddressLine(lower) {
          lastItemName = candidateName
          NSLog("[VisionKitReceiptScanner] 📝 Name-only: \"\(candidateName)\"")
        }
      }
    }

    // ── Post-processing ──
    if receipt.total == nil && receipt.subtotal != nil {
      let itemSum = receipt.items.reduce(0.0) { $0 + $1.price }
      receipt.total = itemSum + (receipt.tax ?? 0) + (receipt.tip ?? 0)
    }

    return receipt
  }

  // MARK: - Line Grouping (Spatial)

  /// Groups text blocks into receipt lines based on Y-coordinate proximity.
  /// Uses a conservative, data-driven threshold to avoid merging adjacent receipt lines.
  private func groupIntoLines(_ blocks: [TextBlock]) -> [ReceiptLine] {
    guard !blocks.isEmpty else { return [] }

    // Calculate median text height for a data-driven threshold
    let heights = blocks.map { $0.rect.size.height }.sorted()
    let medianHeight = heights[heights.count / 2]

    // Threshold: 50% of median height, clamped to [0.005, 0.012]
    // This is conservative — receipt lines are typically spaced 1.5-2x the text height apart,
    // while text blocks on the SAME line vary by < 0.3x the text height.
    let threshold = min(max(medianHeight * 0.5, 0.005), 0.012)

    NSLog("[VisionKitReceiptScanner] Line grouping: medianHeight=\(String(format: "%.4f", medianHeight)) threshold=\(String(format: "%.4f", threshold))")

    // Sort by Y descending (top of receipt first, since Vision Y=1 is top)
    let sorted = blocks.sorted { $0.centerY > $1.centerY }

    var lines: [ReceiptLine] = []
    var currentGroup: [TextBlock] = [sorted[0]]
    var anchorY = sorted[0].centerY // Use first block as anchor, not running average

    for i in 1..<sorted.count {
      let block = sorted[i]
      let yDiff = abs(block.centerY - anchorY)

      if yDiff <= threshold {
        // Same line — add to group
        currentGroup.append(block)
      } else {
        // New line — save current group and start new one
        lines.append(makeReceiptLine(from: currentGroup))
        currentGroup = [block]
        anchorY = block.centerY
      }
    }
    // Don't forget the last group
    if !currentGroup.isEmpty {
      lines.append(makeReceiptLine(from: currentGroup))
    }

    return lines
  }

  private func makeReceiptLine(from blocks: [TextBlock]) -> ReceiptLine {
    // Sort blocks left to right for the full text
    let sorted = blocks.sorted { $0.rect.origin.x < $1.rect.origin.x }
    let fullText = sorted.map { $0.text.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
    let avgY = sorted.reduce(0.0) { $0 + $1.centerY } / CGFloat(sorted.count)
    return ReceiptLine(blocks: sorted, fullText: fullText, avgY: avgY)
  }

  // MARK: - Price Extraction

  /// Checks if a text block is primarily a price (e.g., "12.44", "3.78 R", "$5.99")
  private static func isPriceBlock(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    // A price block: optional $, digits with one decimal point, optional trailing letter
    let pattern = #"^\$?\s*\d{1,6}\.\d{2}\s*[A-Z]?\s*$"#
    return (try? NSRegularExpression(pattern: pattern, options: .caseInsensitive))
      .flatMap { $0.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) } != nil
  }

  /// Extracts a price (Double) from a text block
  private static func extractPriceFromBlock(_ text: String) -> Double? {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    let pattern = #"\$?\s*(\d{1,6}\.\d{2})"#
    guard let regex = try? NSRegularExpression(pattern: pattern),
          let match = regex.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
          let range = Range(match.range(at: 1), in: trimmed),
          let price = Double(trimmed[range]) else { return nil }
    return price
  }

  /// Extracts any price from a full line of text (fallback)
  private func extractAnyPrice(from text: String) -> Double? {
    // Find all decimal numbers in the text, return the LAST one (most likely the price)
    let pattern = #"\$?\s*(\d{1,6}\.\d{2})"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
    let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))

    // Return the last match (prices are typically at the end)
    if let lastMatch = matches.last,
       let range = Range(lastMatch.range(at: 1), in: text),
       let price = Double(text[range]),
       price > 0 && price < 50000 {
      return price
    }
    return nil
  }

  // MARK: - Item Name Extraction

  /// Extracts a clean item name from the left-side text blocks of a receipt line.
  private func extractItemName(from line: ReceiptLine) -> String {
    let sorted = line.blocks.sorted { $0.rect.origin.x < $1.rect.origin.x }

    // Collect text from left blocks, stopping before price blocks
    var nameParts: [String] = []
    for block in sorted {
      let t = block.text.trimmingCharacters(in: .whitespaces)
      if Self.isPriceBlock(t) { break }

      // Also skip blocks that are pure UPC codes (8+ digits with no letters)
      if isUPCCode(t) { continue }

      // Skip single-letter blocks (tax indicators: F, T, R, N, X)
      if t.count == 1 && t.first?.isLetter == true { continue }

      nameParts.append(t)
    }

    var name = nameParts.joined(separator: " ")

    // Clean up the name
    name = cleanItemName(name)

    return name
  }

  /// Cleans an item name by removing UPC codes, single trailing letters, weight info, etc.
  private func cleanItemName(_ rawName: String) -> String {
    var name = rawName

    // Remove UPC/barcode codes: 8+ consecutive digits
    if let regex = try? NSRegularExpression(pattern: #"\d{8,}"#) {
      name = regex.stringByReplacingMatches(in: name, range: NSRange(name.startIndex..., in: name), withTemplate: "")
    }

    // Remove inline price patterns ($X.XX or X.XX)
    if let regex = try? NSRegularExpression(pattern: #"\$?\s*\d{1,6}\.\d{2}"#) {
      name = regex.stringByReplacingMatches(in: name, range: NSRange(name.startIndex..., in: name), withTemplate: "")
    }

    // Remove weight calculation info (e.g., "1.97 lb. @ 1.00 lb. / 1.53")
    if let regex = try? NSRegularExpression(pattern: #"\d+\.?\d*\s*(?:lb|lbs|oz|kg)\s*\.?\s*@.*"#, options: .caseInsensitive) {
      name = regex.stringByReplacingMatches(in: name, range: NSRange(name.startIndex..., in: name), withTemplate: "")
    }

    // Remove standalone single uppercase letters (tax indicators F, T, R, N, X, etc.)
    // Only at the start or end of the name, or surrounded by spaces
    if let regex = try? NSRegularExpression(pattern: #"\s+[A-Z]\s*$"#) {
      name = regex.stringByReplacingMatches(in: name, range: NSRange(name.startIndex..., in: name), withTemplate: "")
    }
    if let regex = try? NSRegularExpression(pattern: #"^\s*[A-Z]\s+"#) {
      name = regex.stringByReplacingMatches(in: name, range: NSRange(name.startIndex..., in: name), withTemplate: "")
    }

    // Remove leading item/dept codes (5+ digit codes at the start)
    if let regex = try? NSRegularExpression(pattern: #"^\d{5,}\s*"#) {
      name = regex.stringByReplacingMatches(in: name, range: NSRange(name.startIndex..., in: name), withTemplate: "")
    }

    // Clean up
    name = name
      .trimmingCharacters(in: .whitespaces)
      .trimmingCharacters(in: CharacterSet(charactersIn: ".-–—:*#/$@"))
      .trimmingCharacters(in: .whitespaces)

    // Collapse multiple spaces
    while name.contains("  ") {
      name = name.replacingOccurrences(of: "  ", with: " ")
    }

    // Final trailing single letter removal (catches any remaining)
    if name.count > 2 {
      let lastSpace = name.lastIndex(of: " ")
      if let lastSpace = lastSpace {
        let trailing = String(name[name.index(after: lastSpace)...])
        if trailing.count == 1 && trailing.first?.isUppercase == true {
          name = String(name[..<lastSpace]).trimmingCharacters(in: .whitespaces)
        }
      }
    }

    return name
  }

  // MARK: - Line Classification

  private func matchesTotal(_ lower: String) -> Bool {
    guard lower.contains("total") else { return false }
    if lower.contains("subtotal") || lower.contains("sub total") || lower.contains("sub-total") { return false }
    if lower.contains("total purchase") { return false } // Walmart footer
    return true
  }

  private func matchesSubtotal(_ lower: String) -> Bool {
    return lower.contains("subtotal") || lower.contains("sub total") || lower.contains("sub-total")
  }

  private func matchesTax(_ lower: String) -> Bool {
    // "tax", "tax1", "tax2", "tax 6.1000%", "sales tax", etc.
    if lower.hasPrefix("tax") {
      // Make sure it's not "taxi" or "taxidermy"
      let afterTax = String(lower.dropFirst(3))
      if afterTax.isEmpty { return true }
      let firstChar = afterTax.first!
      if firstChar.isNumber || firstChar.isWhitespace || firstChar == ":" { return true }
    }
    if lower.hasSuffix(" tax") { return true }
    if lower.contains("sales tax") || lower.contains("state tax") || lower.contains("local tax") || lower.contains("county tax") { return true }
    if lower.hasPrefix("hst") || lower.hasPrefix("gst") || lower.hasPrefix("vat ") { return true }
    return false
  }

  private func matchesTip(_ lower: String) -> Bool {
    return lower.contains("tip") || lower.contains("gratuity") || lower.contains("service charg")
  }

  /// Lines to skip entirely (payment info, store info, headers, footers)
  private func isSkipLine(_ lower: String) -> Bool {
    let skipPatterns = [
      // Payment
      "change due", "cash tend", "credit tend", "visa tend", "visa", "mastercard",
      "amex", "discover", "debit", "wmp ", "walmart pay",
      // Card info
      "card ending", "card #", "card no", "account #", "appr#", "approval",
      "auth code", "ref #", "ref:",
      // Footer
      "thank you", "thanks", "receipt", "invoice", "transaction",
      "total purchase",
      // Store info
      "store #", "store:", "register", "cashier", "mgr.",
      "supercenter", "supermarket",
      // Savings/loyalty
      "you saved", "your savings", "member", "loyalty", "rewards", "points",
      // Returns
      "refund", "return", "exchange", "coupon", "discount", "promo",
      // Item count headers
      "# items", "items sold", "item count",
      // Misc
      "survey", "feedback", "www.", "http", ".com",
      // Transaction IDs
      "tc#", "te#", "tr#", "op#", "st#",
      // Free delivery ads
      "free delivery", "walmart+",
    ]

    for pattern in skipPatterns {
      if lower.contains(pattern) { return true }
    }

    // Skip lines that look like phone numbers (3-3-4 or 3-7 digit patterns)
    if let _ = try? NSRegularExpression(pattern: #"^\(?\d{3}\)?[\s\-\.]\d{3}[\s\-\.]\d{4}$"#)
      .firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)) {
      return true
    }

    return false
  }

  /// Checks if a line looks like an address (contains state/zip pattern)
  private func isAddressLine(_ lower: String) -> Bool {
    // State abbreviation + zip code pattern: "MO 64468", "CA 90210"
    if let _ = try? NSRegularExpression(pattern: #"\b[A-Z]{2}\s+\d{5}\b"#, options: .caseInsensitive)
      .firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)) {
      return true
    }
    // Street patterns
    if lower.contains(" st ") || lower.contains(" ave ") || lower.contains(" blvd ") ||
       lower.contains(" rd ") || lower.contains(" dr ") || lower.hasSuffix(" st") {
      return true
    }
    return false
  }

  /// Checks if text is a UPC/barcode code (8+ digits, possibly with spaces)
  private func isUPCCode(_ text: String) -> Bool {
    let digitsOnly = text.filter { $0.isNumber }
    let nonDigits = text.filter { !$0.isNumber && !$0.isWhitespace }
    return digitsOnly.count >= 8 && nonDigits.count <= 1
  }

  /// Checks if a line is a weight/calculation line (e.g., "1.97 lb. @ 1.00 lb.")
  private func isWeightLine(_ lower: String) -> Bool {
    return lower.contains(" lb") && lower.contains("@") ||
           lower.contains(" oz") && lower.contains("@") ||
           lower.contains(" kg") && lower.contains("@")
  }

  // MARK: - Merchant Name (Spatial - uses text height)

  /// Finds the merchant name by looking for the TALLEST text near the top of the receipt.
  /// Store names are typically printed in large, bold letters.
  private func extractMerchantNameSpatial(from blocks: [TextBlock]) -> String? {
    // Consider only the top 40% of the receipt
    let topBlocks = blocks.filter { $0.centerY > 0.6 } // Y > 0.6 means top 40% (Vision coords)

    guard !topBlocks.isEmpty else {
      // Fallback: just use top text
      return extractMerchantNameFallback(from: blocks)
    }

    // Find the block with the largest height (biggest text = store name)
    // Filter out very short text (< 3 chars) and numeric-only text
    let candidates = topBlocks.filter { block in
      let text = block.text.trimmingCharacters(in: .whitespaces)
      let letterCount = text.filter { $0.isLetter }.count
      return text.count >= 3 && letterCount >= 2
    }

    // Sort by height descending — largest text first
    let sortedByHeight = candidates.sorted { $0.rect.size.height > $1.rect.size.height }

    for block in sortedByHeight {
      let text = block.text.trimmingCharacters(in: .whitespaces)
      let lower = text.lowercased()

      // Skip lines that are clearly not store names
      if lower.contains("receipt") || lower.contains("invoice") || lower.contains("feedback") ||
         lower.contains("survey") || lower.contains("www.") || lower.contains(".com") ||
         lower.contains("thank") || lower.contains("id #") || lower.contains("id#") { continue }

      // This is likely the store name!
      NSLog("[VisionKitReceiptScanner] 🏪 Merchant detected: \"\(text)\" (height=\(String(format: "%.4f", block.rect.size.height)))")
      return String(text.prefix(60))
    }

    return extractMerchantNameFallback(from: blocks)
  }

  private func extractMerchantNameFallback(from blocks: [TextBlock]) -> String? {
    let sorted = blocks.sorted { $0.centerY > $1.centerY }
    for block in sorted.prefix(5) {
      let text = block.text.trimmingCharacters(in: .whitespaces)
      let lower = text.lowercased()
      if text.count >= 3 && text.filter({ $0.isLetter }).count >= 2 {
        if !lower.contains("receipt") && !lower.contains("feedback") && !lower.contains("survey") &&
           !lower.contains(".com") && !lower.contains("thank") && !lower.contains("id #") {
          return String(text.prefix(60))
        }
      }
    }
    return nil
  }

  // MARK: - Date Extraction

  private func extractDateFromBlocks(_ blocks: [TextBlock]) -> String? {
    let datePatterns = [
      try! NSRegularExpression(pattern: #"(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})"#),
      try! NSRegularExpression(pattern: #"(\w{3,9}\s+\d{1,2},?\s+\d{4})"#, options: .caseInsensitive),
      try! NSRegularExpression(pattern: #"(\d{4}[/\-]\d{2}[/\-]\d{2})"#),
    ]

    for block in blocks {
      let text = block.text
      let range = NSRange(text.startIndex..., in: text)
      for pattern in datePatterns {
        if let match = pattern.firstMatch(in: text, range: range),
           let dateRange = Range(match.range(at: 1), in: text) {
          return String(text[dateRange])
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
