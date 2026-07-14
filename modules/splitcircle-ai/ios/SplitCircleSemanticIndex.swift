import AppIntents
import CoreSpotlight
import Foundation

/// Pushes SplitCircle groups into the Spotlight index so they're findable by name
/// ("Tahoe Trip") from search, from Siri's entity resolution, and (iOS 27) from
/// the semantic index ("that trip with Sarah"). Two tiers:
///
/// - **iOS 16–26: `CSSearchableItem`** — the long-stable API (available since iOS
///   9). Plain keyword indexing; no meaning-based matching.
/// - **iOS 27: `IndexedEntity` + `CSSearchableIndex.indexAppEntities`** — new API
///   from WWDC26 session 343 ("Explore advanced App Intents features"). Feeds the
///   SAME entities into the semantic index so Siri can resolve vaguer references.
///   This half is materially newer/less-proven than the iOS-16 tier above — it has
///   not been through the kind of device spike `ai_layer/docs/17` did for the PCC
///   probe. Treat it as spike-quality until verified the same way.
///
/// **Known gap:** tapping a SplitCircle result in Spotlight currently does nothing
/// useful — there's no confirmed deep-link route into a specific group screen
/// (React Navigation's `linking` config wasn't found wired up when this was
/// written). Wire `CSSearchableItemActionType` handling in AppDelegate's
/// `continue userActivity` once that route exists. Deliberately NOT touched here:
/// that method also carries the CallKit/Recents-redial path (see CLAUDE.md
/// "Gotchas"), which is too load-bearing to extend on a guess.
public enum SplitCircleSemanticIndex {
  private static let domainIdentifier = "com.splitcircle.group"

  /// Re-reads every cached group for the current user and refreshes the index.
  /// Called from `SceneDelegate.sceneDidBecomeActive` (see AppDelegate.swift) —
  /// cheap (local SQLite read + index call), best-effort, never throws outward.
  /// `public`: AppDelegate.swift lives in the app target, a DIFFERENT compiled
  /// module from this pod, and can only see `public` symbols across that boundary
  /// (the same reason `SplitCircleAIModule` below is declared `public class`).
  private static let expenseDomainIdentifier = "com.splitcircle.expense"

  public static func reindexCurrentUserGroups() {
    guard let userId = SplitCircleCurrentUser.read() else { return }
    let groups = SplitCircleIndexReader.groups(forUser: userId)
    guard !groups.isEmpty else { return }

    indexViaCSSearchableItem(groups)

    // Also index recent expenses (the ones already in the snapshot — small, capped)
    // so Siri/Spotlight can find "the dinner expense". Best-effort.
    let expenses = SplitCircleIndexReader.recentExpenses(userId: userId, limit: 50)
    indexExpensesViaCSSearchableItem(expenses)

    #if compiler(>=6.4)
    if #available(iOS 27.0, *) {
      indexViaIndexedEntity(groups)
      indexExpensesViaIndexedEntity(expenses)
    }
    #endif
  }

  private static func indexExpensesViaCSSearchableItem(_ expenses: [SplitCircleIndexReader.ExpenseSummary]) {
    guard !expenses.isEmpty else { return }
    let items = expenses.map { e -> CSSearchableItem in
      let attributes = CSSearchableItemAttributeSet(contentType: .content)
      attributes.title = e.title
      attributes.contentDescription = "\(SplitCircleFormat.money(e.amount, currency: e.currency)) · \(e.category) · \(e.groupName)"
      let item = CSSearchableItem(uniqueIdentifier: "expense:\(e.id)", domainIdentifier: expenseDomainIdentifier, attributeSet: attributes)
      item.expirationDate = .distantFuture
      return item
    }
    CSSearchableIndex.default().indexSearchableItems(items) { error in
      if let error {
        print("[SplitCircleSemanticIndex] expense CSSearchableItem index failed: \(error)")
      }
    }
  }

  private static func indexViaCSSearchableItem(_ groups: [SplitCircleIndexReader.GroupSummary]) {
    let items = groups.map { g -> CSSearchableItem in
      let attributes = CSSearchableItemAttributeSet(contentType: .content)
      attributes.title = g.name
      attributes.contentDescription = g.memberCount > 0 ? "\(g.memberCount) people · SplitCircle group" : "SplitCircle group"
      let item = CSSearchableItem(uniqueIdentifier: "group:\(g.id)", domainIdentifier: domainIdentifier, attributeSet: attributes)
      item.expirationDate = .distantFuture
      return item
    }
    CSSearchableIndex.default().indexSearchableItems(items) { error in
      if let error {
        // Best-effort: Spotlight indexing failing must never affect the app.
        print("[SplitCircleSemanticIndex] CSSearchableItem index failed: \(error)")
      }
    }
  }

  #if compiler(>=6.4)
  @available(iOS 27.0, *)
  private static func indexViaIndexedEntity(_ groups: [SplitCircleIndexReader.GroupSummary]) {
    let entities = groups.map { SplitCircleGroupEntity(id: $0.id, name: $0.name, memberCount: $0.memberCount) }
    Task {
      do {
        try await CSSearchableIndex.default().indexAppEntities(entities)
      } catch {
        print("[SplitCircleSemanticIndex] indexAppEntities failed: \(error)")
      }
    }
  }

  @available(iOS 27.0, *)
  private static func indexExpensesViaIndexedEntity(_ expenses: [SplitCircleIndexReader.ExpenseSummary]) {
    guard !expenses.isEmpty else { return }
    let entities = expenses.map(SplitCircleExpenseEntity.init)
    Task {
      do {
        try await CSSearchableIndex.default().indexAppEntities(entities)
      } catch {
        print("[SplitCircleSemanticIndex] expense indexAppEntities failed: \(error)")
      }
    }
  }
  #endif
}

// MARK: - iOS 27 semantic-index conformance (additive extensions, guarded)

#if compiler(>=6.4)
@available(iOS 27.0, *)
extension SplitCircleGroupEntity: IndexedEntity {}
#endif
