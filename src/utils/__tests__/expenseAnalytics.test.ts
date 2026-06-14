/**
 * expenseAnalytics.test.ts — deterministic index + timeframe parsing.
 */

import { describe, expect, it } from 'vitest';
import type { Expense } from '../../models/expense';
import type { Settlement } from '../../models/group';
import {
  analyticsSignature,
  buildExpenseAnalytics,
  calendarWindow,
  clearAnalyticsCache,
  comparisonWindows,
  getGroupAnalytics,
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

describe('memoized index (cache)', () => {
  it('caches by signature and recomputes when data changes', () => {
    clearAnalyticsCache();
    const e1 = exp({ amount: 100, participants: [{ userId: 'u1', share: 100 }] });
    const group = { groupId: 'g1', expenses: [e1], settlements: [], updatedAt: 1 };

    const a1 = getGroupAnalytics(group, 'u1');
    const a2 = getGroupAnalytics(group, 'u1');
    expect(a2).toBe(a1); // same reference → served from cache

    const group2 = { ...group, expenses: [e1, exp({ amount: 50, participants: [{ userId: 'u1', share: 50 }] })] };
    const a3 = getGroupAnalytics(group2, 'u1');
    expect(a3).not.toBe(a1); // signature changed → recomputed
    expect(a3.totalSpend).toBe(150);
  });

  it('signature changes with count, updatedAt, settlements', () => {
    const base = { groupId: 'g', expenses: [exp({ updatedAt: 10 })], settlements: [], updatedAt: 5 };
    const sig = analyticsSignature(base);
    expect(analyticsSignature({ ...base, updatedAt: 6 })).not.toBe(sig);
    expect(analyticsSignature({ ...base, expenses: [...base.expenses, exp({})] })).not.toBe(sig);
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

describe('comparison windows', () => {
  const now = Date.UTC(2026, 5, 14); // 2026-06-14

  it('calendarWindow for this/last month', () => {
    expect(new Date(calendarWindow(now, 'month', 0).startMs).getUTCMonth()).toBe(5); // June
    expect(new Date(calendarWindow(now, 'month', -1).startMs).getUTCMonth()).toBe(4); // May
  });

  it('comparisonWindows month: current vs previous are adjacent, non-overlapping', () => {
    const { current, previous } = comparisonWindows(now, 'month');
    expect(current.label).toBe('this month');
    expect(previous.label).toBe('last month');
    expect(previous.endMs).toBeLessThan(current.startMs);
  });

  it('comparisonWindows week: two rolling 7-day windows', () => {
    const { current, previous } = comparisonWindows(now, 'week');
    expect(current.endMs - current.startMs).toBe(7 * 86400000);
    expect(previous.endMs).toBe(current.startMs);
  });
});
