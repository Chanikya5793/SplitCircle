/**
 * expensePlan.test.ts — plan → canonical question, and that the deterministic
 * engine actually answers those canonical questions (the RAG retrieve step).
 */

import { describe, expect, it } from 'vitest';
import type { Expense } from '../../models/expense';
import type { Settlement } from '../../models/group';
import { planToQuestion, type QueryPlan } from '../expensePlan';
import { answerExpenseQuery, type QueryContext } from '../expenseQuery';

describe('planToQuestion', () => {
  const cases: [QueryPlan, string][] = [
    [{ intent: 'spend', scope: 'me', category: 'Food', timeframe: 'last_month' }, 'how much did I spend on Food last month'],
    [{ intent: 'spend', scope: 'group' }, 'how much did we spend'],
    [{ intent: 'spend', scope: 'Bob', category: 'Transport' }, 'how much did Bob spend on Transport'],
    [{ intent: 'balance', member: 'Bob' }, 'how much do I owe Bob'],
    [{ intent: 'settle_up' }, 'show our settle-up'],
    [{ intent: 'biggest', timeframe: 'this_month' }, 'what were the biggest expenses this month'],
    [{ intent: 'who_most', metric: 'paid' }, 'who paid the most'],
    [{ intent: 'leaderboard', metric: 'share' }, 'how much has each person spent'],
    [{ intent: 'breakdown', scope: 'me' }, 'my spending by category'],
    [{ intent: 'summary', timeframe: 'last_month' }, 'summarize last month'],
    [{ intent: 'trend' }, 'spending by month'],
    [{ intent: 'unknown' }, ''],
  ];
  it.each(cases)('renders %o', (plan, expected) => {
    expect(planToQuestion(plan)).toBe(expected);
  });
});

// End-to-end: a plan's canonical question must be handled by the engine.
describe('plan → answerExpenseQuery is handled', () => {
  const exp = (over: Partial<Expense>): Expense => ({
    expenseId: Math.random().toString(36).slice(2),
    groupId: 'g1', title: 'X', category: 'Food', amount: 10, paidBy: 'u1',
    splitType: 'equal', participants: [{ userId: 'u1', share: 10 }], settled: false,
    createdAt: Date.UTC(2026, 4, 15), updatedAt: Date.UTC(2026, 4, 15), ...over,
  });
  const ctx: QueryContext = {
    expenses: [exp({ category: 'Food', amount: 100, participants: [{ userId: 'u1', share: 50 }, { userId: 'u2', share: 50 }] })],
    settlements: [] as Settlement[],
    members: [{ userId: 'u1', displayName: 'Alice' }, { userId: 'u2', displayName: 'Bob' }],
    currentUserId: 'u1',
    currency: 'USD',
    now: Date.UTC(2026, 5, 14),
  };

  const plans: QueryPlan[] = [
    { intent: 'spend', scope: 'me', category: 'Food' },
    { intent: 'balance', member: 'Bob' },
    { intent: 'settle_up' },
    { intent: 'biggest' },
    { intent: 'who_most', metric: 'paid' },
    { intent: 'breakdown' },
    { intent: 'summary' },
  ];
  it.each(plans)('handles %o', (plan) => {
    const r = answerExpenseQuery(planToQuestion(plan), ctx);
    expect(r.handled).toBe(true);
  });
});
