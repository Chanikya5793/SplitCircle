import Foundation
import CoreGraphics

struct FixtureObservation: Decodable {
  let text: String
  let rect: [Double]

  var parsedRect: CGRect {
    CGRect(x: rect[0], y: rect[1], width: rect[2], height: rect[3])
  }
}

struct FixtureExpectations: Decodable {
  let merchant: String?
  let merchantConfidenceAtLeast: Double?
  let itemCount: Int?
  let itemNames: [String]?
  let absentItemNames: [String]?
  let subtotal: Double?
  let tax: Double?
  let total: Double?
}

struct ReceiptParserFixture: Decodable {
  let name: String
  let observations: [FixtureObservation]
  let headerObservations: [FixtureObservation]?
  let expect: FixtureExpectations
}

enum HarnessError: Error, CustomStringConvertible {
  case usage
  case fixtureValidation(String)

  var description: String {
    switch self {
    case .usage:
      return "Usage: receipt_parser_regression <fixtures.json>"
    case .fixtureValidation(let message):
      return message
    }
  }
}

private func approxEqual(_ lhs: Double?, _ rhs: Double?, tolerance: Double = 0.02) -> Bool {
  guard let lhs, let rhs else { return lhs == nil && rhs == nil }
  return abs(lhs - rhs) <= tolerance
}

private func loadFixtures(from path: String) throws -> [ReceiptParserFixture] {
  let data = try Data(contentsOf: URL(fileURLWithPath: path))
  return try JSONDecoder().decode([ReceiptParserFixture].self, from: data)
}

private func validate(fixture: ReceiptParserFixture) throws {
  let parsed = ReceiptParserCore.parse(
    fixture.observations.map { ($0.text, $0.parsedRect) },
    headerObservations: (fixture.headerObservations ?? []).map { ($0.text, $0.parsedRect) }
  )

  if let expectedMerchant = fixture.expect.merchant, parsed.merchantName != expectedMerchant {
    throw HarnessError.fixtureValidation(
      "[\(fixture.name)] expected merchant '\(expectedMerchant)', got '\(parsed.merchantName ?? "nil")'"
    )
  }

  if let minConfidence = fixture.expect.merchantConfidenceAtLeast,
     (parsed.merchantConfidence ?? 0) < minConfidence {
    throw HarnessError.fixtureValidation(
      "[\(fixture.name)] expected merchant confidence >= \(minConfidence), got \(parsed.merchantConfidence ?? -1)"
    )
  }

  if let itemCount = fixture.expect.itemCount, parsed.items.count != itemCount {
    throw HarnessError.fixtureValidation(
      "[\(fixture.name)] expected \(itemCount) items, got \(parsed.items.count) (\(parsed.items.map(\.name).joined(separator: ", ")))"
    )
  }

  if let expectedNames = fixture.expect.itemNames {
    let actualNames = Set(parsed.items.map(\.name))
    for name in expectedNames where !actualNames.contains(name) {
      throw HarnessError.fixtureValidation(
        "[\(fixture.name)] missing expected item '\(name)'; got \(Array(actualNames).sorted())"
      )
    }
  }

  if let absentNames = fixture.expect.absentItemNames {
    let actualNames = Set(parsed.items.map(\.name))
    for name in absentNames where actualNames.contains(name) {
      throw HarnessError.fixtureValidation(
        "[\(fixture.name)] unexpected item '\(name)' present"
      )
    }
  }

  if let subtotal = fixture.expect.subtotal, !approxEqual(parsed.subtotal, subtotal) {
    throw HarnessError.fixtureValidation(
      "[\(fixture.name)] expected subtotal \(subtotal), got \(parsed.subtotal ?? -1)"
    )
  }

  if let tax = fixture.expect.tax, !approxEqual(parsed.tax, tax) {
    throw HarnessError.fixtureValidation(
      "[\(fixture.name)] expected tax \(tax), got \(parsed.tax ?? -1)"
    )
  }

  if let total = fixture.expect.total, !approxEqual(parsed.total, total) {
    throw HarnessError.fixtureValidation(
      "[\(fixture.name)] expected total \(total), got \(parsed.total ?? -1)"
    )
  }
}

@main
struct ReceiptParserRegressionRunner {
  static func main() throws {
    guard CommandLine.arguments.count >= 2 else {
      throw HarnessError.usage
    }

    let fixtures = try loadFixtures(from: CommandLine.arguments[1])
    for fixture in fixtures {
      try validate(fixture: fixture)
      print("PASS \(fixture.name)")
    }
    print("All \(fixtures.count) receipt parser fixtures passed.")
  }
}
