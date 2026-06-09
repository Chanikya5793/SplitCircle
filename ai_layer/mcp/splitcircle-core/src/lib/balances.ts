/**
 * balances.ts — Balance + debt-minimization math for the MCP server.
 *
 * Ported faithfully from the app's src/utils/debtMinimizer.ts so AI-surfaced
 * settlement suggestions match exactly what the app computes (no divergent math).
 * Pure functions — fully unit-tested.
 */

import type { Expense, Settlement } from './types.js';

export interface Debt { from: string; to: string; amount: number }

/** Net balance per user: positive = owed money, negative = owes money. */
export function calculateBalances(
  expenses: Pick<Expense, 'paidBy' | 'participants'>[],
  settlements: Pick<Settlement, 'fromUserId' | 'toUserId' | 'amount'>[] = [],
): Record<string, number> {
  const balances: Record<string, number> = {};

  for (const expense of expenses) {
    const total = expense.participants.reduce((sum, p) => sum + p.share, 0);
    const payerShare = expense.participants.find((p) => p.userId === expense.paidBy)?.share ?? 0;
    balances[expense.paidBy] = (balances[expense.paidBy] || 0) + total - payerShare;
    for (const p of expense.participants) {
      if (p.userId !== expense.paidBy) {
        balances[p.userId] = (balances[p.userId] || 0) - p.share;
      }
    }
  }

  for (const s of settlements) {
    balances[s.fromUserId] = (balances[s.fromUserId] || 0) + s.amount;
    balances[s.toUserId] = (balances[s.toUserId] || 0) - s.amount;
  }

  return balances;
}

/** Greedy debt minimization — minimizes the number of transactions. */
export function minimizeDebts(balances: Record<string, number>): Debt[] {
  const debts: Debt[] = [];
  const debtors: { userId: string; amount: number }[] = [];
  const creditors: { userId: string; amount: number }[] = [];

  for (const [userId, balance] of Object.entries(balances)) {
    if (balance < -0.01) debtors.push({ userId, amount: Math.abs(balance) });
    else if (balance > 0.01) creditors.push({ userId, amount: balance });
  }

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const settle = Math.min(debtor.amount, creditor.amount);
    if (settle > 0.01) {
      debts.push({ from: debtor.userId, to: creditor.userId, amount: Number(settle.toFixed(2)) });
    }
    debtor.amount -= settle;
    creditor.amount -= settle;
    if (debtor.amount < 0.01) i++;
    if (creditor.amount < 0.01) j++;
  }

  return debts;
}

/** Per-member owe/owed view for `get_group_balances`. */
export function toBalanceView(balances: Record<string, number>) {
  return Object.entries(balances).map(([userId, net]) => ({
    userId,
    net: Number(net.toFixed(2)),
    owes: net < 0 ? Number(Math.abs(net).toFixed(2)) : 0,
    isOwed: net > 0 ? Number(net.toFixed(2)) : 0,
  }));
}
