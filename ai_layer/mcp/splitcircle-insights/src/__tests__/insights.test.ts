/**
 * insights.test.ts — Unit tests for aggregation helpers + insights tools.
 * Uses a fake Analytics; no BigQuery/Gemini required.
 */

import { describe, it, expect } from 'vitest';
import {
  summarize, comparePeriods, findAnomalies, contributionAnalysis, periodWindow,
  forecastHeadline,
  type ExpenseRow, type GroupExpense,
} from '../lib/aggregate.js';
import type { Analytics } from '../lib/analytics.js';
import {
  getSpendingSummary, compareSpendingPeriods, findUnusualExpenses,
  askAboutSpending, getGroupContributionAnalysis, getSpendingForecast,
} from '../tools/index.js';

function row(p: Partial<ExpenseRow> & { userShare: number; category: string; createdAtMs: number }): ExpenseRow {
  return {
    expenseId: Math.random().toString(36).slice(2), groupId: 'g1', title: 't',
    amount: p.userShare, currency: '$', paidBy: 'u1', ...p,
  } as ExpenseRow;
}

describe('aggregate helpers', () => {
  it('summarize totals + by-category', () => {
    const s = summarize([
      row({ userShare: 10, category: 'food', createdAtMs: 1 }),
      row({ userShare: 5, category: 'food', createdAtMs: 2 }),
      row({ userShare: 20, category: 'transport', createdAtMs: 3 }),
    ]);
    expect(s.total).toBe(35);
    expect(s.byCategory.food).toBe(15);
    expect(s.topExpenses[0].userShare).toBe(20);
  });

  it('comparePeriods computes delta + trend', () => {
    const prev = [row({ userShare: 100, category: 'food', createdAtMs: 1 })];
    const curr = [row({ userShare: 150, category: 'food', createdAtMs: 2 })];
    const c = comparePeriods(prev, curr);
    expect(c.delta).toBe(50);
    expect(c.deltaPercent).toBe(50);
    expect(c.trend).toBe('up');
  });

  it('findAnomalies flags an outlier above category baseline', () => {
    const rows = [
      row({ userShare: 10, category: 'food', createdAtMs: 1 }),
      row({ userShare: 11, category: 'food', createdAtMs: 2 }),
      row({ userShare: 9, category: 'food', createdAtMs: 3 }),
      row({ userShare: 10, category: 'food', createdAtMs: 4 }),
      row({ userShare: 200, category: 'food', createdAtMs: 5 }),
    ];
    const a = findAnomalies(rows);
    expect(a).toHaveLength(1);
    expect(a[0].expense.userShare).toBe(200);
  });

  it('findAnomalies ignores categories with too few samples', () => {
    expect(findAnomalies([
      row({ userShare: 5, category: 'rare', createdAtMs: 1 }),
      row({ userShare: 500, category: 'rare', createdAtMs: 2 }),
    ])).toHaveLength(0);
  });

  it('contributionAnalysis: paid vs owed vs fair', () => {
    const expenses: GroupExpense[] = [
      { expenseId: 'e1', amount: 30, paidBy: 'a', participants: [{ userId: 'a', share: 10 }, { userId: 'b', share: 10 }, { userId: 'c', share: 10 }] },
    ];
    const rows = contributionAnalysis(expenses, ['a', 'b', 'c']);
    const a = rows.find((r) => r.userId === 'a')!;
    expect(a.totalPaid).toBe(30);
    expect(a.totalOwed).toBe(10);
    expect(a.fairShare).toBe(10);
    expect(a.delta).toBe(20); // creditor
  });

  it('periodWindow returns a sane window', () => {
    const w = periodWindow('week', 1_000_000_000);
    expect(w.end - w.start).toBe(7 * 86_400_000);
  });

  it('forecastHeadline summarizes the next month, or says when there is no history', () => {
    expect(forecastHeadline([{ month: '2026-07', predicted: 120, lower: 90, upper: 150 }])).toContain('2026-07');
    expect(forecastHeadline([])).toMatch(/not enough history/i);
  });
});

// ── Tool-level tests with a fake Analytics ────────────────────────────────────
function fakeAnalytics(over: Partial<Analytics> = {}): Analytics {
  return {
    getUserRows: async () => [row({ userShare: 10, category: 'food', createdAtMs: Date.now() })],
    getGroupExpenses: async () => ({
      memberIds: ['a', 'b'],
      currency: '$',
      expenses: [{ expenseId: 'e1', amount: 20, paidBy: 'a', participants: [{ userId: 'a', share: 10 }, { userId: 'b', share: 10 }] }],
    }),
    ask: async (_uid, q) => ({ answer: `answer to ${q}`, sources: [] }),
    generateInsight: async () => 'You spent a bit more on food.',
    forecastSpending: async () => [{ month: '2026-07', predicted: 120, lower: 90, upper: 150 }],
    ...over,
  };
}

describe('insights tools', () => {
  const ctx = (analytics: Analytics) => ({ uid: 'a', analytics });

  it('get_spending_summary returns a total + trend', async () => {
    const r = await getSpendingSummary.handler({ period: 'month' } as any, ctx(fakeAnalytics()));
    expect((r.data as any).total).toBe(10);
    expect((r.data as any).trend).toBeDefined();
  });

  it('compare_spending_periods returns an NL insight', async () => {
    const r = await compareSpendingPeriods.handler({ period: 'month' } as any, ctx(fakeAnalytics()));
    expect(r.text).toContain('food');
  });

  it('find_unusual_expenses returns anomalies array', async () => {
    const many = Array.from({ length: 5 }, (_, i) => row({ userShare: i === 4 ? 300 : 10, category: 'food', createdAtMs: i }));
    const r = await findUnusualExpenses.handler({ lookbackDays: 30 } as any, ctx(fakeAnalytics({ getUserRows: async () => many })));
    expect((r.data as any).anomalies.length).toBe(1);
  });

  it('ask_about_spending delegates to RAG', async () => {
    const r = await askAboutSpending.handler({ question: 'food?' } as any, ctx(fakeAnalytics()));
    expect(r.text).toContain('answer to food?');
  });

  it('get_group_contribution_analysis returns members', async () => {
    const r = await getGroupContributionAnalysis.handler({ groupId: 'g1' } as any, ctx(fakeAnalytics()));
    expect((r.data as any).members).toHaveLength(2);
  });

  it('get_spending_forecast returns points + a headline', async () => {
    const r = await getSpendingForecast.handler({} as any, ctx(fakeAnalytics()));
    expect((r.data as any).forecast).toHaveLength(1);
    expect(r.text).toContain('2026-07');
    expect(r.text).toContain('120');
  });

  it('propagates membership errors from analytics', async () => {
    const denied = fakeAnalytics({ getGroupExpenses: async () => { throw new Error('Not a member of this group'); } });
    await expect(getGroupContributionAnalysis.handler({ groupId: 'g1' } as any, ctx(denied)))
      .rejects.toThrow(/Not a member/);
  });
});
