/**
 * expenseAnalytics.test.ts — deterministic index + timeframe parsing.
 */

import { describe, expect, it } from 'vitest';
import type { Expense } from '../../models/expense';
import type { Settlement } from '../../models/group';
import {
  buildExpenseAnalytics,
  monthKey,
  parseTimeframe,
  sumTotal,
  sumUserShare,
  userShareOf,
} from '../expenseAnalytics';

const exp = (over: Partial<Expense>): Expense => ({
  expenseId: Math.random().toString(36).slice(2),
  groupId: 'g1',
  title: 'X',
  category: 'General',
  amount: 0,
  paidBy: 'u1',
  splitType: 'equal',
  participants: [],
  settled: false,
  createdAt: Date.UTC(2026, 4, 15),
  updatedAt: Date.UTC(2026, 4, 15),
  ...over,
});

describe('buildExpenseAnalytics', () => {
  it('computes totals, per-category, per-user share, and balances exactly', () => {
    const expenses: Expense[] = [
      exp({ category: 'Food', amount: 100, paidBy: 'u1', participants: [{ userId: 'u1', share: 50 }, { userId: 'u2', share: 50 }] }),
      exp({ category: 'Food', amount: 60, paidBy: 'u2', participants: [{ userId: 'u1', share: 30 }, { userId: 'u2', share: 30 }] }),
      exp({ category: 'Transport', amount: 40, paidBy: 'u1', participants: [{ userId: 'u1', share: 20 }, { userId: 'u2', share: 20 }] }),
    ];
    const a = buildExpenseAnalytics(expenses, [], 'u1');
    expect(a.count).toBe(3);
    expect(a.totalSpend).toBe(200);
    expect(a.userShareTotal).toBe(100); // 50+30+20
    expect(a.userPaidTotal).toBe(140); // 100 + 40
    expect(a.byCategory[0]).toMatchObject({ category: 'Food', total: 160, userShare: 80, count: 2 });
    // u1 paid 140, owes share 100 → net +40; u2 paid 60, owes 100 → net -40
    expect(a.userBalance).toBe(40);
    expect(a.balances.u2).toBe(-40);
    expect(a.debts).toEqual([{ from: 'u2', to: 'u1', amount: 40 }]);
  });

  it('excludes the synthetic "settlement" category from spend but keeps balances', () => {
    const expenses: Expense[] = [
      exp({ category: 'Food', amount: 100, participants: [{ userId: 'u1', share: 100 }] }),
      exp({ category: 'Settlement', amount: 999, participants: [{ userId: 'u1', share: 999 }] }),
    ];
    const a = buildExpenseAnalytics(expenses, [], 'u1');
    expect(a.totalSpend).toBe(100); // settlement excluded from spend
    expect(a.count).toBe(1);
  });

  it('applies recorded settlements to balances', () => {
    const expenses: Expense[] = [
      exp({ amount: 100, paidBy: 'u1', participants: [{ userId: 'u1', share: 50 }, { userId: 'u2', share: 50 }] }),
    ];
    const settlements: Settlement[] = [
      { settlementId: 's1', fromUserId: 'u2', toUserId: 'u1', amount: 50, createdAt: 1, status: 'completed' },
    ];
    const a = buildExpenseAnalytics(expenses, settlements, 'u1');
    expect(a.userBalance).toBe(0); // u2 paid u1 back
  });
});

describe('helpers', () => {
  it('userShareOf and sums', () => {
    const e = exp({ amount: 30, participants: [{ userId: 'u1', share: 10 }, { userId: 'u2', share: 20 }] });
    expect(userShareOf(e, 'u1')).toBe(10);
    expect(userShareOf(e, 'zzz')).toBe(0);
    expect(sumTotal([e])).toBe(30);
    expect(sumUserShare([e], 'u2')).toBe(20);
  });

  it('monthKey buckets by calendar month', () => {
    expect(monthKey(Date.UTC(2026, 0, 5))).toBe('2026-01');
    expect(monthKey(Date.UTC(2026, 11, 31))).toBe('2026-12');
  });
});

describe('parseTimeframe', () => {
  const now = Date.UTC(2026, 5, 14); // 2026-06-14

  it('parses last month / this month windows', () => {
    const last = parseTimeframe('summarize last month', now)!;
    expect(last.label).toBe('last month');
    expect(new Date(last.startMs).getUTCMonth()).toBe(4); // May
    expect(new Date(last.endMs).getUTCMonth()).toBe(4);

    const thisM = parseTimeframe('what about this month', now)!;
    expect(new Date(thisM.startMs).getUTCMonth()).toBe(5); // June
  });

  it('returns null when no timeframe is mentioned', () => {
    expect(parseTimeframe('how much on food', now)).toBeNull();
  });
});
