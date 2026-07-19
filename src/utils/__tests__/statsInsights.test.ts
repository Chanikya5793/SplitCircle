import { describe, expect, it } from 'vitest';
import type { Expense } from '@/models/expense';
import {
  aggregateRange,
  budgetStatus,
  buildForecast,
  buildHeuristicCards,
  buildPersonalStats,
  categoryTrends,
  dailyHeatmap,
  detectAnomalies,
  memberBreakdown,
  merchantAggregate,
  questionContext,
  rangeWindow,
  settleVelocity,
} from '../statsInsights';

// Fixed "now": 2026-07-15 12:00 local.
const NOW = new Date(2026, 6, 15, 12, 0, 0).getTime();
const DAY = 86400000;

let seq = 0;
const exp = (over: Partial<Expense>): Expense =>
  ({
    expenseId: `e${++seq}`,
    groupId: 'g1',
    title: 'Item',
    category: 'Food',
    amount: 10,
    paidBy: 'u1',
    splitType: 'equal',
    participants: [
      { userId: 'u1', share: 5 },
      { userId: 'u2', share: 5 },
    ],
    settled: false,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    ...over,
  }) as Expense;

describe('rangeWindow', () => {
  it('month window covers the current calendar month', () => {
    const tf = rangeWindow('month', NOW)!;
    expect(new Date(tf.startMs).getMonth()).toBe(6);
    expect(new Date(tf.startMs).getDate()).toBe(1);
  });

  it('quarter spans three calendar months; all is null', () => {
    const tf = rangeWindow('quarter', NOW)!;
    expect(new Date(tf.startMs).getMonth()).toBe(4); // May
    expect(rangeWindow('all', NOW)).toBeNull();
  });
});

describe('aggregateRange', () => {
  it('sums totals and user shares per category inside the window', () => {
    const rows = [
      exp({ amount: 30, participants: [{ userId: 'u1', share: 10 }, { userId: 'u2', share: 20 }] }),
      exp({ amount: 20, category: 'Travel' }),
      exp({ amount: 99, createdAt: NOW - 200 * DAY }), // outside month
      exp({ amount: 50, category: 'settlement' }), // non-spend
    ];
    const agg = aggregateRange(rows, rangeWindow('month', NOW), 'u1');
    expect(agg.total).toBe(50);
    expect(agg.userShare).toBe(15);
    expect(agg.byCategory[0].category).toBe('Food');
  });
});

describe('categoryTrends', () => {
  it('computes deltas vs the previous month and flags new categories with null', () => {
    const lastMonth = new Date(2026, 5, 10).getTime();
    const rows = [
      exp({ amount: 100, createdAt: lastMonth }),
      exp({ amount: 150, createdAt: NOW - DAY }),
      exp({ amount: 40, category: 'Games', createdAt: NOW - DAY }),
    ];
    const trends = categoryTrends(rows, NOW);
    const food = trends.find((t) => t.category === 'Food')!;
    expect(food.deltaPct).toBe(50);
    const games = trends.find((t) => t.category === 'Games')!;
    expect(games.deltaPct).toBeNull();
  });
});

describe('memberBreakdown + fairness', () => {
  it('splits paid vs share and computes payer concentration', () => {
    const members = [
      { userId: 'u1', displayName: 'A' },
      { userId: 'u2', displayName: 'B' },
    ];
    const rows = [
      exp({ amount: 80, participants: [{ userId: 'u1', share: 40 }, { userId: 'u2', share: 40 }] }),
      exp({ amount: 20, paidBy: 'u2', participants: [{ userId: 'u1', share: 10 }, { userId: 'u2', share: 10 }] }),
    ];
    const { rows: out, fairness } = memberBreakdown(rows, members, null);
    expect(out[0]).toMatchObject({ userId: 'u1', paid: 80, share: 50 });
    expect(fairness).toMatchObject({ topPayerId: 'u1', topPayerPct: 80 });
  });
});

describe('merchantAggregate', () => {
  it('groups by normalized title and sums receipt savings', () => {
    const rows = [
      exp({ title: 'Walmart', amount: 40, receipt: { insights: { savings: 5 } } as Expense['receipt'] }),
      exp({ title: 'walmart', amount: 10 }),
      exp({ title: 'Target', amount: 5 }),
    ];
    const { merchants, totalSavings } = merchantAggregate(rows, null);
    expect(merchants[0]).toMatchObject({ name: 'Walmart', total: 50, count: 2, savings: 5 });
    expect(totalSavings).toBe(5);
  });
});

describe('buildForecast', () => {
  it('projects month-end from the month-to-date burn rate', () => {
    const rows = [exp({ amount: 150, createdAt: new Date(2026, 6, 5).getTime() })];
    const f = buildForecast(rows, NOW, 42);
    expect(f.monthToDate).toBe(150);
    expect(f.daysElapsed).toBe(15);
    expect(f.daysInMonth).toBe(31);
    expect(f.projectedTotal).toBe(310);
    expect(f.recurringCommitted).toBe(42);
  });
});

describe('detectAnomalies', () => {
  it('flags a recent expense far above its category baseline', () => {
    const baseline = [1, 2, 3, 4].map((i) =>
      exp({ amount: 10, createdAt: NOW - (20 + i) * DAY }),
    );
    const spike = exp({ expenseId: 'spike', amount: 45, createdAt: NOW - DAY });
    const out = detectAnomalies([...baseline, spike], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ expenseId: 'spike', ratio: 4.5 });
  });

  it('stays silent without enough baseline history', () => {
    const out = detectAnomalies([exp({ amount: 500, createdAt: NOW - DAY })], NOW);
    expect(out).toHaveLength(0);
  });
});

describe('settleVelocity + budgets', () => {
  it('reports days since last settlement and open debts', () => {
    const v = settleVelocity(
      [{ settlementId: 's1', fromUserId: 'u2', toUserId: 'u1', amount: 5, createdAt: NOW - 9 * DAY, status: 'completed' }],
      { u1: 10, u2: -10 },
      NOW,
    );
    expect(v).toMatchObject({ daysSinceLastSettlement: 9, hasOpenDebts: true });
  });

  it('budgetStatus measures month spend against budgets', () => {
    const rows = [exp({ amount: 90, createdAt: NOW - DAY })];
    const status = budgetStatus({ Food: 100 }, rows, NOW);
    expect(status[0]).toMatchObject({ category: 'Food', spent: 90, pct: 90 });
  });
});

describe('buildHeuristicCards', () => {
  it('produces trend, anomaly, budget, fairness, and velocity cards from inputs', () => {
    const cards = buildHeuristicCards({
      trends: [{ category: 'Food', current: 150, previous: 100, deltaPct: 50 }],
      anomalies: [{ expenseId: 'x', title: 'Walmart', category: 'Food', amount: 45, baseline: 10, ratio: 4.5 }],
      forecast: buildForecast([], NOW),
      fairness: { topPayerId: 'u1', topPayerName: 'A', topPayerPct: 80 },
      totalSavings: 12,
      budgets: [{ category: 'Food', budget: 100, spent: 90, pct: 90 }],
      velocity: { daysSinceLastSettlement: 9, hasOpenDebts: true },
      staleDays: 7,
    });
    const kinds = cards.map((c) => c.kind);
    expect(kinds).toContain('trend');
    expect(kinds).toContain('anomaly');
    expect(kinds).toContain('budget');
    expect(kinds).toContain('fairness');
    expect(kinds).toContain('savings');
    expect(kinds).toContain('velocity');
  });
});

describe('dailyHeatmap', () => {
  // NOW is Wed 2026-07-15; the current week starts Sun 2026-07-12.
  it('buckets spends into Sunday-aligned weekday cells', () => {
    const rows = [
      exp({ amount: 12, createdAt: NOW }), // today (Wed → day 3)
      exp({ amount: 8, createdAt: NOW }), // same day accumulates
      exp({ amount: 5, createdAt: new Date(2026, 6, 12, 9).getTime() }), // Sunday this week
      exp({ amount: 7, category: 'settlement', createdAt: NOW }), // non-spend ignored
    ];
    const h = dailyHeatmap(rows, NOW, 12);
    expect(h.todayWeek).toBe(11);
    expect(h.todayDay).toBe(3);
    expect(h.grid[11][3]).toBe(20);
    expect(h.grid[11][0]).toBe(5);
    expect(h.max).toBe(20);
  });

  it('drops spends outside the window and future spends', () => {
    const h = dailyHeatmap(
      [
        exp({ amount: 99, createdAt: NOW - 200 * DAY }),
        exp({ amount: 50, createdAt: NOW + 2 * DAY }),
      ],
      NOW,
      12,
    );
    expect(h.max).toBe(0);
    expect(h.grid).toHaveLength(12);
    expect(h.grid.every((week) => week.every((v) => v === 0))).toBe(true);
  });

  it('labels a week column when it starts a new month', () => {
    const h = dailyHeatmap([], NOW, 12);
    expect(h.monthLabels[0]).not.toBe('');
    expect(h.monthLabels.filter(Boolean).length).toBeGreaterThanOrEqual(3); // ~3 months in 12 weeks
  });
});

describe('questionContext', () => {
  const members = [
    { userId: 'u1', displayName: 'Chanakya T' },
    { userId: 'u2', displayName: 'Rose' },
  ];
  const rows = [
    exp({ amount: 100, createdAt: new Date(2026, 3, 10).getTime() }), // April Food
    exp({ amount: 40, title: 'Walmart', category: 'Shopping', createdAt: NOW - DAY }),
    exp({ amount: 60, category: 'Food', createdAt: NOW - DAY, paidBy: 'u2' }),
  ];

  it('aggregates a named month', () => {
    const out = JSON.parse(questionContext('what about april?', rows, members, NOW)!);
    expect(out.months).toHaveLength(1);
    expect(out.months[0]).toMatchObject({ month: 'April 2026', total: 100 });
  });

  it('returns a monthly trail for a named category', () => {
    const out = JSON.parse(questionContext('why is food so high?', rows, members, NOW)!);
    expect(out.categories[0]).toMatchObject({ category: 'Food', total: 160, count: 2 });
    expect(out.categories[0].byMonth.length).toBeGreaterThan(0);
  });

  it('resolves named members and merchants', () => {
    const out = JSON.parse(
      questionContext('did rose pay for the walmart run?', rows, members, NOW)!,
    );
    expect(out.members[0]).toMatchObject({ name: 'Rose', paid: 60 });
    expect(out.merchants[0]).toMatchObject({ name: 'Walmart', total: 40, count: 1 });
  });

  it('returns null when nothing enrichable is mentioned', () => {
    expect(questionContext('how do we spend less overall?', rows, members, NOW)).toBeNull();
  });
});

describe('buildPersonalStats', () => {
  it('aggregates the user share per group without cross-currency summing', () => {
    const groups = [
      { groupId: 'g1', name: 'Trip', currency: 'USD', expenses: [exp({})] },
      { groupId: 'g2', name: 'Home', currency: 'INR', expenses: [exp({ groupId: 'g2', amount: 200, participants: [{ userId: 'u1', share: 100 }, { userId: 'u2', share: 100 }] })] },
    ];
    const out = buildPersonalStats(groups, 'u1', 'month', NOW);
    expect(out.groups).toHaveLength(2);
    expect(out.groups[0]).toMatchObject({ currency: 'INR', yourShare: 100 });
    expect(out.categoriesByCurrency.USD[0]).toMatchObject({ category: 'Food', yourShare: 5 });
  });
});
