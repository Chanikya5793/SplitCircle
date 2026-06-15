/**
 * writeIdempotency.ts — pure dedup helpers for the offline-capable money writes.
 *
 * `addExpense`/`settleUp` used `runTransaction` to read-modify-write the group's
 * array; transactions need a server round-trip, so they fail entirely offline.
 * The offline-capable path uses `arrayUnion` (queues offline, merges server-side)
 * and replaces the transactional existence check with these in-memory checks
 * against the locally-cached group state, so a retried/double-submitted write
 * with the same id or requestId is a no-op instead of a duplicate.
 *
 * Pure module (no Firestore/RN imports) — unit-tested.
 */

interface ExpenseLike {
  expenseId: string;
  requestId?: string;
}

interface SettlementLike {
  settlementId: string;
  requestId?: string;
}

/**
 * Find an already-present expense matching this id or requestId, if any.
 * Mirrors the old transaction's existence check so idempotency is preserved
 * without a server read.
 */
export function findDuplicateExpense<T extends ExpenseLike>(
  expenses: readonly T[] | undefined,
  expenseId: string,
  requestId?: string,
): T | undefined {
  return (expenses ?? []).find(
    (e) => e.expenseId === expenseId || (!!requestId && e.requestId === requestId),
  );
}

/** Find an already-present settlement matching this id or requestId, if any. */
export function findDuplicateSettlement<T extends SettlementLike>(
  settlements: readonly T[] | undefined,
  settlementId: string,
  requestId?: string,
): T | undefined {
  return (settlements ?? []).find(
    (s) => s.settlementId === settlementId || (!!requestId && s.requestId === requestId),
  );
}
