/**
 * onDeviceAiContext.test.ts — ranking, formatting, and citation-resolution for
 * the on-device Foundation Models context builder. Pure logic, no RN runtime.
 */

import { describe, expect, it } from 'vitest';
import type { Expense } from '../../models/expense';
import {
  MAX_CONTEXT_EXPENSES,
  buildExpenseContext,
  rankExpenses,
  resolveCitedExpenses,
} from '../onDeviceAiContext';

const members = [
  { userId: 'u1', displayName: 'Alice' },
  { userId: 'u2', displayName: 'Bob' },
];

const makeExpense = (overrides: Partial<Expense>, i: number): Expense => ({
  expenseId: `e${i}`,
  groupId: 'g1',
  title: `Expense ${i}`,
  category: 'General',
  amount: 10,
  paidBy: 'u1',
  splitType: 'equal',
  participants: [
    { userId: 'u1', share: 5 },
    { userId: 'u2', share: 5 },
  ],
  settled: false,
  createdAt: 1_700_000_000_000 + i * 86_400_000,
  updatedAt: 1_700_000_000_000 + i * 86_400_000,
  ...overrides,
});

describe('rankExpenses', () => {
  it('prefers keyword matches over recency', () => {
    const expenses = [
      makeExpense({ title: 'Sushi dinner', category: 'Food' }, 0),
      ...Array.from({ length: 45 }, (_, i) => makeExpense({ title: 'Gas refill', category: 'Transport' }, i + 1)),
    ];
    const ranked = rankExpenses(expenses, 'how much did we spend on sushi?', members);
    expect(ranked[0].title).toBe('Sushi dinner');
    expect(ranked).toHaveLength(MAX_CONTEXT_EXPENSES);
  });

  it('falls back to most-recent-first when nothing matches', () => {
    const expenses = Array.from({ length: 50 }, (_, i) => makeExpense({}, i));
    const ranked = rankExpenses(expenses, 'zzz unrelated', members);
    expect(ranked[0].expenseId).toBe('e49'); // newest
    expect(ranked).toHaveLength(MAX_CONTEXT_EXPENSES);
  });

  it('matches on payer display name', () => {
    const expenses = [
      makeExpense({ title: 'Taxi', paidBy: 'u2' }, 0),
      ...Array.from({ length: 10 }, (_, i) => makeExpense({ paidBy: 'u1' }, i + 1)),
    ];
    const ranked = rankExpenses(expenses, 'what did Bob pay for?', members);
    expect(ranked[0].paidBy).toBe('u2');
  });
});

describe('buildExpenseContext', () => {
  it('renders chronological numbered lines with payer names and currency', () => {
    const expenses = [
      makeExpense({ title: 'Dinner', category: 'Food', amount: 42.5, paidBy: 'u1' }, 1),
      makeExpense({ title: 'Taxi', category: 'Transport', amount: 18, paidBy: 'u2', settled: true }, 0),
    ];
    const { context, selected } = buildExpenseContext(expenses, 'spending?', members, 'USD');
    const lines = context.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[1\] \d{4}-\d{2}-\d{2} \| Taxi \| Transport \| 18\.00 USD \| paid by Bob \| split between 2 \| settled$/);
    expect(lines[1]).toContain('[2]');
    expect(lines[1]).toContain('Dinner');
    expect(lines[1]).toContain('paid by Alice');
    // selected[i] backs line [i+1]
    expect(selected[0].title).toBe('Taxi');
    expect(selected[1].title).toBe('Dinner');
  });

  it('handles an empty group', () => {
    const { context, selected } = buildExpenseContext([], 'anything', members, 'USD');
    expect(context).toBe('');
    expect(selected).toHaveLength(0);
  });

  it('truncates very long titles', () => {
    const longTitle = 'A'.repeat(80);
    const { context } = buildExpenseContext([makeExpense({ title: longTitle }, 0)], 'q', members, 'USD');
    expect(context).toContain(`${'A'.repeat(48)}…`);
    expect(context).not.toContain('A'.repeat(49));
  });
});

describe('resolveCitedExpenses', () => {
  const selected = [makeExpense({}, 0), makeExpense({}, 1), makeExpense({}, 2)];

  it('maps valid 1-based indexes and drops junk', () => {
    const cited = resolveCitedExpenses([2, 99, 0, -1, 2.5, 1, 2], selected);
    expect(cited.map((e) => e.expenseId)).toEqual(['e1', 'e0']); // dedup keeps first occurrence order
  });

  it('returns empty for no citations', () => {
    expect(resolveCitedExpenses([], selected)).toEqual([]);
  });
});
