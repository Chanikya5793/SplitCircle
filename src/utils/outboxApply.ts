/**
 * outboxApply.ts — pure logic for the on-device write outbox (durable offline
 * write queue). The Firebase JS SDK is memory-cache-only on React Native, so a
 * write made offline is lost if the app is killed before reconnecting. We mirror
 * each create into a persistent outbox (services/outbox) and replay it on launch
 * / reconnect; this module holds the pure pieces (types + merge) so they're
 * unit-testable with no RN/native imports.
 */

import type { Expense } from '../models/expense';
import type { Group, Settlement } from '../models/group';

/** A durable, replayable write. Idempotent on replay (arrayUnion + requestId). */
export type OutboxOp =
  | {
      id: string;
      kind: 'addExpense';
      groupId: string;
      expense: Expense;
      /** Local receipt image to upload at flush time (may be gone after relaunch). */
      fileUri?: string;
      fileName?: string;
      createdAt: number;
      attempts?: number;
    }
  | {
      id: string;
      kind: 'settleUp';
      groupId: string;
      settlement: Settlement;
      createdAt: number;
      attempts?: number;
    };

/** True if this expense (by id or requestId) is already in the list. */
const hasExpense = (expenses: readonly Expense[], e: Expense): boolean =>
  expenses.some((x) => x.expenseId === e.expenseId || (!!e.requestId && x.requestId === e.requestId));

/** True if this settlement (by id or requestId) is already in the list. */
const hasSettlement = (settlements: readonly Settlement[], s: Settlement): boolean =>
  settlements.some((x) => x.settlementId === s.settlementId || (!!s.requestId && x.requestId === s.requestId));

/**
 * Merge pending outbox ops into groups so optimistic (not-yet-synced) writes
 * stay visible — both for offline display and during the online window before a
 * write is acknowledged by the server. Operates on RAW group data (call
 * adaptGroup afterwards to recompute balances). Ops are appended only if not
 * already present (dedup by id/requestId), so re-merging is safe.
 */
export function mergeOutboxIntoGroups(groups: Group[], ops: readonly OutboxOp[]): Group[] {
  if (!ops.length) return groups;
  return groups.map((g) => {
    const groupOps = ops.filter((o) => o.groupId === g.groupId);
    if (!groupOps.length) return g;

    let expenses = g.expenses ?? [];
    let settlements = g.settlements ?? [];
    let changed = false;

    for (const op of groupOps) {
      if (op.kind === 'addExpense' && !hasExpense(expenses, op.expense)) {
        expenses = [...expenses, op.expense];
        changed = true;
      } else if (op.kind === 'settleUp' && !hasSettlement(settlements, op.settlement)) {
        settlements = [...settlements, op.settlement];
        changed = true;
      }
    }

    return changed ? { ...g, expenses, settlements } : g;
  });
}
