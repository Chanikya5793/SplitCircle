import AppIntents
import Foundation

/// `AppEntity` for a SplitCircle group. Backed entirely by `SplitCircleIndexReader`
/// (the on-disk SQLite mirror `aiIndexStore.ts` writes) so entity resolution works
/// headless — Siri can resolve "the Tahoe trip group" WITHOUT launching the app or
/// the JS runtime. AppEntity/AppIntent/AppShortcutsProvider have been stable since
/// iOS 16, so this baseline (unlike the iOS-27-only additions in
/// SplitCircleSemanticIndex.swift) targets the app's existing deployment floor.
///
/// `public`: this pod (`SplitCircleAI`) compiles as a separate Swift module from
/// the app target. App Intents declared `internal` (Swift's default) in a
/// dependency module are a well-documented cause of "the shortcut just doesn't
/// show up" — the metadata extractor needs public visibility to reliably surface
/// conformances that live outside the main app module. Every AppEntity/AppIntent/
/// AppShortcutsProvider type in this file and SplitCircleIntents.swift is public
/// for that reason; that reliability claim itself is unverified without a real
/// device build (see AI_ARCHITECTURE.md).
@available(iOS 17.0, *)
public struct SplitCircleGroupEntity: AppEntity {
  public let id: String
  public let name: String
  public let memberCount: Int

  public init(id: String, name: String, memberCount: Int) {
    self.id = id
    self.name = name
    self.memberCount = memberCount
  }

  public static var typeDisplayRepresentation: TypeDisplayRepresentation = "ManaSplit Group"

  public var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(
      title: "\(name)",
      subtitle: memberCount > 0 ? "\(memberCount) people" : nil
    )
  }

  public static var defaultQuery = SplitCircleGroupQuery()
}

/// Resolves `SplitCircleGroupEntity` values for Siri/Shortcuts parameter pickers
/// and for `entities(for:)` lookups by id. Reads the CURRENT user's groups — see
/// `SplitCircleCurrentUser` below for how a headless process learns who's signed in.
@available(iOS 17.0, *)
public struct SplitCircleGroupQuery: EntityQuery {
  public init() {}

  public func entities(for identifiers: [String]) async throws -> [SplitCircleGroupEntity] {
    guard let userId = SplitCircleCurrentUser.read() else { return [] }
    let all = SplitCircleIndexReader.groups(forUser: userId)
    let wanted = Set(identifiers)
    return all.filter { wanted.contains($0.id) }.map {
      SplitCircleGroupEntity(id: $0.id, name: $0.name, memberCount: $0.memberCount)
    }
  }

  public func suggestedEntities() async throws -> [SplitCircleGroupEntity] {
    guard let userId = SplitCircleCurrentUser.read() else { return [] }
    return SplitCircleIndexReader.groups(forUser: userId)
      .prefix(10)
      .map { SplitCircleGroupEntity(id: $0.id, name: $0.name, memberCount: $0.memberCount) }
  }
}

@available(iOS 17.0, *)
extension SplitCircleGroupQuery: EntityStringQuery {
  /// Powers Siri saying a group name out loud ("what do I owe in Tahoe Trip") and
  /// Spotlight's plain-text search over groups, without a semantic index.
  public func entities(matching string: String) async throws -> [SplitCircleGroupEntity] {
    guard let userId = SplitCircleCurrentUser.read() else { return [] }
    let needle = string.lowercased()
    return SplitCircleIndexReader.groups(forUser: userId)
      .filter { $0.name.lowercased().contains(needle) }
      .map { SplitCircleGroupEntity(id: $0.id, name: $0.name, memberCount: $0.memberCount) }
  }
}

/// The signed-in user's id, mirrored to `UserDefaults.standard` for headless native
/// reads — the SAME bridge pattern the app already uses for `RNThemeIsDark` and
/// `PrivacyGuardEnabled` (see AppDelegate.swift / SceneDelegate). Written by
/// `AuthContext.tsx`'s `onAuthStateChanged` handler on every sign-in/out via
/// `Settings.set({ SplitCircleCurrentUserId: uid | '' })`. Internal (not public):
/// only consumed from within this module (SplitCircleEntities/Intents/
/// SemanticIndex), never from the app target directly.
enum SplitCircleCurrentUser {
  static func read() -> String? {
    guard let uid = UserDefaults.standard.string(forKey: "SplitCircleCurrentUserId"), !uid.isEmpty else {
      return nil
    }
    return uid
  }
}
