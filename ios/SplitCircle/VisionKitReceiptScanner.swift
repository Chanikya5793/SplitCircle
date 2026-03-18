import Foundation
import UIKit
import VisionKit
import Vision
internal import React

/// VisionKit Receipt Scanner — v3: Price-First Spatial Association
///
/// Instead of clustering text into lines (fragile), this approach:
/// 1. Finds ALL standalone price blocks first
/// 2. Associates each price with left-side text on the same Y level
/// 3. Also handles inline prices (name+price in one observation)
/// 4. Classifies each (name, price) pair: item / total / tax / payment
/// 5. Self-heals by cross-checking against subtotal/total
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
        req.usesLanguageCorrection = true
        do {
          try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
          for obs in (req.results ?? []) {
            if let c = obs.topCandidates(1).first {
              allObs.append((c.string, obs.boundingBox))
            }
          }
        } catch {}
      }

      NSLog("[VK] \(allObs.count) observations")
      for (i, o) in allObs.enumerated() {
        NSLog("[VK] #\(i): \"\(o.0)\" x=\(self.f3(o.1.origin.x)) y=\(self.f3(o.1.origin.y)) w=\(self.f3(o.1.size.width)) h=\(self.f3(o.1.size.height))")
      }

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
          "date": result.date ?? NSNull()
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
  }

  /// A matched (name, price) from spatial association
  private struct PricedEntry {
    let nameText: String
    let price: Double
    let y: CGFloat
    let isInline: Bool // was the price inside the same observation as the name?
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MARK: - v3 Main Pipeline: Price-First Spatial Association
  // ════════════════════════════════════════════════════════════════════════════

  private func parseReceipt(_ obs: [(String, CGRect)]) -> Parsed {
    var receipt = Parsed()
    let blocks = obs.enumerated().map { Blk(text: $0.1.0, rect: $0.1.1, idx: $0.0) }
    guard !blocks.isEmpty else { return receipt }

    receipt.merchantName = extractMerchant(blocks)
    receipt.date = extractDate(blocks)

    // ── PASS 1: Find standalone price blocks ──
    // A "standalone price" is an observation whose text is purely a price value.
    var claimed = Set<Int>() // indices of blocks already consumed
    var entries: [PricedEntry] = []

    var standalonePrice: [(blk: Blk, price: Double)] = []
    for b in blocks {
      if isStandalonePrice(b.text) {
        if let p = parsePrice(b.text), p > 0, p < 50000 {
          standalonePrice.append((b, p))
        }
      }
    }
    // Sort top → bottom (descending Y in Vision coords)
    standalonePrice.sort { $0.blk.cy > $1.blk.cy }

    for (pb, price) in standalonePrice {
      // Find text blocks at similar Y, to the LEFT of this price
      let yTol = max(pb.h * 0.9, 0.006)
      var nameBlocks: [Blk] = []

      for b in blocks {
        guard !claimed.contains(b.idx) && b.idx != pb.idx else { continue }
        guard abs(b.cy - pb.cy) <= yTol else { continue }
        guard b.re < pb.le + 0.03 else { continue } // must end before price starts
        guard !isStandalonePrice(b.text) else { continue }
        nameBlocks.append(b)
      }
      nameBlocks.sort { $0.le < $1.le }
      let nameText = nameBlocks.map { $0.text.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")

      // Claim all these blocks
      claimed.insert(pb.idx)
      for nb in nameBlocks { claimed.insert(nb.idx) }

      entries.append(PricedEntry(nameText: nameText, price: price, y: pb.cy, isInline: false))
      NSLog("[VK] Pass1: \"\(nameText)\" → $\(f2(price))")
    }

    // ── PASS 2: Find inline prices in remaining observations ──
    // Some receipts return "ITEM NAME $17.99" as a single observation.
    for b in blocks {
      guard !claimed.contains(b.idx) else { continue }
      let text = b.text.trimmingCharacters(in: .whitespaces)
      guard text.count >= 4 else { continue }

      if let price = extractInlinePrice(text), price > 0, price < 50000 {
        let nameText = extractNameBeforePrice(text)
        if nameText.count >= 2 {
          entries.append(PricedEntry(nameText: nameText, price: price, y: b.cy, isInline: true))
          claimed.insert(b.idx)
          NSLog("[VK] Pass2: \"\(nameText)\" → $\(f2(price))")
        }
      }
    }

    // Sort all entries top → bottom
    entries.sort { $0.y > $1.y }

    // ── Collect unclaimed text blocks for name-only line handling ──
    var orphanBlocks: [Blk] = []
    for b in blocks {
      guard !claimed.contains(b.idx) else { continue }
      let t = b.text.trimmingCharacters(in: .whitespaces)
      let alphaCount = t.filter { $0.isLetter }.count
      if t.count >= 3 && alphaCount >= 2 { orphanBlocks.append(b) }
    }

    // ── PASS 3: Merge entries with orphan name-only blocks, classify ──
    // Build a unified timeline sorted by Y (top → bottom)
    enum TimelineItem {
      case priced(PricedEntry)
      case nameOnly(Blk)
    }
    var timeline: [(y: CGFloat, item: TimelineItem)] = []
    for e in entries { timeline.append((e.y, .priced(e))) }
    for o in orphanBlocks { timeline.append((o.cy, .nameOnly(o))) }
    timeline.sort { $0.y > $1.y } // top → bottom

    var pendingName: String? = nil
    var expectedItemCount: Int? = nil

    for (_, tItem) in timeline {
      switch tItem {
      case .nameOnly(let blk):
        let text = blk.text.trimmingCharacters(in: .whitespaces)
        let lower = text.lowercased()

        // Check for "Item Count: 18" pattern
        if let ic = parseItemCount(lower) { expectedItemCount = ic; continue }

        // Skip non-item text
        if isPaymentOrFooter(lower) || isHeaderOrStore(lower) || isAddress(lower) { continue }

        // Save as pending name for weight-line merging
        let cleaned = cleanItemName(text)
        if cleaned.count >= 2 {
          pendingName = cleaned
          NSLog("[VK] Pending: \"\(cleaned)\"")
        }

      case .priced(let entry):
        let lower = entry.nameText.lowercased().trimmingCharacters(in: .whitespaces)

        // ── Summary classification ──
        if matchTotal(lower) { receipt.total = entry.price; pendingName = nil; continue }
        if matchSubtotal(lower) { receipt.subtotal = entry.price; pendingName = nil; continue }
        if matchTax(lower) {
          // Accumulate tax (some receipts have TAX1 + TAX2)
          receipt.tax = (receipt.tax ?? 0) + entry.price; continue
        }
        if matchTip(lower) { receipt.tip = entry.price; continue }
        if isPaymentOrFooter(lower) { continue }
        if isHeaderOrStore(lower) { continue }

        // ── Weight continuation ──
        if isWeightLine(lower) {
          if let prev = pendingName {
            let conf = confidenceScore(prev, entry.price)
            receipt.items.append(RItem(name: prev, price: entry.price, quantity: 1, confidence: conf))
            NSLog("[VK] ✅ Weight-merge: \"\(prev)\" $\(f2(entry.price))")
            pendingName = nil
            continue
          }
        }

        // ── It's an item! ──
        let cleaned = cleanItemName(entry.nameText)
        if cleaned.count >= 2 {
          let conf = confidenceScore(cleaned, entry.price)
          receipt.items.append(RItem(name: cleaned, price: entry.price, quantity: 1, confidence: conf))
          NSLog("[VK] ✅ Item: \"\(cleaned)\" $\(f2(entry.price)) conf=\(f2(conf))")
          pendingName = nil
        } else if entry.nameText.isEmpty, let prev = pendingName {
          // Price with empty name → attach to pending name
          let conf = confidenceScore(prev, entry.price)
          receipt.items.append(RItem(name: prev, price: entry.price, quantity: 1, confidence: conf))
          NSLog("[VK] ✅ Pending→price: \"\(prev)\" $\(f2(entry.price))")
          pendingName = nil
        }
      }
    }

    // ── PASS 4: Validate & self-heal ──
    receipt = selfHeal(receipt, expectedCount: expectedItemCount)

    return receipt
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
    // Top 35% of receipt, sorted by text height (biggest = store name)
    let top = blocks.filter { $0.cy > 0.65 }
    let candidates = (top.isEmpty ? Array(blocks.sorted { $0.cy > $1.cy }.prefix(10)) : top)
      .filter { $0.text.trimmingCharacters(in: .whitespaces).count >= 3 &&
                $0.text.filter({ $0.isLetter }).count >= 2 }
      .sorted { $0.h > $1.h }

    for b in candidates {
      let t = b.text.trimmingCharacters(in: .whitespaces)
      let l = t.lowercased()
      if l.contains("feedback") || l.contains("survey") || l.contains(".com") ||
         l.contains("thank") || l.contains("id #") || l.contains("receipt") ||
         l.contains("invoice") { continue }
      if isAddress(l) { continue }
      if regMatch(l, #"\d{3}[\-\.]\d{3}[\-\.]\d{4}"#) { continue }
      NSLog("[VK] 🏪 Merchant: \"\(t)\" h=\(f3(b.h))")
      return String(t.prefix(60))
    }
    return nil
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

  private func regReplace(_ s: String, _ p: String, _ repl: String, ci: Bool = false) -> String {
    guard let rx = try? NSRegularExpression(pattern: p, options: ci ? [.caseInsensitive] : []) else { return s }
    return rx.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: repl)
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MARK: - Utilities
  // ════════════════════════════════════════════════════════════════════════════

  private func f2(_ v: Double) -> String { String(format: "%.2f", v) }
  private func f3(_ v: CGFloat) -> String { String(format: "%.3f", v) }

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
