import Foundation
import CoreGraphics
import NaturalLanguage

#if canImport(UIKit)
import UIKit
#endif

#if canImport(VisionKit)
import VisionKit
#endif

#if canImport(Vision)
import Vision
#endif

#if canImport(React)
internal import React
#endif

struct ReceiptTextObservation {
  let text: String
  let rect: CGRect
}

struct ReceiptParserItem {
  let name: String
  let price: Double
  let quantity: Int
  let confidence: Double
  let rowIndex: Int
}

struct ReceiptParserResult {
  var items: [ReceiptParserItem] = []
  var subtotal: Double?
  var tax: Double?
  var tip: Double?
  var total: Double?
  var merchantName: String?
  var merchantConfidence: Double?
  var date: String?
  var telemetry: [String] = []
}

struct ReceiptParserCore {
  static let ocrCustomWords: [String] = [
    "subtotal",
    "sub total",
    "grand total",
    "sales tax",
    "service charge",
    "gratuity",
    "item count",
    "items sold",
    "balance due",
    "amount due",
    "change due",
    "credit card",
    "debit card",
    "card ending",
    "apple pay",
    "google pay",
    "merchant copy",
    "customer copy",
    "authorization",
    "approval",
    "transaction",
    "receipt",
  ]

  private struct Block {
    let text: String
    let rect: CGRect
    let index: Int

    var midY: CGFloat { rect.midY }
    var minX: CGFloat { rect.minX }
    var maxX: CGFloat { rect.maxX }
    var minY: CGFloat { rect.minY }
    var maxY: CGFloat { rect.maxY }
    var height: CGFloat { rect.height }
  }

  private struct Row {
    let blocks: [Block]
    let text: String
    let index: Int
    let midY: CGFloat
    let topY: CGFloat
    let bottomY: CGFloat
    let leftX: CGFloat
    let rightX: CGFloat
    let averageHeight: CGFloat
    let centerX: CGFloat
  }

  private struct RowPrice {
    let value: Double
    let priceBlock: Block?
    let isStandalone: Bool
  }

  private struct MerchantCandidate {
    let name: String
    let score: Double
    let confidence: Double
  }

  private struct RowMetrics {
    let medianHeight: CGFloat
    let minimumItemHeight: CGFloat
  }

  static func parse(_ observations: [(String, CGRect)], headerObservations: [(String, CGRect)] = []) -> ReceiptParserResult {
    parse(
      observations.map { ReceiptTextObservation(text: $0.0, rect: $0.1) },
      headerObservations: headerObservations.map { ReceiptTextObservation(text: $0.0, rect: $0.1) }
    )
  }

  static func parse(_ observations: [ReceiptTextObservation], headerObservations: [ReceiptTextObservation] = []) -> ReceiptParserResult {
    let blocks = observations.enumerated().map {
      Block(text: $0.element.text, rect: $0.element.rect, index: $0.offset)
    }
    let headerBlocks = headerObservations.enumerated().map {
      Block(text: $0.element.text, rect: $0.element.rect, index: $0.offset)
    }

    var receipt = ReceiptParserResult()
    guard !blocks.isEmpty else { return receipt }

    let rows = buildRows(blocks)
    let headerRows = buildRows(headerBlocks)
    let rowMetrics = computeRowMetrics(rows)
    var telemetry: [String] = [
      "rows=\(rows.count), observations=\(blocks.count)",
      "headerRows=\(headerRows.count)",
      "medianRowHeight=\(f2(Double(rowMetrics.medianHeight)))",
    ]

    if let merchant = extractMerchant(from: headerRows, fallbackRows: rows) {
      receipt.merchantName = merchant.name
      receipt.merchantConfidence = merchant.confidence
      telemetry.append("merchant=\(merchant.name)")
      telemetry.append("merchantConfidence=\(f2(merchant.confidence))")
    }

    if let date = extractDate(from: blocks) {
      receipt.date = date
      telemetry.append("date=\(date)")
    }

    var expectedItemCount: Int?
    var summaryStarted = false
    var pendingNameParts: [String] = []

    for (rowIndex, row) in rows.enumerated() {
      let lower = normalizedLower(row.text)
      telemetry.append("row[\(rowIndex)] text=\(row.text)")

      if let count = parseItemCount(lower) {
        expectedItemCount = count
        telemetry.append("row[\(rowIndex)] itemCountHint=\(count)")
      }

      if let rowPrice = extractRowPrice(from: row) {
        telemetry.append("row[\(rowIndex)] price=\(f2(rowPrice.value))")

        if matchSubtotal(lower) {
          receipt.subtotal = rowPrice.value
          summaryStarted = true
          pendingNameParts.removeAll()
          telemetry.append("row[\(rowIndex)] classified=subtotal")
          continue
        }

        if matchTax(lower) {
          receipt.tax = (receipt.tax ?? 0) + rowPrice.value
          summaryStarted = true
          pendingNameParts.removeAll()
          telemetry.append("row[\(rowIndex)] classified=tax")
          continue
        }

        if matchTip(lower) {
          receipt.tip = rowPrice.value
          summaryStarted = true
          pendingNameParts.removeAll()
          telemetry.append("row[\(rowIndex)] classified=tip")
          continue
        }

        if matchTotal(lower) {
          if receipt.total == nil || lower.contains("grand total") {
            receipt.total = rowPrice.value
          }
          summaryStarted = true
          pendingNameParts.removeAll()
          telemetry.append("row[\(rowIndex)] classified=total")
          continue
        }

        if isNonItemPricedRow(lower) {
          pendingNameParts.removeAll()
          telemetry.append("row[\(rowIndex)] classified=ignored_non_item")
          continue
        }

        if !canTreatPricedRowAsItem(row, lower: lower, price: rowPrice, metrics: rowMetrics, summaryStarted: summaryStarted) {
          pendingNameParts.removeAll()
          telemetry.append("row[\(rowIndex)] classified=discarded_non_item")
          continue
        }

        if summaryStarted {
          pendingNameParts.removeAll()
          telemetry.append("row[\(rowIndex)] classified=ignored_after_summary")
          continue
        }

        var itemName = extractItemName(from: row, price: rowPrice)
        let pending = pendingNameParts.joined(separator: " ").trimmingCharacters(in: .whitespaces)

        if !pending.isEmpty && (itemName.isEmpty || isWeakItemName(itemName) || row.text.contains("@")) {
          itemName = cleanItemName("\(pending) \(itemName)")
          telemetry.append("row[\(rowIndex)] mergedPending=\(pending)")
        }

        if isValidItemName(itemName) {
          let quantity = inferQuantity(from: row.text)
          let confidence = confidenceScore(name: itemName, price: rowPrice.value, row: row, priceInfo: rowPrice)
          receipt.items.append(
            ReceiptParserItem(
              name: itemName,
              price: rowPrice.value,
              quantity: max(1, quantity),
              confidence: confidence,
              rowIndex: rowIndex
            )
          )
          pendingNameParts.removeAll()
          telemetry.append("row[\(rowIndex)] classified=item name=\(itemName) qty=\(quantity) conf=\(f2(confidence))")
        } else {
          telemetry.append("row[\(rowIndex)] classified=discarded_invalid_item")
        }

        continue
      }

      if summaryStarted {
        pendingNameParts.removeAll()
        telemetry.append("row[\(rowIndex)] classified=ignored_post_summary_no_price")
        continue
      }

      if isLikelyContinuationRow(lower, row: row, metrics: rowMetrics, summaryStarted: summaryStarted) {
        let cleaned = cleanItemName(row.text)
        if cleaned.count >= 2 {
          pendingNameParts.append(cleaned)
          telemetry.append("row[\(rowIndex)] continuation=\(cleaned)")
          if pendingNameParts.count > 3 {
            pendingNameParts.removeFirst()
          }
        }
      } else {
        pendingNameParts.removeAll()
        telemetry.append("row[\(rowIndex)] classified=ignored_no_price")
      }
    }

    if receipt.tax == nil || receipt.subtotal == nil || receipt.total == nil {
      fillMissingSummaryValues(from: rows, into: &receipt)
      telemetry.append("summaryFallbackApplied=true")
    }

    receipt = selfHeal(receipt, expectedCount: expectedItemCount)
    telemetry.append(
      "result items=\(receipt.items.count) subtotal=\(receipt.subtotal.map { f2($0) } ?? "nil") tax=\(receipt.tax.map { f2($0) } ?? "nil") total=\(receipt.total.map { f2($0) } ?? "nil")"
    )
    receipt.telemetry = Array(telemetry.suffix(240))
    return receipt
  }

  private static func buildRows(_ blocks: [Block]) -> [Row] {
    guard !blocks.isEmpty else { return [] }

    struct MutableRow {
      var blocks: [Block]
      var midY: CGFloat
      var topY: CGFloat
      var bottomY: CGFloat
    }

    var rows: [MutableRow] = []
    let sorted = blocks.sorted { $0.midY > $1.midY }

    for block in sorted {
      let tolerance = max(0.012, min(0.03, block.height * 1.45))
      if let index = rows.firstIndex(where: { abs($0.midY - block.midY) <= tolerance }) {
        rows[index].blocks.append(block)
        let count = CGFloat(rows[index].blocks.count)
        rows[index].midY = ((rows[index].midY * (count - 1)) + block.midY) / count
        rows[index].topY = max(rows[index].topY, block.maxY)
        rows[index].bottomY = min(rows[index].bottomY, block.minY)
      } else {
        rows.append(MutableRow(blocks: [block], midY: block.midY, topY: block.maxY, bottomY: block.minY))
      }
    }

    return rows
      .enumerated()
      .map { offset, row in
        let lineBlocks = row.blocks.sorted { $0.minX < $1.minX }
        let text = lineBlocks
          .map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
          .filter { !$0.isEmpty }
          .joined(separator: " ")
        let leftX = lineBlocks.first?.minX ?? 0
        let rightX = lineBlocks.last?.maxX ?? 0
        let heights = lineBlocks.map(\.height)
        let averageHeight = heights.isEmpty ? 0 : heights.reduce(0, +) / CGFloat(heights.count)
        return Row(
          blocks: lineBlocks,
          text: text,
          index: offset,
          midY: row.midY,
          topY: row.topY,
          bottomY: row.bottomY,
          leftX: leftX,
          rightX: rightX,
          averageHeight: averageHeight,
          centerX: (leftX + rightX) / 2
        )
      }
      .filter { !$0.text.isEmpty }
      .sorted { $0.midY > $1.midY }
  }

  private static func computeRowMetrics(_ rows: [Row]) -> RowMetrics {
    let heights = rows
      .filter {
        let lower = normalizedLower($0.text)
        return $0.text.filter(\.isLetter).count >= 2
          && !isMerchantNoise(lower)
          && !isNonItemPricedRow(lower)
      }
      .map(\.averageHeight)
      .sorted()

    guard !heights.isEmpty else {
      return RowMetrics(medianHeight: 0.018, minimumItemHeight: 0.011)
    }

    let median = heights[heights.count / 2]
    return RowMetrics(
      medianHeight: median,
      minimumItemHeight: max(0.0105, median * 0.58)
    )
  }

  private static func extractRowPrice(from row: Row) -> RowPrice? {
    for block in row.blocks.sorted(by: { $0.minX > $1.minX }) {
      guard isStandalonePrice(block.text), let value = parsePrice(block.text) else { continue }
      if value > 0, value < 50_000 {
        return RowPrice(value: value, priceBlock: block, isStandalone: true)
      }
    }

    guard let match = regLast(row.text, #"\$?\s*(\d{1,6}\.\d{2})\s*[A-Z]?\s*$"#, group: 1),
          let value = Double(match),
          value > 0,
          value < 50_000 else {
      return nil
    }

    return RowPrice(value: value, priceBlock: nil, isStandalone: false)
  }

  private static func extractItemName(from row: Row, price: RowPrice) -> String {
    var raw = row.text

    if let priceBlock = price.priceBlock {
      let leftBlocks = row.blocks
        .filter { $0.maxX <= priceBlock.minX + 0.01 }
        .sorted { $0.minX < $1.minX }
      let leftText = leftBlocks
        .map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
        .joined(separator: " ")
      if !leftText.isEmpty {
        raw = leftText
      }
    }

    raw = regReplace(raw, #"\$?\s*\d{1,6}\.\d{2}\s*[A-Z]?\s*$"#, "")
    return cleanItemName(raw)
  }

  private static func cleanItemName(_ raw: String) -> String {
    var name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    name = regReplace(name, #"^\d{1,2}(?:\s*[.)\-]\s+|\s{2,})"#, "")
    name = regReplace(name, #"^\d{1,2}\s*[xX]\s+"#, "")
    name = regReplace(name, #"\bqty\s*[:.]?\s*\d+\b"#, "", ci: true)
    name = regReplace(name, #"\b(?:sku|upc|plu|dept|item|code)\s*#?\s*\d+\b"#, "", ci: true)
    name = regReplace(name, #"\d{8,}"#, "")
    name = regReplace(name, #"\$?\s*\d{1,6}\.\d{2}"#, "")
    name = regReplace(name, #"\d+\.?\d*\s*(?:lb|lbs|oz|kg)\s*\.?\s*@\s*\$?\d+\.?\d*\s*/\s*(?:lb|lbs|oz|kg|ea|each)"#, "", ci: true)
    name = regReplace(name, #"@\s*\$?\d+\.\d+\s*/\s*(?:lb|lbs|oz|kg|ea|each)"#, "", ci: true)
    name = regReplace(name, #"\s+[A-Z]\s*$"#, "")
    name = regReplace(name, #"\*+\s*$"#, "")
    name = regReplace(name, #"^\d{5,}\s{2,}"#, "")
    name = regReplace(name, #"\s{2,}"#, " ")
    name = name
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: ".-–—:*#/$@,;()[]{}"))
      .trimmingCharacters(in: .whitespacesAndNewlines)

    if name.count > 2, let split = name.lastIndex(of: " ") {
      let tail = String(name[name.index(after: split)...])
      if tail.count == 1, tail.first?.isUppercase == true {
        name = String(name[..<split]).trimmingCharacters(in: .whitespacesAndNewlines)
      }
    }

    return name
  }

  private static func inferQuantity(from rowText: String) -> Int {
    let text = rowText.trimmingCharacters(in: .whitespacesAndNewlines)

    if let match = regFirst(text, #"^\s*(\d{1,2})\s*[xX]\s+"#, group: 1),
       let quantity = Int(match),
       quantity > 0,
       quantity < 50 {
      return quantity
    }

    if let match = regFirst(text, #"\bqty\s*[:.]?\s*(\d{1,2})\b"#, group: 1, ci: true),
       let quantity = Int(match),
       quantity > 0,
       quantity < 50 {
      return quantity
    }

    if let match = regFirst(text, #"^\s*(\d{1,2})\s*@\s*\$?\d"#, group: 1),
       let quantity = Int(match),
       quantity > 0,
       quantity < 50 {
      return quantity
    }

    return 1
  }

  private static func isWeakItemName(_ name: String) -> Bool {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count >= 4 else { return true }
    let letters = trimmed.filter(\.isLetter).count
    let digits = trimmed.filter(\.isNumber).count
    if letters < 2 { return true }
    return digits > letters
  }

  private static func isValidItemName(_ name: String) -> Bool {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count >= 2 else { return false }

    let lower = normalizedLower(trimmed)
    if matchSubtotal(lower) || matchTax(lower) || matchTip(lower) || matchTotal(lower) {
      return false
    }

    if isNonItemPricedRow(lower) || isMerchantNoise(lower) {
      return false
    }

    let letters = trimmed.filter(\.isLetter).count
    guard letters >= 2 else { return false }

    let tokens = trimmed.split(whereSeparator: \.isWhitespace)
    if tokens.count > 10 {
      return false
    }

    let digitRatio = Double(trimmed.filter(\.isNumber).count) / Double(max(1, trimmed.count))
    if digitRatio > 0.45 {
      return false
    }

    return true
  }

  private static func canTreatPricedRowAsItem(
    _ row: Row,
    lower: String,
    price: RowPrice,
    metrics: RowMetrics,
    summaryStarted: Bool
  ) -> Bool {
    if price.value <= 0 { return false }
    if summaryStarted && regMatch(lower, #"\b(?:balance|amount due|cash|change|card|approval|auth|account|transaction)\b"#, ci: true) {
      return false
    }
    if isNonItemPricedRow(lower) { return false }

    if row.averageHeight < metrics.minimumItemHeight && (row.midY > 0.82 || row.midY < 0.18 || isMerchantNoise(lower)) {
      return false
    }

    if row.midY > 0.84 && !regMatch(lower, #"\b(?:lb|lbs|oz|kg|qty|x)\b"#, ci: true) {
      return false
    }

    let itemName = extractItemName(from: row, price: price)
    let letters = itemName.filter(\.isLetter).count
    if letters < 2 && !regMatch(lower, #"\b(?:lb|lbs|oz|kg)\b"#, ci: true) {
      return false
    }
    if itemName.count > 52 && !regMatch(lower, #"\b(?:lb|lbs|oz|kg|qty)\b"#, ci: true) {
      return false
    }

    return true
  }

  private static func isLikelyContinuationRow(
    _ lower: String,
    row: Row,
    metrics: RowMetrics,
    summaryStarted: Bool
  ) -> Bool {
    guard lower.count >= 2 else { return false }
    if summaryStarted { return false }
    if regMatch(lower, #"\$?\s*\d{1,6}\.\d{2}"#) { return false }
    if isMerchantNoise(lower) || isNonItemPricedRow(lower) { return false }
    if matchSubtotal(lower) || matchTax(lower) || matchTip(lower) || matchTotal(lower) { return false }
    if regMatch(lower, #"\b(date|time|station|invoice|order|auth|approval|trace|register|terminal)\b"#, ci: true) {
      return false
    }
    if row.midY > 0.84 || row.midY < 0.18 { return false }
    if row.averageHeight < metrics.minimumItemHeight * 0.8 && isMerchantNoise(lower) { return false }
    return lower.filter(\.isLetter).count >= 2
  }

  private static func fillMissingSummaryValues(from rows: [Row], into receipt: inout ReceiptParserResult) {
    for index in rows.indices {
      let row = rows[index]
      let lower = normalizedLower(row.text)

      if let rowPrice = extractRowPrice(from: row) {
        if receipt.subtotal == nil, matchSubtotal(lower) { receipt.subtotal = rowPrice.value }
        if receipt.tax == nil, matchTax(lower) { receipt.tax = rowPrice.value }
        if receipt.tip == nil, matchTip(lower) { receipt.tip = rowPrice.value }
        if receipt.total == nil, matchTotal(lower) { receipt.total = rowPrice.value }
        continue
      }

      guard index + 1 < rows.count, let nextPrice = extractRowPrice(from: rows[index + 1]) else { continue }
      if receipt.subtotal == nil, matchSubtotal(lower) { receipt.subtotal = nextPrice.value }
      if receipt.tax == nil, matchTax(lower) { receipt.tax = nextPrice.value }
      if receipt.tip == nil, matchTip(lower) { receipt.tip = nextPrice.value }
      if receipt.total == nil, matchTotal(lower) { receipt.total = nextPrice.value }
    }
  }

  private static func selfHeal(_ receipt: ReceiptParserResult, expectedCount: Int?) -> ReceiptParserResult {
    var healed = receipt

    if let subtotal = healed.subtotal {
      healed = dropSuspiciousItemsIfNeeded(from: healed, targetSubtotal: subtotal)
    }

    if let expectedCount = expectedCount, healed.items.count > expectedCount {
      healed = trimToExpectedCountIfSafe(from: healed, expectedCount: expectedCount)
    }

    if healed.total == nil {
      let itemSum = healed.items.reduce(0.0) { $0 + ($1.price * Double($1.quantity)) }
      healed.total = itemSum + (healed.tax ?? 0) + (healed.tip ?? 0)
    }

    return healed
  }

  private static func dropSuspiciousItemsIfNeeded(from receipt: ReceiptParserResult, targetSubtotal: Double) -> ReceiptParserResult {
    let tolerance = max(0.05, targetSubtotal * 0.01)
    let itemSum = receipt.items.reduce(0.0) { $0 + ($1.price * Double($1.quantity)) }
    let overage = itemSum - targetSubtotal

    guard overage > tolerance else { return receipt }

    let candidates = receipt.items.enumerated().filter { _, item in
      item.confidence < 0.82 || isSuspiciousItemName(item.name)
    }

    guard !candidates.isEmpty else { return receipt }

    let limited = Array(candidates.sorted {
      if $0.element.rowIndex == $1.element.rowIndex {
        return $0.element.confidence < $1.element.confidence
      }
      return $0.element.rowIndex > $1.element.rowIndex
    }.prefix(8))

    let candidateIndices = limited.map(\.offset)
    let candidateItems = limited.map(\.element)

    if let match = matchingRemovalIndices(items: candidateItems, target: overage, tolerance: tolerance) {
      let absoluteIndices = match.map { candidateIndices[$0] }.sorted(by: >)
      var next = receipt
      for index in absoluteIndices {
        next.items.remove(at: index)
      }
      return next
    }

    return receipt
  }

  private static func matchingRemovalIndices(items: [ReceiptParserItem], target: Double, tolerance: Double) -> [Int]? {
    for first in items.indices {
      if abs(items[first].price * Double(items[first].quantity) - target) <= tolerance {
        return [first]
      }
    }

    guard items.count >= 2 else { return nil }

    for first in items.indices {
      for second in (first + 1)..<items.count {
        let sum = items[first].price * Double(items[first].quantity) + items[second].price * Double(items[second].quantity)
        if abs(sum - target) <= tolerance {
          return [first, second]
        }
      }
    }

    return nil
  }

  private static func trimToExpectedCountIfSafe(from receipt: ReceiptParserResult, expectedCount: Int) -> ReceiptParserResult {
    let overflow = receipt.items.count - expectedCount
    guard overflow > 0 else { return receipt }

    let sortedCandidates = receipt.items.enumerated()
      .filter { _, item in item.confidence < 0.75 || isSuspiciousItemName(item.name) }
      .sorted {
        if $0.element.confidence == $1.element.confidence {
          return $0.element.rowIndex > $1.element.rowIndex
        }
        return $0.element.confidence < $1.element.confidence
      }

    guard sortedCandidates.count >= overflow else { return receipt }

    let removalIndices = sortedCandidates.prefix(overflow).map(\.offset).sorted(by: >)
    var next = receipt
    for index in removalIndices {
      next.items.remove(at: index)
    }
    return next
  }

  private static func confidenceScore(name: String, price: Double, row: Row, priceInfo: RowPrice) -> Double {
    var score = 0.58
    let letters = name.filter(\.isLetter).count
    let digits = name.filter(\.isNumber).count
    let letterRatio = Double(letters) / Double(max(1, name.count))
    let digitRatio = Double(digits) / Double(max(1, name.count))

    if name.count >= 4 { score += 0.06 }
    if name.count >= 8 { score += 0.06 }
    if letterRatio > 0.55 { score += 0.08 }
    if letterRatio > 0.8 { score += 0.06 }
    if digitRatio > 0.25 { score -= 0.16 }
    if isSuspiciousItemName(name) { score -= 0.18 }

    if price >= 0.5 && price <= 250 { score += 0.06 }
    if priceInfo.isStandalone { score += 0.05 }
    if row.rightX >= 0.72 { score += 0.04 }
    if row.averageHeight >= 0.016 { score += 0.03 }
    if row.text.contains("@") { score -= 0.02 }
    if isNonItemPricedRow(normalizedLower(row.text)) { score -= 0.24 }

    return clamp(score)
  }

  private static func extractMerchant(from headerRows: [Row], fallbackRows rows: [Row]) -> MerchantCandidate? {
    if let headerMerchant = bestMerchantCandidate(from: Array(headerRows.filter { $0.midY > 0.58 }.prefix(8))) {
      return headerMerchant
    }
    return bestMerchantCandidate(from: rows)
  }

  private static func bestMerchantCandidate(from rows: [Row]) -> MerchantCandidate? {
    guard !rows.isEmpty else { return nil }

    let firstLikelyItemIndex = rows.firstIndex { row in
      guard extractRowPrice(from: row) != nil else { return false }
      let lower = normalizedLower(row.text)
      return !matchSubtotal(lower)
        && !matchTax(lower)
        && !matchTip(lower)
        && !matchTotal(lower)
        && !isNonItemPricedRow(lower)
    }

    let headerLimit = min(rows.count, max(6, (firstLikelyItemIndex ?? 4) + 2))
    let candidates = Array(rows.prefix(headerLimit))
    var best: MerchantCandidate?

    for row in candidates {
      if let candidate = merchantCandidate(from: row) {
        if best == nil || candidate.score > best!.score {
          best = candidate
        }
      }
    }

    for index in 0..<(max(0, candidates.count - 1)) {
      if let candidate = combinedMerchantCandidate(first: candidates[index], second: candidates[index + 1]) {
        if best == nil || candidate.score > best!.score {
          best = candidate
        }
      }
    }

    guard let best = best, best.confidence >= 0.35 else { return nil }
    return best
  }

  private static func merchantCandidate(from row: Row) -> MerchantCandidate? {
    let cleaned = cleanMerchantCandidate(row.text)
    guard cleaned.count >= 3 else { return nil }

    let lower = normalizedLower(cleaned)
    if isMerchantNoise(lower) || isGenericMerchantDescriptor(lower) {
      return nil
    }

    if regMatch(cleaned, #"\$?\s*\d{1,6}\.\d{2}"#) { return nil }

    let chars = max(1, cleaned.count)
    let letters = cleaned.filter(\.isLetter).count
    let digits = cleaned.filter(\.isNumber).count
    let uppercase = cleaned.filter(\.isUppercase).count
    let letterRatio = Double(letters) / Double(chars)
    let digitRatio = Double(digits) / Double(chars)
    let uppercaseRatio = Double(uppercase) / Double(max(1, letters))
    let centeredness = clamp(1.0 - Double(abs(row.centerX - 0.5)) * 2.4)
    let heightScore = clamp(Double(row.averageHeight / 0.035))
    let widthScore = clamp(Double((row.rightX - row.leftX) / 0.7))
    let tokenCount = cleaned.split(whereSeparator: \.isWhitespace).count
    let languageScore = languageConfidence(for: cleaned)

    var score = 0.0
    score += heightScore * 1.45
    score += centeredness * 1.15
    score += letterRatio * 1.4
    score += widthScore * 0.35
    score += languageScore * 0.4
    score += min(0.35, uppercaseRatio * 0.3)
    score -= digitRatio * 1.4

    if tokenCount >= 1 && tokenCount <= 5 { score += 0.18 }
    if tokenCount > 6 { score -= 0.28 }
    if row.topY > 0.85 { score += 0.14 }
    if isTitleCase(cleaned) { score += 0.08 }

    let confidence = clamp((score - 1.1) / 2.4)
    return MerchantCandidate(name: cleaned, score: score, confidence: confidence)
  }

  private static func combinedMerchantCandidate(first: Row, second: Row) -> MerchantCandidate? {
    let firstText = cleanMerchantCandidate(first.text)
    let secondText = cleanMerchantCandidate(second.text)
    let firstLower = normalizedLower(firstText)
    let secondLower = normalizedLower(secondText)

    guard !firstText.isEmpty, !secondText.isEmpty else { return nil }
    guard !isMerchantNoise(firstLower), !isMerchantNoise(secondLower) else { return nil }
    guard !isGenericMerchantDescriptor(firstLower), !isGenericMerchantDescriptor(secondLower) else { return nil }
    guard abs(first.centerX - second.centerX) <= 0.18 else { return nil }

    let merged = cleanMerchantCandidate("\(firstText) \(secondText)")
    guard merged.count <= 50 else { return nil }
    guard !isGenericMerchantDescriptor(normalizedLower(merged)) else { return nil }

    let pseudoRow = Row(
      blocks: first.blocks + second.blocks,
      text: merged,
      index: min(first.index, second.index),
      midY: (first.midY + second.midY) / 2,
      topY: max(first.topY, second.topY),
      bottomY: min(first.bottomY, second.bottomY),
      leftX: min(first.leftX, second.leftX),
      rightX: max(first.rightX, second.rightX),
      averageHeight: max(first.averageHeight, second.averageHeight),
      centerX: (first.centerX + second.centerX) / 2
    )

    guard var candidate = merchantCandidate(from: pseudoRow) else { return nil }
    candidate = MerchantCandidate(
      name: candidate.name,
      score: candidate.score + 0.18,
      confidence: clamp(candidate.confidence + 0.08)
    )
    return candidate
  }

  private static func cleanMerchantCandidate(_ raw: String) -> String {
    var candidate = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    candidate = regReplace(candidate, #"^(welcome to|thank you for shopping at)\s+"#, "", ci: true)
    candidate = regReplace(candidate, #"\b(store|location|branch)\s*#?\s*\d+\b"#, "", ci: true)
    candidate = regReplace(candidate, #"^\W+|\W+$"#, "")
    candidate = regReplace(candidate, #"\s{2,}"#, " ")
    candidate = candidate.trimmingCharacters(in: CharacterSet(charactersIn: ".-–—:*#/$@,;()[]{}"))
    return candidate.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func languageConfidence(for text: String) -> Double {
    guard text.count >= 4 else { return 0.45 }
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    let hypotheses = recognizer.languageHypotheses(withMaximum: 2)
    return hypotheses.values.max() ?? 0.0
  }

  private static func extractDate(from blocks: [Block]) -> String? {
    let patterns = [
      try! NSRegularExpression(pattern: #"(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})"#),
      try! NSRegularExpression(pattern: #"(\w{3,9}\s+\d{1,2},?\s+\d{4})"#, options: .caseInsensitive),
      try! NSRegularExpression(pattern: #"(\d{4}[/\-]\d{2}[/\-]\d{2})"#),
    ]

    for block in blocks {
      let range = NSRange(block.text.startIndex..., in: block.text)
      for pattern in patterns {
        if let match = pattern.firstMatch(in: block.text, range: range),
           let resultRange = Range(match.range(at: 1), in: block.text) {
          return String(block.text[resultRange])
        }
      }
    }

    return nil
  }

  private static func matchTotal(_ lower: String) -> Bool {
    if lower.contains("grand total") { return true }
    guard lower.contains("total") else { return false }
    if lower.contains("subtotal") || lower.contains("sub total") || lower.contains("sub-total") {
      return false
    }
    if lower.contains("total purchase") || lower.contains("total savings") || lower.contains("total bonus") {
      return false
    }
    if lower.contains("total earned") || lower.contains("total points") {
      return false
    }
    return true
  }

  private static func matchSubtotal(_ lower: String) -> Bool {
    lower.contains("subtotal") || lower.contains("sub total") || lower.contains("sub-total")
  }

  private static func matchTax(_ lower: String) -> Bool {
    if lower.hasPrefix("tax") {
      let rest = String(lower.dropFirst(3))
      if rest.isEmpty || rest.first?.isNumber == true || rest.first?.isWhitespace == true || rest.first == ":" {
        return true
      }
    }
    if lower.hasSuffix(" tax") || lower.hasSuffix(" tax:") { return true }
    let taxKeywords = ["sales tax", "state tax", "local tax", "county tax", "city tax", "hst", "gst", "vat", "iva"]
    return taxKeywords.contains { lower.contains($0) }
  }

  private static func matchTip(_ lower: String) -> Bool {
    lower.contains("tip") || lower.contains("gratuity") || lower.contains("service charg")
  }

  private static func isDiscountOrAdjustment(_ lower: String) -> Bool {
    let keywords = [
      "coupon",
      "discount",
      "savings",
      "save",
      "promo",
      "promotion",
      "rebate",
      "void",
      "refund",
      "return",
      "adjustment",
      "redeemed",
      "redemption",
      "loyalty",
      "reward",
      "member price",
      "cash back",
      "cashback",
      "rounding",
    ]
    return keywords.contains { lower.contains($0) }
  }

  private static func isColumnHeader(_ lower: String) -> Bool {
    let headers = [
      "description qty amount",
      "description amount",
      "item qty price",
      "item price",
      "qty price",
      "price qty",
      "amount qty",
      "description",
      "unit price",
      "quantity",
    ]
    return headers.contains(where: { lower.contains($0) })
  }

  private static func isPaymentOrFooter(_ lower: String) -> Bool {
    let keywords = [
      "change due",
      "cash tend",
      "credit tend",
      "visa tend",
      "visa",
      "mastercard",
      "amex",
      "discover",
      "debit card",
      "debit",
      "credit card",
      "credit",
      "walmart pay",
      "apple pay",
      "google pay",
      "paypal",
      "tap to pay",
      "card ending",
      "card #",
      "card no",
      "card type",
      "card entry",
      "xxxx",
      "account #",
      "acct#",
      "acct #",
      "approval",
      "auth code",
      "authorization",
      "ref num",
      "ref #",
      "trace",
      "app label",
      "thank you",
      "thanks for",
      "come again",
      "have a nice",
      "transaction",
      "receipt",
      "invoice",
      "register",
      "cashier",
      "clerk",
      "server:",
      "host:",
      "table:",
      "survey",
      "feedback",
      "www.",
      "http",
      ".com",
      ".org",
      ".net",
      "merchant copy",
      "customer copy",
      "balance due",
      "amount due",
      "amount paid",
      "tendered",
      "return policy",
      "approved",
      "declined",
    ]

    if keywords.contains(where: { lower.contains($0) }) { return true }
    return regMatch(lower, #"\(?\d{3}\)?[\s\-\.]\d{3}[\s\-\.]\d{4}"#)
  }

  private static func isHeaderOrMetadata(_ lower: String) -> Bool {
    let keywords = [
      "mgr.",
      "manager",
      "st#",
      "store #",
      "op#",
      "te#",
      "tr#",
      "date/time",
      "date:",
      "time:",
      "station:",
      "station ",
      "closed to",
      "order #",
      "order:",
      "invoice #",
      "terminal",
      "check #",
      "trans #",
      "seq #",
      "welcome to",
      "hours",
      "sold by",
    ]
    if keywords.contains(where: { lower.contains($0) }) { return true }
    return regMatch(lower, #"\b(?:date|time)\s*[:#]\s*\d"#, ci: true)
  }

  private static func isAddress(_ lower: String) -> Bool {
    if regMatch(lower, #"\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b"#, ci: true) { return true }
    let streetKeywords = [" st ", " ave ", " blvd ", " rd ", " dr ", " ln ", " pkwy ", " hwy ", " way ", " street", " suite ", " ste ", " avenue", " boulevard", " road", " drive", " lane"]
    if streetKeywords.contains(where: { lower.contains($0) || lower.hasSuffix($0.trimmingCharacters(in: .whitespaces)) }) {
      return true
    }
    return regMatch(lower, #"\b\d{1,5}\s+[a-z0-9].*(?:st|street|ave|road|rd|drive|dr|blvd|lane|ln|way)\b"#, ci: true)
  }

  private static func isGenericMerchantDescriptor(_ lower: String) -> Bool {
    let tokens = lower.split(whereSeparator: \.isWhitespace).map(String.init)
    guard !tokens.isEmpty, tokens.count <= 4 else { return false }
    let genericTokens: Set<String> = [
      "market",
      "marketplace",
      "grocery",
      "supermarket",
      "supercenter",
      "mart",
      "shop",
      "store",
      "restaurant",
      "cafe",
      "pharmacy",
      "grill",
      "bistro",
      "one",
      "stop",
    ]
    return tokens.allSatisfy { genericTokens.contains($0) }
  }

  private static func isMerchantNoise(_ lower: String) -> Bool {
    if lower.count < 3 { return true }
    if regMatch(lower, #"\d{3}[\-\.]\d{3}[\-\.]\d{4}"#) { return true }
    if regMatch(lower, #"\$?\s*\d{1,6}\.\d{2}"#) { return true }
    if isAddress(lower) || isHeaderOrMetadata(lower) || isColumnHeader(lower) { return true }
    if lower.contains("feedback") || lower.contains("survey") || lower.contains(".com") || lower.contains("thank") {
      return true
    }
    if lower.contains("receipt") || lower.contains("invoice") || lower.contains("store #") || lower.contains("st#") {
      return true
    }
    return false
  }

  private static func isNonItemPricedRow(_ lower: String) -> Bool {
    isPaymentOrFooter(lower)
      || isHeaderOrMetadata(lower)
      || isAddress(lower)
      || isDiscountOrAdjustment(lower)
      || isColumnHeader(lower)
      || regMatch(lower, #"authorization|approval|transaction|account|terminal|register|cash back|cashback"#, ci: true)
  }

  private static func parseItemCount(_ lower: String) -> Int? {
    if let match = regFirst(lower, #"item\s*count\s*:?\s*(\d+)"#, group: 1, ci: true),
       let count = Int(match) {
      return count
    }
    if let match = regFirst(lower, #"#?\s*items?\s*sold\s*:?\s*(\d+)"#, group: 1, ci: true),
       let count = Int(match) {
      return count
    }
    return nil
  }

  private static func isStandalonePrice(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return regMatch(trimmed, #"^-?\s*\$?\s*\d{1,6}\.\d{2}\s*[A-Z]?\s*$"#)
  }

  private static func parsePrice(_ text: String) -> Double? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let match = regFirst(trimmed, #"-?\s*\$?\s*(\d{1,6}\.\d{2})"#, group: 1),
          let value = Double(match) else {
      return nil
    }
    return trimmed.contains("-") ? -value : value
  }

  private static func isSuspiciousItemName(_ name: String) -> Bool {
    let lower = normalizedLower(name)
    if lower.count < 3 { return true }
    if isNonItemPricedRow(lower) || isMerchantNoise(lower) { return true }
    let tokens = lower.split(whereSeparator: \.isWhitespace).map(String.init)
    let suspiciousTokens: Set<String> = [
      "card",
      "cash",
      "credit",
      "debit",
      "auth",
      "approval",
      "transaction",
      "account",
      "change",
      "points",
      "reward",
      "coupon",
      "discount",
      "subtotal",
      "tax",
      "total",
      "tip",
    ]
    return tokens.contains(where: { suspiciousTokens.contains($0) })
  }

  private static func normalizedLower(_ value: String) -> String {
    value.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func isTitleCase(_ value: String) -> Bool {
    let words = value.split(whereSeparator: \.isWhitespace)
    guard !words.isEmpty else { return false }
    let matching = words.filter { word in
      guard let first = word.first else { return false }
      return first.isUppercase
    }
    return Double(matching.count) / Double(words.count) >= 0.6
  }

  private static func clamp(_ value: Double, lower: Double = 0, upper: Double = 1) -> Double {
    min(max(value, lower), upper)
  }

  private static func f2(_ value: Double) -> String {
    String(format: "%.2f", value)
  }

  private static func regMatch(_ string: String, _ pattern: String, ci: Bool = false) -> Bool {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: ci ? [.caseInsensitive] : []) else {
      return false
    }
    return regex.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)) != nil
  }

  private static func regFirst(_ string: String, _ pattern: String, group: Int = 0, ci: Bool = false) -> String? {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: ci ? [.caseInsensitive] : []),
          let match = regex.firstMatch(in: string, range: NSRange(string.startIndex..., in: string)),
          let range = Range(match.range(at: group), in: string) else {
      return nil
    }
    return String(string[range])
  }

  private static func regLast(_ string: String, _ pattern: String, group: Int = 0, ci: Bool = false) -> String? {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: ci ? [.caseInsensitive] : []) else {
      return nil
    }
    let matches = regex.matches(in: string, range: NSRange(string.startIndex..., in: string))
    guard let match = matches.last,
          let range = Range(match.range(at: group), in: string) else {
      return nil
    }
    return String(string[range])
  }

  private static func regReplace(_ string: String, _ pattern: String, _ replacement: String, ci: Bool = false) -> String {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: ci ? [.caseInsensitive] : []) else {
      return string
    }
    return regex.stringByReplacingMatches(in: string, range: NSRange(string.startIndex..., in: string), withTemplate: replacement)
  }
}

#if canImport(UIKit) && canImport(VisionKit) && canImport(Vision) && canImport(React)
@objc(VisionKitReceiptScanner)
class VisionKitReceiptScanner: RCTEventEmitter, VNDocumentCameraViewControllerDelegate {
  private var scanResolve: RCTPromiseResolveBlock?
  private var scanReject: RCTPromiseRejectBlock?

  override static func requiresMainQueueSetup() -> Bool { true }
  override func supportedEvents() -> [String]! { ["onScanProgress"] }

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
      reject("UNSUPPORTED", "VisionKit not supported.", nil)
      return
    }

    scanResolve = resolve
    scanReject = reject

    DispatchQueue.main.async { [weak self] in
      let controller = VNDocumentCameraViewController()
      controller.delegate = self
      controller.modalPresentationStyle = .fullScreen

      guard let root = self?.topViewController() else {
        reject("NO_VC", "No view controller.", nil)
        self?.scanResolve = nil
        self?.scanReject = nil
        return
      }

      root.present(controller, animated: true)
    }
  }

  @objc func scanImage(_ imageUri: NSString,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 13.0, *) else {
      reject("UNSUPPORTED", "On-device receipt parsing requires iOS 13 or later.", nil)
      return
    }

    let sourceUri = imageUri as String

    DispatchQueue.main.async { [weak self] in
      self?.sendEvent(withName: "onScanProgress", body: [
        "status": "processing",
        "message": "Processing receipt image...",
      ])
    }

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self = self else { return }
      guard let image = self.loadImage(from: sourceUri), let cgImage = image.cgImage else {
        DispatchQueue.main.async {
          reject("INVALID_IMAGE", "Unable to load receipt image for on-device parsing.", nil)
        }
        return
      }

      let recognition = self.recognizeReceipt(in: [cgImage])

      DispatchQueue.main.async { [weak self] in
        self?.sendEvent(withName: "onScanProgress", body: [
          "status": "parsing",
          "message": "Extracting receipt items...",
          "textLinesFound": recognition.observations.count,
        ])
      }

      let parsed = ReceiptParserCore.parse(recognition.observations, headerObservations: recognition.headerObservations)
      let payload = self.makePayload(parsed: parsed, observations: recognition.observations, imageUri: sourceUri)

      DispatchQueue.main.async { [weak self] in
        self?.sendEvent(withName: "onScanProgress", body: [
          "status": "complete",
          "message": "Receipt scanned!",
          "itemCount": parsed.items.count,
        ])

        resolve(payload)
      }
    }
  }

  @available(iOS 13.0, *)
  func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
    controller.dismiss(animated: true) { [weak self] in
      self?.processScannedDocument(scan)
    }
  }

  @available(iOS 13.0, *)
  func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
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

  @available(iOS 13.0, *)
  private func processScannedDocument(_ scan: VNDocumentCameraScan) {
    DispatchQueue.main.async { [weak self] in
      self?.sendEvent(withName: "onScanProgress", body: [
        "status": "processing",
        "message": "Processing scanned document...",
      ])
    }

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self = self else { return }

      var cgImages: [CGImage] = []
      var savedImageUri: String?

      for page in 0..<scan.pageCount {
        let image = scan.imageOfPage(at: page)
        if page == 0 {
          savedImageUri = self.saveImageToTemp(image)
        }

        if let cgImage = image.cgImage {
          cgImages.append(cgImage)
        }
      }

      let recognition = self.recognizeReceipt(in: cgImages)

      DispatchQueue.main.async { [weak self] in
        self?.sendEvent(withName: "onScanProgress", body: [
          "status": "parsing",
          "message": "Extracting receipt items...",
          "textLinesFound": recognition.observations.count,
        ])
      }

      let parsed = ReceiptParserCore.parse(recognition.observations, headerObservations: recognition.headerObservations)
      let payload = self.makePayload(parsed: parsed, observations: recognition.observations, imageUri: savedImageUri)

      DispatchQueue.main.async {
        self.sendEvent(withName: "onScanProgress", body: [
          "status": "complete",
          "message": "Receipt scanned!",
          "itemCount": parsed.items.count,
        ])

        self.scanResolve?(payload)
        self.scanResolve = nil
        self.scanReject = nil
      }
    }
  }

  @available(iOS 13.0, *)
  private func recognizeReceipt(in images: [CGImage]) -> (observations: [(String, CGRect)], headerObservations: [(String, CGRect)]) {
    var observations: [(String, CGRect)] = []
    var headerObservations: [(String, CGRect)] = []

    for (index, cgImage) in images.enumerated() {
      observations.append(
        contentsOf: recognizeTextBlocks(
          in: cgImage,
          minimumTextHeight: 0.012,
          usesLanguageCorrection: false,
          regionOfInterest: nil
        )
      )

      if index == 0 {
        headerObservations = recognizeTextBlocks(
          in: cgImage,
          minimumTextHeight: 0.018,
          usesLanguageCorrection: true,
          regionOfInterest: CGRect(x: 0.0, y: 0.60, width: 1.0, height: 0.34)
        )
      }
    }

    return (observations, headerObservations)
  }

  private func makePayload(
    parsed: ReceiptParserResult,
    observations: [(String, CGRect)],
    imageUri: String?
  ) -> [String: Any] {
    var payload: [String: Any] = [
      "cancelled": false,
      "rawText": observations.map { $0.0 }.joined(separator: "\n"),
      "items": parsed.items.map {
        [
          "name": $0.name,
          "price": $0.price,
          "quantity": $0.quantity,
          "confidence": $0.confidence,
        ]
      },
      "subtotal": parsed.subtotal ?? NSNull(),
      "tax": parsed.tax ?? NSNull(),
      "tip": parsed.tip ?? NSNull(),
      "total": parsed.total ?? NSNull(),
      "merchantName": parsed.merchantName ?? NSNull(),
      "merchantConfidence": parsed.merchantConfidence ?? NSNull(),
      "date": parsed.date ?? NSNull(),
      "parserTelemetry": parsed.telemetry,
    ]

    if let imageUri = imageUri, !imageUri.isEmpty {
      payload["imageUri"] = imageUri
    }

    return payload
  }

  private func loadImage(from imageUri: String) -> UIImage? {
    let trimmedUri = imageUri.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedUri.isEmpty else { return nil }

    if let url = URL(string: trimmedUri), url.isFileURL {
      if let image = UIImage(contentsOfFile: url.path) {
        return image
      }
      if let data = try? Data(contentsOf: url) {
        return UIImage(data: data)
      }
    }

    if let image = UIImage(contentsOfFile: trimmedUri) {
      return image
    }

    return nil
  }

  @available(iOS 13.0, *)
  private func recognizeTextBlocks(
    in cgImage: CGImage,
    minimumTextHeight: Float,
    usesLanguageCorrection: Bool,
    regionOfInterest: CGRect?
  ) -> [(String, CGRect)] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US"]
    request.usesLanguageCorrection = usesLanguageCorrection
    request.minimumTextHeight = minimumTextHeight
    request.customWords = ReceiptParserCore.ocrCustomWords

    if #available(iOS 16.0, *) {
      request.automaticallyDetectsLanguage = false
    }

    if let regionOfInterest = regionOfInterest {
      request.regionOfInterest = regionOfInterest
    }

    do {
      try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
      return (request.results ?? []).compactMap { observation in
        guard let text = self.pickBestTextCandidate(observation) else { return nil }
        return (text, observation.boundingBox)
      }
    } catch {
      NSLog("[VK] OCR error: \(error.localizedDescription)")
      return []
    }
  }

  @available(iOS 13.0, *)
  private func pickBestTextCandidate(_ observation: VNRecognizedTextObservation) -> String? {
    let candidates = observation.topCandidates(3)
    guard !candidates.isEmpty else { return nil }

    var bestText: String?
    var bestScore = -Double.infinity

    for candidate in candidates {
      let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { continue }

      var score = Double(candidate.confidence)
      if text.range(of: #"\$?\s*\d{1,6}\.\d{2}"#, options: .regularExpression) != nil {
        score += 0.08
      }
      if text.filter(\.isLetter).count >= 2 {
        score += 0.03
      }
      if text.contains("|") || text.contains("[") || text.contains("]") {
        score -= 0.05
      }

      if score > bestScore {
        bestScore = score
        bestText = text
      }
    }

    return bestText
  }

  private func saveImageToTemp(_ image: UIImage) -> String? {
    guard let data = image.jpegData(compressionQuality: 0.85) else { return nil }
    let path = (NSTemporaryDirectory() as NSString)
      .appendingPathComponent("receipt_\(Int(Date().timeIntervalSince1970 * 1000)).jpg")

    do {
      try data.write(to: URL(fileURLWithPath: path))
      return URL(fileURLWithPath: path).absoluteString
    } catch {
      return nil
    }
  }

  private func topViewController() -> UIViewController? {
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
          let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else {
      return nil
    }
    return findTopController(root)
  }

  private func findTopController(_ viewController: UIViewController) -> UIViewController {
    if let presented = viewController.presentedViewController {
      return findTopController(presented)
    }
    if let navigationController = viewController as? UINavigationController,
       let top = navigationController.topViewController {
      return findTopController(top)
    }
    if let tabBarController = viewController as? UITabBarController,
       let selected = tabBarController.selectedViewController {
      return findTopController(selected)
    }
    return viewController
  }
}
#endif
