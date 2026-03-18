import Foundation
import UIKit
import VisionKit
import Vision
internal import React

/// VisionKit Receipt Scanner — v4: Row Reconstruction + Price Association
///
/// This parser reconstructs rows from OCR bounding boxes, then:
/// 1. Extracts right-column prices per row
/// 2. Merges multiline item text with nearby priced rows
/// 3. Classifies summary lines (subtotal/tax/tip/total)
/// 4. Filters payment/footer noise
/// 5. Self-heals against subtotal and expected item count
///
@objc(VisionKitReceiptScanner)
class VisionKitReceiptScanner: RCTEventEmitter, VNDocumentCameraViewControllerDelegate {

  private var scanResolve: RCTPromiseResolveBlock?
  private var scanReject: RCTPromiseRejectBlock?

  // MARK: - RCTEventEmitter

  override static func requiresMainQueueSetup() -> Bool { true }
  override func supportedEvents() -> [String]! { ["onScanProgress"] }

  // MARK: - Public API

  @objc func isAvailable(_ resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    if #available(iOS 13.0, *) { resolve(VNDocumentCameraViewController.isSupported) }
    else { resolve(false) }
  }

  @objc func scanDocument(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 13.0, *), VNDocumentCameraViewController.isSupported else {
      reject("UNSUPPORTED", "VisionKit not supported.", nil); return
    }
    self.scanResolve = resolve
    self.scanReject = reject

    DispatchQueue.main.async { [weak self] in
      let vc = VNDocumentCameraViewController()
      vc.delegate = self
      vc.modalPresentationStyle = .fullScreen
      guard let root = self?.topViewController() else {
        reject("NO_VC", "No view controller.", nil)
        self?.scanResolve = nil; self?.scanReject = nil; return
      }
      root.present(vc, animated: true)
    }
  }

  // MARK: - Delegate

  @available(iOS 13.0, *)
  func documentCameraViewController(_ c: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
    c.dismiss(animated: true) { [weak self] in self?.processScannedDocument(scan) }
  }
  @available(iOS 13.0, *)
  func documentCameraViewController(_ c: VNDocumentCameraViewController, didFailWithError error: Error) {
    c.dismiss(animated: true) { [weak self] in
      self?.scanReject?("SCAN_FAILED", error.localizedDescription, error)
      self?.scanResolve = nil; self?.scanReject = nil
    }
  }
  @available(iOS 13.0, *)
  func documentCameraViewControllerDidCancel(_ c: VNDocumentCameraViewController) {
    c.dismiss(animated: true) { [weak self] in
      self?.scanResolve?(["cancelled": true])
      self?.scanResolve = nil; self?.scanReject = nil
    }
  }

  // MARK: - OCR

  @available(iOS 13.0, *)
  private func processScannedDocument(_ scan: VNDocumentCameraScan) {
    DispatchQueue.main.async { [weak self] in
      self?.sendEvent(withName: "onScanProgress", body: ["status": "processing", "message": "Processing scanned document..."])
    }
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self = self else { return }
      var allObs: [(String, CGRect)] = []
      var savedUri: String?

      for p in 0..<scan.pageCount {
        let img = scan.imageOfPage(at: p)
        if p == 0 { savedUri = self.saveImageToTemp(img) }
        guard let cg = img.cgImage else { continue }
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.recognitionLanguages = ["en-US"]
        if #available(iOS 16.0, *) {
          req.automaticallyDetectsLanguage = true
        }
        req.usesLanguageCorrection = false
        req.minimumTextHeight = 0.006
        do {
          try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
          for obs in (req.results ?? []) {
            if let text = self.pickBestTextCandidate(obs) {
              allObs.append((text, obs.boundingBox))
            }
          }
        } catch {}
      }

      NSLog("[VK] \(allObs.count) observations")

      DispatchQueue.main.async { [weak self] in
        self?.sendEvent(withName: "onScanProgress", body: ["status": "parsing", "message": "Extracting receipt items...", "textLinesFound": allObs.count])
      }

      let result = self.parseReceipt(allObs)
      NSLog("[VK] Final: \(result.items.count) items, tax=\(result.tax ?? -1), total=\(result.total ?? -1)")

      DispatchQueue.main.async {
        var dict: [String: Any] = [
          "cancelled": false,
          "rawText": allObs.map { $0.0 }.joined(separator: "\n"),
          "items": result.items.map { ["name": $0.name, "price": $0.price, "quantity": $0.quantity, "confidence": $0.confidence] },
          "subtotal": result.subtotal ?? NSNull(),
          "tax": result.tax ?? NSNull(),
          "tip": result.tip ?? NSNull(),
          "total": result.total ?? NSNull(),
          "merchantName": result.merchantName ?? NSNull(),
          "date": result.date ?? NSNull(),
          "parserTelemetry": result.telemetry
        ]
        if let u = savedUri { dict["imageUri"] = u }
        self.sendEvent(withName: "onScanProgress", body: ["status": "complete", "message": "Receipt scanned!", "itemCount": result.items.count])
        self.scanResolve?(dict)
        self.scanResolve = nil; self.scanReject = nil
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MARK: - Data Structures
  // ════════════════════════════════════════════════════════════════════════════

  private struct Blk {
    let text: String
    let rect: CGRect
    let idx: Int
    var cy: CGFloat { rect.midY }
    var cx: CGFloat { rect.midX }
    var le: CGFloat { rect.minX }
    var re: CGFloat { rect.maxX }
    var h: CGFloat  { rect.height }
    var topY: CGFloat { rect.maxY }   // Vision coords: maxY = highest
    var botY: CGFloat { rect.minY }
  }

  private struct RItem {
    let name: String
    let price: Double
    let quantity: Int
    let confidence: Double
  }

  private struct Parsed {
    var items: [RItem] = []
    var subtotal: Double?
    var tax: Double?
    var tip: Double?
    var total: Double?
    var merchantName: String?
    var date: String?
    var telemetry: [String] = []
  }

  /// A matched (name, price) from spatial association
  private struct PricedEntry {
    let nameText: String
    let price: Double
    let y: CGFloat
    let isInline: Bool // was the price inside the same observation as the name?
  }

  private struct ReceiptRow {
    let blocks: [Blk]
    let text: String
    let y: CGFloat
    let topY: CGFloat
    let botY: CGFloat
    let leftX: CGFloat
    let rightX: CGFloat
  }

  private struct RowPrice {
    let value: Double
    let priceBlock: Blk?
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MARK: - v4 Main Pipeline: Row Reconstruction
  // ════════════════════════════════════════════════════════════════════════════

  private func parseReceipt(_ obs: [(String, CGRect)]) -> Parsed {
    var receipt = Parsed()
    let blocks = obs.enumerated().map { Blk(text: $0.1.0, rect: $0.1.1, idx: $0.0) }
    guard !blocks.isEmpty else { return receipt }

    let rows = buildRows(blocks)
    receipt.merchantName = extractMerchant(rows)
    receipt.date = extractDate(blocks)
    var telemetry: [String] = []
    telemetry.append("rows=\(rows.count), observations=\(blocks.count)")
    if let merchant = receipt.merchantName { telemetry.append("merchant=\(merchant)") }
    if let date = receipt.date { telemetry.append("date=\(date)") }

    var expectedItemCount: Int? = nil
    var summaryStarted = false
    var pendingNameParts: [String] = []

    var i = 0
    while i < rows.count {
      let row = rows[i]
      let lower = row.text.lowercased().trimmingCharacters(in: .whitespaces)
      telemetry.append("row[\(i)] text=\(row.text)")

      if let ic = parseItemCount(lower) {
        expectedItemCount = ic
        telemetry.append("row[\(i)] itemCountHint=\(ic)")
      }

      let rowPrice = extractRowPrice(row)
      if let rp = rowPrice {
        telemetry.append("row[\(i)] price=\(f2(rp.value))")
        // Summary values (tax, subtotal, total, tip)
        if matchSubtotal(lower) {
          receipt.subtotal = rp.value
          summaryStarted = true
          pendingNameParts.removeAll()
          telemetry.append("row[\(i)] classified=subtotal")
          i += 1
          continue
        }
        if matchTax(lower) {
          receipt.tax = (receipt.tax ?? 0) + rp.value
          summaryStarted = true
          pendingNameParts.removeAll()
          telemetry.append("row[\(i)] classified=tax")
          i += 1
          continue
        }
        if matchTip(lower) {
          receipt.tip = rp.value
          summaryStarted = true
          pendingNameParts.removeAll()
          telemetry.append("row[\(i)] classified=tip")
          i += 1
          continue
        }
        if matchTotal(lower) {
          if receipt.total == nil || lower.contains("grand total") {
            receipt.total = rp.value
          }
          summaryStarted = true
          pendingNameParts.removeAll()
          telemetry.append("row[\(i)] classified=total")
          i += 1
          continue
        }

        // Some receipts place "tax" and amount in separate rows.
        if matchTax(lower), receipt.tax == nil {
          receipt.tax = rp.value
          summaryStarted = true
          telemetry.append("row[\(i)] classified=tax_fallback")
          i += 1
          continue
        }

        if isPaymentOrFooter(lower) || isHeaderOrStore(lower) || isAddress(lower) {
          telemetry.append("row[\(i)] classified=ignored_footer_or_header")
          i += 1
          continue
        }

        // Ignore obvious non-item rows after summary section starts.
        if summaryStarted && (isPaymentOrFooter(lower) || regMatch(lower, #"authorization|approval|transaction|account"#, ci: true)) {
          telemetry.append("row[\(i)] classified=ignored_post_summary")
          i += 1
          continue
        }

        var itemName = extractItemName(row, price: rp)
        let pending = pendingNameParts.joined(separator: " ").trimmingCharacters(in: .whitespaces)

        // For multiline receipts, prepend pending continuation when helpful.
        if !pending.isEmpty {
          if itemName.isEmpty || isWeakItemName(itemName) || row.text.lowercased().contains("@") {
            itemName = cleanItemName("\(pending) \(itemName)")
            telemetry.append("row[\(i)] mergedPending=\(pending)")
          }
        }

        if isValidItemName(itemName) {
          let qty = inferQuantity(from: row.text)
          let conf = confidenceScore(itemName, rp.value)
          receipt.items.append(RItem(name: itemName, price: rp.value, quantity: max(1, qty), confidence: conf))
          pendingNameParts.removeAll()
          telemetry.append("row[\(i)] classified=item name=\(itemName) qty=\(qty) conf=\(f2(conf))")
          NSLog("[VK] ✅ Item: \"\(itemName)\" $\(f2(rp.value))")
        } else {
          telemetry.append("row[\(i)] classified=discarded_invalid_item")
        }

        i += 1
        continue
      }

      // No row price: can be multiline continuation, store/address, or footer.
      if isLikelyContinuationRow(lower) {
        let cleaned = cleanItemName(row.text)
        if cleaned.count >= 2 {
          pendingNameParts.append(cleaned)
          telemetry.append("row[\(i)] continuation=\(cleaned)")
          if pendingNameParts.count > 3 {
            pendingNameParts.removeFirst()
          }
        }
      } else {
        telemetry.append("row[\(i)] classified=ignored_no_price")
      }

      i += 1
    }

    // Fallback summary extraction from rows when keyword and amount are split.
    if receipt.tax == nil || receipt.subtotal == nil || receipt.total == nil {
      fillMissingSummaryValues(from: rows, into: &receipt)
      telemetry.append("summaryFallbackApplied=true")
    }

    receipt = selfHeal(receipt, expectedCount: expectedItemCount)
    telemetry.append("result items=\(receipt.items.count) subtotal=\(receipt.subtotal.map { f2($0) } ?? "nil") tax=\(receipt.tax.map { f2($0) } ?? "nil") total=\(receipt.total.map { f2($0) } ?? "nil")")
    receipt.telemetry = Array(telemetry.suffix(220))
    return receipt
  }

  private func buildRows(_ blocks: [Blk]) -> [ReceiptRow] {
    if blocks.isEmpty { return [] }

    struct MutableRow {
      var blocks: [Blk]
      var y: CGFloat
      var topY: CGFloat
      var botY: CGFloat
    }

    var rows: [MutableRow] = []
    let sorted = blocks.sorted { $0.cy > $1.cy }

    for b in sorted {
      let tol = max(0.012, min(0.035, b.h * 1.6))
      if let idx = rows.firstIndex(where: { abs($0.y - b.cy) <= tol }) {
        rows[idx].blocks.append(b)
        let count = CGFloat(rows[idx].blocks.count)
        rows[idx].y = ((rows[idx].y * (count - 1)) + b.cy) / count
        rows[idx].topY = max(rows[idx].topY, b.topY)
        rows[idx].botY = min(rows[idx].botY, b.botY)
      } else {
        rows.append(MutableRow(blocks: [b], y: b.cy, topY: b.topY, botY: b.botY))
      }
    }

    return rows
      .map { row in
        let lineBlocks = row.blocks.sorted { $0.le < $1.le }
        let text = lineBlocks
          .map { $0.text.trimmingCharacters(in: .whitespaces) }
          .filter { !$0.isEmpty }
          .joined(separator: " ")
        let leftX = lineBlocks.first?.le ?? 0
        let rightX = lineBlocks.last?.re ?? 0
        return ReceiptRow(blocks: lineBlocks, text: text, y: row.y, topY: row.topY, botY: row.botY, leftX: leftX, rightX: rightX)
      }
      .filter { !$0.text.isEmpty }
      .sorted { $0.y > $1.y }
  }

  private func extractRowPrice(_ row: ReceiptRow) -> RowPrice? {
    // Prefer right-most standalone price block.
    for b in row.blocks.sorted(by: { $0.le > $1.le }) {
      if isStandalonePrice(b.text), let value = parsePrice(b.text), value > 0, value < 50000 {
        return RowPrice(value: value, priceBlock: b)
      }
    }

    // Fallback: right-most inline decimal amount from full row text.
    guard let m = regLast(row.text, #"\$?\s*(\d{1,6}\.\d{2})\s*[A-Z]?\s*$"#, group: 1),
          let value = Double(m), value > 0, value < 50000 else {
      return nil
    }
    return RowPrice(value: value, priceBlock: nil)
  }

  private func extractItemName(_ row: ReceiptRow, price: RowPrice) -> String {
    var raw = row.text
    if let pb = price.priceBlock {
      let leftBlocks = row.blocks.filter { $0.re <= pb.le + 0.01 }.sorted { $0.le < $1.le }
      let leftText = leftBlocks.map { $0.text.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
      if !leftText.isEmpty {
        raw = leftText
      }
    }

    raw = regReplace(raw, #"\$?\s*\d{1,6}\.\d{2}\s*[A-Z]?\s*$"#, "")
    let cleaned = cleanItemName(raw)
    return cleaned
  }

  private func isWeakItemName(_ name: String) -> Bool {
    let trimmed = name.trimmingCharacters(in: .whitespaces)
    if trimmed.count < 4 { return true }
    let letterCount = trimmed.filter { $0.isLetter }.count
    let digitCount = trimmed.filter { $0.isNumber }.count
    if letterCount < 2 { return true }
    return digitCount > letterCount
  }

  private func isValidItemName(_ name: String) -> Bool {
    let n = name.trimmingCharacters(in: .whitespaces)
    if n.count < 2 { return false }
    let l = n.lowercased()
    if matchSubtotal(l) || matchTax(l) || matchTip(l) || matchTotal(l) { return false }
    if isPaymentOrFooter(l) || isHeaderOrStore(l) || isAddress(l) { return false }
    let letterCount = n.filter { $0.isLetter }.count
    if letterCount < 2 { return false }
    return true
  }

  private func isLikelyContinuationRow(_ lower: String) -> Bool {
    if lower.count < 2 { return false }
    if regMatch(lower, #"\$?\s*\d{1,6}\.\d{2}"#) { return false }
    if isPaymentOrFooter(lower) || isHeaderOrStore(lower) || isAddress(lower) { return false }
    if matchSubtotal(lower) || matchTax(lower) || matchTip(lower) || matchTotal(lower) { return false }
    if regMatch(lower, #"\b(date|time|station|invoice|order|auth|approval|trace)\b"#, ci: true) { return false }
    let letters = lower.filter { $0.isLetter }.count
    return letters >= 2
  }

  private func inferQuantity(from rowText: String) -> Int {
    let text = rowText.trimmingCharacters(in: .whitespaces)
    if let m = regFirst(text, #"^(\d{1,2})\s*[xX]\b"#, group: 1), let q = Int(m), q > 0, q < 50 {
      return q
    }
    if let m = regFirst(text, #"^(\d{1,2})\s+"#, group: 1), let q = Int(m), q > 0, q < 50 {
      return q
    }
    return 1
  }

  private func fillMissingSummaryValues(from rows: [ReceiptRow], into receipt: inout Parsed) {
    for idx in rows.indices {
      let row = rows[idx]
      let lower = row.text.lowercased().trimmingCharacters(in: .whitespaces)

      if let rp = extractRowPrice(row) {
        if receipt.subtotal == nil && matchSubtotal(lower) { receipt.subtotal = rp.value }
        if matchTax(lower) { receipt.tax = (receipt.tax ?? 0) + rp.value }
        if receipt.tip == nil && matchTip(lower) { receipt.tip = rp.value }
        if receipt.total == nil && matchTotal(lower) { receipt.total = rp.value }
        continue
      }

      // Handle split label/value rows: "Tax" then next row has amount.
      if idx + 1 < rows.count, let nextPrice = extractRowPrice(rows[idx + 1]) {
        if receipt.subtotal == nil && matchSubtotal(lower) { receipt.subtotal = nextPrice.value }
        if matchTax(lower) { receipt.tax = (receipt.tax ?? 0) + nextPrice.value }
        if receipt.tip == nil && matchTip(lower) { receipt.tip = nextPrice.value }
        if receipt.total == nil && matchTotal(lower) { receipt.total = nextPrice.value }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MARK: - Price Detection
  // ════════════════════════════════════════════════════════════════════════════

  /// Returns true if this text block is PURELY a price value.
  /// e.g., "$17.99", "5.98", "12.44 R", "$2.28"
  private func isStandalonePrice(_ text: String) -> Bool {
    let t = text.trimmingCharacters(in: .whitespaces)
    // Patterns: "$17.99", "17.99", "5.98 R", "$100.11", "-$2.00", "- 2.00"
    let pattern = #"^-?\s*\$?\s*\d{1,6}\.\d{2}\s*[A-Z]?\s*$"#
    return regMatch(t, pattern)
  }

  /// Parses a price from text. Returns the first decimal number found.
  private func parsePrice(_ text: String) -> Double? {
    let t = text.trimmingCharacters(in: .whitespaces)
    let pattern = #"-?\s*\$?\s*(\d{1,6}\.\d{2})"#
    guard let match = regFirst(t, pattern, group: 1), let val = Double(match) else { return nil }
    if t.contains("-") { return -val }
    return val
  }

  /// Extracts an inline price from the END of a text string.
  /// e.g., "FS LAXMI URAD GOTA 8LB* $17.99" → 17.99
  private func extractInlinePrice(_ text: String) -> Double? {
    // Match price at end: capture just the number
    let pattern = #"\$?\s*(\d{1,6}\.\d{2})\s*[A-Z]?\s*$"#
    guard let match = regFirst(text, pattern, group: 1), let val = Double(match) else { return nil }
    return val
  }

  /// Extracts the name portion BEFORE an inline price.
  /// e.g., "FS LAXMI URAD GOTA 8LB* $17.99" → "FS LAXMI URAD GOTA 8LB*"
  private func extractNameBeforePrice(_ text: String) -> String {
    let pattern = #"^(.*?)\s*\$?\s*\d{1,6}\.\d{2}\s*[A-Z]?\s*$"#
    if let name = regFirst(text, pattern, group: 1) {
      return name.trimmingCharacters(in: .whitespaces)
    }
    return text
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MARK: - Item Name Cleaning
  // ════════════════════════════════════════════════════════════════════════════

  private func cleanItemName(_ raw: String) -> String {
    var n = raw.trimmingCharacters(in: .whitespaces)

    // Remove leading item number: "1 FS LAXMI..." → "FS LAXMI..."
    // Match: starts with 1-2 digit number followed by space
    n = regReplace(n, #"^\d{1,2}\s+"#, "")

    // Remove UPC codes (8+ digits)
    n = regReplace(n, #"\d{8,}"#, "")

    // Remove inline prices
    n = regReplace(n, #"\$?\s*\d{1,6}\.\d{2}"#, "")

    // Remove weight calculations (1.97 lb. @ ...)
    n = regReplace(n, #"\d+\.?\d*\s*(?:lb|lbs|oz|kg)\s*\.?\s*@.*"#, "", ci: true)

    // Remove per-unit prices (@$X.XX/lb)
    n = regReplace(n, #"@\s*\$?\d+\.\d+\s*/\s*\w+"#, "", ci: true)

    // Remove trailing single uppercase letter (tax indicator: F, R, T, N, X)
    n = regReplace(n, #"\s+[A-Z]\s*$"#, "")

    // Remove leading single uppercase letter
    n = regReplace(n, #"^[A-Z]\s{2,}"#, "")

    // Remove trailing asterisks
    n = regReplace(n, #"\*+\s*$"#, "")

    // Remove leading dept codes (5+ digits)
    n = regReplace(n, #"^\d{5,}\s*"#, "")

    // Trim junk chars
    n = n.trimmingCharacters(in: .whitespaces)
      .trimmingCharacters(in: CharacterSet(charactersIn: ".-–—:*#/$@,;()"))
      .trimmingCharacters(in: .whitespaces)

    // Collapse multiple spaces
    while n.contains("  ") { n = n.replacingOccurrences(of: "  ", with: " ") }

    // Final trailing single letter
    if n.count > 2, let sp = n.lastIndex(of: " ") {
      let tail = String(n[n.index(after: sp)...])
      if tail.count == 1, tail.first?.isUppercase == true {
        n = String(n[..<sp]).trimmingCharacters(in: .whitespaces)
      }
    }

    return n
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MARK: - Line Classification
  // ════════════════════════════════════════════════════════════════════════════

  private func matchTotal(_ l: String) -> Bool {
    if l.contains("grand total") { return true }
    guard l.contains("total") else { return false }
    if l.contains("subtotal") || l.contains("sub total") || l.contains("sub-total") { return false }
    if l.contains("total purchase") || l.contains("total savings") || l.contains("total bonus") { return false }
    if l.contains("total earned") || l.contains("total points") { return false }
    return true
  }

  private func matchSubtotal(_ l: String) -> Bool {
    l.contains("subtotal") || l.contains("sub total") || l.contains("sub-total")
  }

  private func matchTax(_ l: String) -> Bool {
    if l.hasPrefix("tax") {
      let rest = String(l.dropFirst(3))
      if rest.isEmpty || rest.first!.isNumber || rest.first!.isWhitespace || rest.first! == ":" { return true }
    }
    if l.hasSuffix(" tax") || l.hasSuffix(" tax:") { return true }
    let taxKeywords = ["sales tax", "state tax", "local tax", "county tax", "city tax", "hst", "gst", "vat "]
    for k in taxKeywords { if l.contains(k) { return true } }
    return false
  }

  private func matchTip(_ l: String) -> Bool {
    l.contains("tip") || l.contains("gratuity") || l.contains("service charg")
  }

  private func isPaymentOrFooter(_ l: String) -> Bool {
    let p = [
      // Payment
      "change due", "cash tend", "credit tend", "visa tend", "visa", "mastercard", "amex",
      "discover", "debit card", "debit", "credit card", "wmp ", "walmart pay",
      "apple pay", "google pay", "paypal",
      // Just "credit" (standalone) — catches "Credit $102.96" lines
      "credit",
      // Card details
      "card ending", "card #", "card no", "card type", "card entry", "xxxx",
      "account #", "acct#", "acct #", "appr#", "approval", "auth code",
      "ref num", "ref #", "ref:", "aid:", "tc:", "tvr:", "tsi:",
      "trace", "app label",
      // Footer
      "thank you", "thanks for", "come again", "have a nice",
      "total purchase", "total savings", "total bonus", "bonus points",
      // Receipt metadata
      "transaction", "receipt", "invoice:",
      // Ops
      "register", "cashier", "clerk", "server:", "host:", "table:",
      // Loyalty
      "you saved", "your savings", "loyalty", "rewards", "points earned",
      "club card", "plus card",
      // Returns & promos
      "refund", "exchange", "coupon", "promo code",
      // Walmart
      "# items sold", "items sold", "item count",
      // Ads & web
      "free delivery", "download", "app today",
      "survey", "feedback", "www.", "http", ".com", ".org", ".net",
      // ID patterns
      "tc acc", "tc#",
      // Misc
      "no refund", "exchange", "cooler", "frozen",
      "redemption",
    ]
    for k in p { if l.contains(k) { return true } }
    // Phone number
    if regMatch(l, #"\(?\d{3}\)?[\s\-\.]\d{3}[\s\-\.]\d{4}"#) { return true }
    return false
  }

  private func isHeaderOrStore(_ l: String) -> Bool {
    let p = [
      "supercenter", "supermarket", "grocery", "one stop shop",
      "mgr.", "manager",
      "st#", "op#", "te#", "tr#",
      "date/time", "date:", "station:", "station ",
      "closed to", "order #", "order:", "invoice #",
    ]
    for k in p { if l.contains(k) { return true } }
    return false
  }

  private func isAddress(_ l: String) -> Bool {
    if regMatch(l, #"\b[A-Z]{2}\s+\d{5}\b"#, ci: true) { return true }
    let st = [" st ", " ave ", " blvd ", " rd ", " dr ", " ln ", " pkwy ", " hwy ", " way ", " street"]
    for k in st { if l.contains(k) || l.hasSuffix(k.trimmingCharacters(in: .whitespaces)) { return true } }
    return false
  }

  private func isWeightLine(_ l: String) -> Bool {
    (l.contains("lb") || l.contains("oz") || l.contains("kg")) && l.contains("@")
  }

  /// Parses "Item Count: 18" or "# ITEMS SOLD 4" or "Item Count 18"
  private func parseItemCount(_ l: String) -> Int? {
    if let m = regFirst(l, #"item\s*count\s*:?\s*(\d+)"#, group: 1, ci: true), let n = Int(m) { return n }
    if let m = regFirst(l, #"#?\s*items?\s*sold\s*:?\s*(\d+)"#, group: 1, ci: true), let n = Int(m) { return n }
    return nil
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MARK: - Confidence Scoring
  // ════════════════════════════════════════════════════════════════════════════

  private func confidenceScore(_ name: String, _ price: Double) -> Double {
    var s = 0.7
    if name.count >= 3 { s += 0.05 }
    if name.count >= 5 { s += 0.05 }
    let lr = Double(name.filter { $0.isLetter }.count) / Double(max(1, name.count))
    if lr > 0.6 { s += 0.05 }
    if lr > 0.8 { s += 0.05 }
    if price >= 0.50 && price <= 200 { s += 0.05 }
    let dr = Double(name.filter { $0.isNumber }.count) / Double(max(1, name.count))
    if dr > 0.3 { s -= 0.15 }
    if name.count < 3 { s -= 0.2 }
    return min(max(s, 0.1), 1.0)
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MARK: - Self-Healing Validation
  // ════════════════════════════════════════════════════════════════════════════

  private func selfHeal(_ r: Parsed, expectedCount: Int?) -> Parsed {
    var receipt = r

    let itemSum = receipt.items.reduce(0.0) { $0 + $1.price * Double($1.quantity) }

    // Validate against subtotal
    if let sub = receipt.subtotal {
      let diff = abs(itemSum - sub)
      if diff > max(0.05, sub * 0.01) {
        NSLog("[VK] ⚠️ Items=$\(f2(itemSum)) ≠ subtotal=$\(f2(sub)), Δ=$\(f2(diff))")
        // If over, remove low-confidence items matching the overage
        if itemSum > sub + 0.50 {
          let over = itemSum - sub
          if let idx = receipt.items.firstIndex(where: {
            $0.confidence < 0.6 && abs($0.price - over) < 0.05
          }) {
            NSLog("[VK] 🔧 Removing: \"\(receipt.items[idx].name)\" $\(receipt.items[idx].price)")
            receipt.items.remove(at: idx)
          }
        }
      } else {
        NSLog("[VK] ✅ Items match subtotal: $\(f2(itemSum)) ≈ $\(f2(sub))")
      }
    }

    // Validate item count
    if let expected = expectedCount, receipt.items.count != expected {
      NSLog("[VK] ⚠️ Expected \(expected) items, got \(receipt.items.count)")
    }

    // Compute total if missing
    if receipt.total == nil {
      let newSum = receipt.items.reduce(0.0) { $0 + $1.price * Double($1.quantity) }
      receipt.total = newSum + (receipt.tax ?? 0) + (receipt.tip ?? 0)
    }

    return receipt
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MARK: - Merchant & Date
  // ════════════════════════════════════════════════════════════════════════════

  private func extractMerchant(_ blocks: [Blk]) -> String? {
    let rows = buildRows(blocks)
    return extractMerchant(rows)
  }

  private func extractMerchant(_ rows: [ReceiptRow]) -> String? {
    let candidates = rows
      .filter { $0.y > 0.55 }
      .prefix(12)

    var best: (name: String, score: Double)? = nil
    for row in candidates {
      let t = row.text.trimmingCharacters(in: .whitespaces)
      if t.count < 3 { continue }
      let l = t.lowercased()
      if l.contains("feedback") || l.contains("survey") || l.contains(".com") ||
         l.contains("thank") || l.contains("id #") || l.contains("receipt") ||
         l.contains("invoice") || l.contains("store #") || l.contains("st#") {
        continue
      }
      if isAddress(l) { continue }
      if regMatch(l, #"\d{3}[\-\.]\d{3}[\-\.]\d{4}"#) { continue }

      let chars = max(1, t.count)
      let letters = t.filter { $0.isLetter }.count
      let digits = t.filter { $0.isNumber }.count
      let upper = t.filter { $0.isUppercase }.count
      let letterRatio = Double(letters) / Double(chars)
      let digitRatio = Double(digits) / Double(chars)
      let upperRatio = Double(upper) / Double(max(1, letters))

      var score = 0.0
      score += Double(row.topY) * 1.8
      score += letterRatio * 1.2
      score += upperRatio * 0.8
      score -= digitRatio * 1.0
      score -= Double(abs(0.5 - row.leftX)) * 0.1

      if best == nil || score > best!.score {
        best = (String(t.prefix(60)), score)
      }
    }
    return best?.name
  }

  private func extractDate(_ blocks: [Blk]) -> String? {
    let patterns = [
      try! NSRegularExpression(pattern: #"(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})"#),
      try! NSRegularExpression(pattern: #"(\w{3,9}\s+\d{1,2},?\s+\d{4})"#, options: .caseInsensitive),
      try! NSRegularExpression(pattern: #"(\d{4}[/\-]\d{2}[/\-]\d{2})"#),
    ]
    for b in blocks {
      let text = b.text
      let r = NSRange(text.startIndex..., in: text)
      for p in patterns {
        if let m = p.firstMatch(in: text, range: r), let dr = Range(m.range(at: 1), in: text) {
          return String(text[dr])
        }
      }
    }
    return nil
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MARK: - Regex Utilities
  // ════════════════════════════════════════════════════════════════════════════

  private func regMatch(_ s: String, _ p: String, ci: Bool = false) -> Bool {
    guard let rx = try? NSRegularExpression(pattern: p, options: ci ? [.caseInsensitive] : []) else { return false }
    return rx.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
  }

  private func regFirst(_ s: String, _ p: String, group: Int = 0, ci: Bool = false) -> String? {
    guard let rx = try? NSRegularExpression(pattern: p, options: ci ? [.caseInsensitive] : []),
          let m = rx.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
          let r = Range(m.range(at: group), in: s) else { return nil }
    return String(s[r])
  }

  private func regLast(_ s: String, _ p: String, group: Int = 0, ci: Bool = false) -> String? {
    guard let rx = try? NSRegularExpression(pattern: p, options: ci ? [.caseInsensitive] : []) else { return nil }
    let matches = rx.matches(in: s, range: NSRange(s.startIndex..., in: s))
    guard let m = matches.last, let r = Range(m.range(at: group), in: s) else { return nil }
    return String(s[r])
  }

  private func regReplace(_ s: String, _ p: String, _ repl: String, ci: Bool = false) -> String {
    guard let rx = try? NSRegularExpression(pattern: p, options: ci ? [.caseInsensitive] : []) else { return s }
    return rx.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: repl)
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MARK: - Utilities
  // ════════════════════════════════════════════════════════════════════════════

  private func f2(_ v: Double) -> String { String(format: "%.2f", v) }
  private func f3(_ v: CGFloat) -> String { String(format: "%.3f", v) }

  @available(iOS 13.0, *)
  private func pickBestTextCandidate(_ obs: VNRecognizedTextObservation) -> String? {
    let candidates = obs.topCandidates(3)
    guard !candidates.isEmpty else { return nil }

    var bestText: String?
    var bestScore = -Double.infinity

    for candidate in candidates {
      let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty { continue }

      var score = Double(candidate.confidence)
      if regMatch(text, #"\$?\s*\d{1,6}\.\d{2}"#) { score += 0.08 }

      let letters = text.filter { $0.isLetter }.count
      if letters >= 2 { score += 0.03 }
      if text.contains("|") || text.contains("[") || text.contains("]") { score -= 0.05 }

      if score > bestScore {
        bestScore = score
        bestText = text
      }
    }

    return bestText
  }

  private func saveImageToTemp(_ img: UIImage) -> String? {
    guard let d = img.jpegData(compressionQuality: 0.85) else { return nil }
    let p = (NSTemporaryDirectory() as NSString).appendingPathComponent("receipt_\(Int(Date().timeIntervalSince1970 * 1000)).jpg")
    do { try d.write(to: URL(fileURLWithPath: p)); return URL(fileURLWithPath: p).absoluteString }
    catch { return nil }
  }

  private func topViewController() -> UIViewController? {
    guard let sc = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
          let r = sc.windows.first(where: { $0.isKeyWindow })?.rootViewController else { return nil }
    return findTop(r)
  }
  private func findTop(_ v: UIViewController) -> UIViewController {
    if let p = v.presentedViewController { return findTop(p) }
    if let n = v as? UINavigationController, let t = n.topViewController { return findTop(t) }
    if let t = v as? UITabBarController, let s = t.selectedViewController { return findTop(s) }
    return v
  }
}
