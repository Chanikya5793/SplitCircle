/**
 * notificationEntityMatch.ts — pure logic for withdrawing stale notifications.
 *
 * When a group, expense, or settlement is deleted, delivered notifications
 * that deep-link to it become dead ends. This module holds the RN-free logic:
 * matching a push payload against entity ids, and diffing two snapshots of
 * known entity ids to find what disappeared. Kept free of expo/react-native
 * imports so it can be unit-tested in the pure node suite.
 */

export interface EntityNotificationFilter {
  groupId?: string;
  expenseId?: string;
  settlementId?: string;
  chatId?: string;
}

/**
 * True when the notification payload references any of the given entity ids.
 * A single match is enough: a deleted group should clear every notification
 * referencing it (expenses, settlements, joins, messages).
 */
export const notificationMatchesEntity = (
  data: Record<string, unknown> | null | undefined,
  filter: EntityNotificationFilter,
): boolean => {
  if (!data) return false;
  return Boolean(
    (filter.groupId && data.groupId === filter.groupId) ||
    (filter.expenseId && data.expenseId === filter.expenseId) ||
    (filter.settlementId && data.settlementId === filter.settlementId) ||
    (filter.chatId && data.chatId === filter.chatId),
  );
};

/** Snapshot of the entity ids inside one group, used to detect remote deletions. */
export interface GroupEntityIds {
  expenseIds: Set<string>;
  settlementIds: Set<string>;
}

/**
 * Compares the previous server snapshot with the current one and returns one
 * filter per entity that disappeared: whole groups (deleted, or this user
 * removed) and individual expenses/settlements removed from surviving groups.
 */
export const diffRemovedEntities = (
  previous: Map<string, GroupEntityIds>,
  current: Map<string, GroupEntityIds>,
): EntityNotificationFilter[] => {
  const removed: EntityNotificationFilter[] = [];

  for (const [groupId, prevIds] of previous) {
    const currentIds = current.get(groupId);
    if (!currentIds) {
      removed.push({ groupId });
      continue;
    }
    for (const expenseId of prevIds.expenseIds) {
      if (!currentIds.expenseIds.has(expenseId)) {
        removed.push({ expenseId });
      }
    }
    for (const settlementId of prevIds.settlementIds) {
      if (!currentIds.settlementIds.has(settlementId)) {
        removed.push({ settlementId });
      }
    }
  }

  return removed;
};
