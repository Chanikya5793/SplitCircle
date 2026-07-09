/**
 * aiIndexStatus.ts — pure summary of what the on-device AI has indexed, for the
 * Settings transparency view. The "index" is the deterministic analytics built
 * from each group's local data and persisted in SQLite (see `aiIndexStore`);
 * this reports counts + whether each group has a FRESH persisted index. No
 * RN/native imports (unit-tested) — the caller passes in the set of freshly
 * indexed keys derived from the store.
 */

export interface GroupIndexStatus {
  groupId: string;
  name: string;
  expenseCount: number;
  settlementCount: number;
  /** True when this group has a fresh index in the persistent store. */
  cached: boolean;
}

export interface IndexStatus {
  groups: GroupIndexStatus[];
  totalGroups: number;
  totalExpenses: number;
  totalSettlements: number;
}

interface IndexableGroup {
  groupId: string;
  name: string;
  expenses?: unknown[];
  settlements?: unknown[];
}

/** Build the on-device index status from the user's groups + the cache keys. */
export function buildIndexStatus(
  groups: readonly IndexableGroup[],
  currentUserId: string,
  cachedKeys: ReadonlySet<string>,
): IndexStatus {
  const gs: GroupIndexStatus[] = (groups ?? []).map((g) => ({
    groupId: g.groupId,
    name: g.name,
    expenseCount: g.expenses?.length ?? 0,
    settlementCount: g.settlements?.length ?? 0,
    cached: cachedKeys.has(`${g.groupId}:${currentUserId}`),
  }));
  return {
    groups: gs,
    totalGroups: gs.length,
    totalExpenses: gs.reduce((s, g) => s + g.expenseCount, 0),
    totalSettlements: gs.reduce((s, g) => s + g.settlementCount, 0),
  };
}
