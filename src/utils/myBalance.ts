// "What do I owe / what am I owed" — computed ON DEVICE from data already in
// memory. Pure module: no RN, no Firebase, no network (see the vitest unit
// suite convention).
//
// WHY LOCAL. Every input is already synced into the Group objects that
// GroupContext holds — expenses and settlements are the same arrays the
// group screens already render. So a balance is arithmetic over data we have,
// not a question to ask a server. Reading `members[].balance` off Firestore
// instead would add a dependency on a server-maintained field for a number we
// can derive exactly, and it would be stale for any expense added offline and
// not yet pushed. This derives from the ledger itself, so it is correct the
// moment an expense is created, online or off.
//
// MULTI-CURRENCY. Groups have their own currencies and there is no honest way
// to add ₹ to $ without a rate, so totals are kept PER CURRENCY and never
// coerced. Deliberately no conversion here: rates are a network concern and
// a wrong total is worse than two lines of text.

import { calculateBalancesFromExpenses } from './debtMinimizer';

export interface CurrencyTotal {
  currency: string;
  /** Positive = you are owed. Negative = you owe. */
  amount: number;
}

interface BalanceGroupLike {
  currency?: string;
  expenses?: { paidBy: string; participants: { userId: string; share: number }[] }[];
  settlements?: { fromUserId: string; toUserId: string; amount: number }[];
}

/** Below this, treat as settled — floating-point dust from split rounding. */
export const SETTLED_EPSILON = 0.01;

/**
 * Net position for `me` in one group, in that group's own currency.
 * Positive = owed to you, negative = you owe, ~0 = settled up.
 */
export const computeMyGroupBalance = (me: string | undefined, group: BalanceGroupLike): number => {
  if (!me) return 0;
  const balances = calculateBalancesFromExpenses(group.expenses ?? [], group.settlements ?? []);
  const value = balances[me] ?? 0;
  return Math.abs(value) < SETTLED_EPSILON ? 0 : value;
};

/**
 * Net position across every group, split by currency. Groups where you are
 * settled contribute nothing; a currency that nets to zero is dropped, so
 * "settled up" is an EMPTY array rather than a list of zeroes.
 */
export const computeOverallBalance = (
  me: string | undefined,
  groups: BalanceGroupLike[],
): CurrencyTotal[] => {
  if (!me) return [];
  const totals = new Map<string, number>();
  for (const group of groups) {
    const net = computeMyGroupBalance(me, group);
    if (net === 0) continue;
    const currency = group.currency || 'USD';
    totals.set(currency, (totals.get(currency) ?? 0) + net);
  }
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .filter((t) => Math.abs(t.amount) >= SETTLED_EPSILON)
    // Biggest exposure first — that is what someone opening the app wants.
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
};

/**
 * Splits totals into what you're owed and what you owe.
 *
 * Kept SEPARATE rather than netted into one number: owing ₹500 while being
 * owed ₹500 is not the same situation as being settled, and collapsing it
 * would hide both facts.
 */
export const splitOwedAndOwing = (totals: CurrencyTotal[]) => ({
  owed: totals.filter((t) => t.amount > 0),
  owing: totals.filter((t) => t.amount < 0).map((t) => ({ ...t, amount: Math.abs(t.amount) })),
});
