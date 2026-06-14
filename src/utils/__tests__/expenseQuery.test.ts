/**
 * expenseQuery.test.ts — deterministic answers for the failing screenshot cases.
 * These are the regression tests for "AI gets it wrong 99% of the time".
 */

import { describe, expect, it } from 'vitest';
import type { Expense } from '../../models/expense';
import type { Settlement } from '../../models/group';
import { answerExpenseQuery, type QueryContext } from '../expenseQuery';

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

const members = [
  { userId: 'u1', displayName: 'Alice' },
  { userId: 'u2', displayName: 'Bob' },
];

const ctx = (expenses: Expense[], settlements: Settlement[] = []): QueryContext => ({
  expenses,
  settlements,
  members,
  currentUserId: 'u1',
  currency: 'USD',
  now: Date.UTC(2026, 5, 14),
});

describe('category spend (the wrong-math screenshots)', () => {
  const food = [
    exp({ title: 'Sky deck restaurant', category: 'Food', amount: 250, participants: [{ userId: 'u1', share: 125 }, { userId: 'u2', share: 125 }] }),
    exp({ title: 'Street food', category: 'Food', amount: 100, participants: [{ userId: 'u1', share: 50 }, { userId: 'u2', share: 50 }] }),
    exp({ title: 'Gas', category: 'Transport', amount: 40, participants: [{ userId: 'u1', share: 20 }, { userId: 'u2', share: 20 }] }),
  ];

  it('answers "how much did I spend on food" with the user share, exactly', () => {
    const r = answerExpenseQuery('How much did I spend on food?', ctx(food));
    expect(r.handled).toBe(true);
    expect(r.confidence).toBe(1);
    expect(r.answer).toContain('You spent 175.00 USD on Food'); // 125 + 50
    expect(r.answer).toContain('2 expenses');
    expect(r.sources).toHaveLength(2);
    expect(r.sources.every((s) => s.category === 'Food')).toBe(true); // never cites non-food
  });

  it('answers group spend (no "I") with the category total', () => {
    const r = answerExpenseQuery('how much did we spend on food', ctx(food));
    expect(r.answer).toContain('The group spent 350.00 USD on Food'); // 250 + 100
  });

  it('says zero cleanly when the category has no expenses', () => {
    const r = answerExpenseQuery('how much did I spend on travel', ctx(food));
    expect(r.handled).toBe(true);
    expect(r.answer).toContain('No Travel expenses');
    expect(r.sources).toHaveLength(0);
  });
});

describe('balances & settlements (the hallucination screenshots)', () => {
  const expenses = [
    exp({ amount: 100, paidBy: 'u1', participants: [{ userId: 'u1', share: 50 }, { userId: 'u2', share: 50 }] }),
  ];

  it('"how much do I owe" reflects the real balance (here: owed money)', () => {
    const r = answerExpenseQuery('How much do I owe right now?', ctx(expenses));
    expect(r.handled).toBe(true);
    expect(r.answer).toContain("You're owed 50.00 USD");
    expect(r.answer).toContain('Bob owes you 50.00 USD');
  });

  it('"show our settlements" returns the real settle-up plan, not expense dumps', () => {
    const r = answerExpenseQuery('Show our settlements', ctx(expenses));
    expect(r.handled).toBe(true);
    expect(r.answer).toContain('Suggested settle-up');
    expect(r.answer).toContain('Bob → You: 50.00 USD');
    expect(r.sources).toHaveLength(0);
  });

  it('reports all-settled when balances are zero', () => {
    const settled: Settlement[] = [
      { settlementId: 's', fromUserId: 'u2', toUserId: 'u1', amount: 50, createdAt: 1, status: 'completed' },
    ];
    const r = answerExpenseQuery('are we settled up?', ctx(expenses, settled));
    expect(r.answer).toContain('all settled up');
  });
});

describe('biggest / total / count / summary', () => {
  const expenses = [
    exp({ title: 'Hotel', category: 'Travel', amount: 999.99, participants: [{ userId: 'u1', share: 999.99 }] }),
    exp({ title: 'Coffee', category: 'Food', amount: 5, participants: [{ userId: 'u1', share: 5 }] }),
    exp({ title: 'Cab', category: 'Transport', amount: 25, participants: [{ userId: 'u1', share: 25 }] }),
  ];

  it('biggest expenses are ranked correctly', () => {
    const r = answerExpenseQuery('what were our biggest expenses?', ctx(expenses));
    expect(r.answer).toContain('1. Hotel — 999.99 USD');
    expect(r.sources[0].title).toBe('Hotel');
  });

  it('total spending is exact', () => {
    const r = answerExpenseQuery('how much did we spend in total?', ctx(expenses));
    expect(r.answer).toContain('Total spending is 1029.99 USD');
  });

  it('counts expenses', () => {
    const r = answerExpenseQuery('how many expenses are there?', ctx(expenses));
    expect(r.answer).toContain('are 3 expenses');
  });

  it('summarizes with totals + top categories', () => {
    const r = answerExpenseQuery('summarize our spending', ctx(expenses));
    expect(r.answer).toContain('3 expenses totaling 1029.99 USD');
    expect(r.answer).toContain('Travel 999.99');
  });
});

describe('fallthrough', () => {
  it('returns handled:false for open-ended questions', () => {
    const r = answerExpenseQuery('why is Bob always late to pay?', ctx([exp({ amount: 10 })]));
    expect(r.handled).toBe(false);
  });

  it('returns handled:false for an empty question', () => {
    expect(answerExpenseQuery('   ', ctx([])).handled).toBe(false);
  });
});
