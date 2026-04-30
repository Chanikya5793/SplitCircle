import type { Group } from '@/models';
import { calculateBalancesFromExpenses } from './debtMinimizer';

export type CurrencyAmount = { currency: string; amount: number };

/**
 * Compute net balance between `me` and every other user across all `groups`.
 * Result is keyed by other-user id and grouped by currency, so the UI can
 * render multi-currency owe/owed states honestly without coercing to USD.
 *
 * Convention: positive = the other user owes me; negative = I owe them.
 */
export function computeFriendBalances(
  me: string,
  groups: Group[],
): Record<string, CurrencyAmount[]> {
  const out: Record<string, Record<string, number>> = {};

  for (const group of groups) {
    const expenses = (group.expenses ?? []) as Array<{
      paidBy: string;
      participants: { userId: string; share: number }[];
    }>;
    const settlements = (group.settlements ?? []) as Array<{
      fromUserId: string;
      toUserId: string;
      amount: number;
    }>;
    const currency = group.currency || 'USD';

    if (expenses.length === 0 && settlements.length === 0) continue;

    const balances = calculateBalancesFromExpenses(expenses, settlements);
    const myBalance = balances[me] ?? 0;

    // For each other member, attribute a slice of the net balance proportional
    // to their share of the opposite-side balances. This gives a stable
    // pairwise approximation; for exact pair-wise debt the user can open the
    // group's settlement view, which already does the per-pair minimization.
    const oppositeSign = myBalance > 0 ? -1 : 1;
    const pool = Object.entries(balances)
      .filter(([uid, bal]) => uid !== me && Math.sign(bal) === oppositeSign && Math.abs(bal) > 0.01);
    const totalOpposite = pool.reduce((sum, [, bal]) => sum + Math.abs(bal), 0);
    if (Math.abs(myBalance) < 0.01 || totalOpposite === 0) continue;

    for (const [otherUid, otherBal] of pool) {
      const slice = (Math.abs(otherBal) / totalOpposite) * myBalance;
      if (Math.abs(slice) < 0.01) continue;
      out[otherUid] = out[otherUid] ?? {};
      out[otherUid][currency] = (out[otherUid][currency] ?? 0) + slice;
    }
  }

  // Materialize into the public shape, dropping near-zero entries.
  const result: Record<string, CurrencyAmount[]> = {};
  for (const [uid, byCurrency] of Object.entries(out)) {
    const list = Object.entries(byCurrency)
      .filter(([, amount]) => Math.abs(amount) >= 0.01)
      .map(([currency, amount]) => ({ currency, amount }));
    if (list.length > 0) result[uid] = list;
  }
  return result;
}
