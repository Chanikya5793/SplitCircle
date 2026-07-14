import AppIntents
import Foundation

/// A member of one of the user's ManaSplit groups — the "who's in the split"
/// participant picker for the headless Add Expense intent. Backed by the same
/// on-disk snapshot as everything else (SplitCircleIndexReader), so Siri can offer
/// real group members WITHOUT launching the app.
///
/// `id` encodes `"<groupId>::<userId>"` so a chosen person unambiguously maps back
/// to both its group and its user id. The query is a UNION across all the user's
/// groups (App Intents entity queries don't reliably receive sibling parameter
/// values across every intent that reuses this entity, so we filter to the chosen
/// group at `perform` time instead of trying to scope the query). The group name is
/// shown as the subtitle to disambiguate same-named members across groups.
///
/// `public` for the same cross-module-visibility reason as the other entities here
/// (see the note atop SplitCircleEntities.swift).
@available(iOS 16.0, *)
public struct SplitCirclePersonEntity: AppEntity {
  public let id: String        // "<groupId>::<userId>"
  public let name: String
  public let groupName: String

  public init(id: String, name: String, groupName: String) {
    self.id = id
    self.name = name
    self.groupName = groupName
  }

  /// The group this person belongs to (prefix of `id` before "::").
  public var groupId: String {
    guard let r = id.range(of: "::") else { return id }
    return String(id[id.startIndex..<r.lowerBound])
  }

  /// The user id (suffix of `id` after "::").
  public var userId: String {
    guard let r = id.range(of: "::") else { return id }
    return String(id[r.upperBound...])
  }

  public static var typeDisplayRepresentation: TypeDisplayRepresentation = "Group Member"

  public var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)", subtitle: groupName.isEmpty ? nil : "\(groupName)")
  }

  public static var defaultQuery = SplitCirclePersonQuery()
}

@available(iOS 16.0, *)
public struct SplitCirclePersonQuery: EntityQuery {
  public init() {}

  private func all() -> [SplitCirclePersonEntity] {
    guard let userId = SplitCircleCurrentUser.read() else { return [] }
    return SplitCircleIndexReader.allPeople(forUser: userId).map {
      SplitCirclePersonEntity(id: $0.personId, name: $0.name, groupName: $0.groupName)
    }
  }

  public func entities(for identifiers: [String]) async throws -> [SplitCirclePersonEntity] {
    let wanted = Set(identifiers)
    return all().filter { wanted.contains($0.id) }
  }

  public func suggestedEntities() async throws -> [SplitCirclePersonEntity] {
    all()
  }
}

@available(iOS 16.0, *)
extension SplitCirclePersonQuery: EntityStringQuery {
  /// Lets Siri resolve a spoken member name ("split it with Sarah").
  public func entities(matching string: String) async throws -> [SplitCirclePersonEntity] {
    let needle = string.lowercased()
    return all().filter { $0.name.lowercased().contains(needle) }
  }
}
