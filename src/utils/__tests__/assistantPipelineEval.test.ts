/**
 * assistantPipelineEval.test.ts — the doc-17 screenshot failures, encoded as a
 * regression suite over the DETERMINISTIC layer (the parts that run with no
 * model, on every device). Each case pins the behavior that was broken:
 *
 *   #1 "Hello"                        → greeting, NOT a settle-up dump
 *   #2 "Clear the chat"               → clear_chat, NOT a spend total
 *   #3 "Aprils total?"                → April window, NOT all-time
 *   #4 "what about the month before"  → previous month, resolved from memory
 *
 * The abstaining router + grounded model paths are native-only and validated
 * on-device; this suite guards the logic that gates them.
 */

import { describe, expect, it } from 'vitest';
import { detectMetaCommand } from '../assistantChat';
import { parseTimeframe } from '../expenseAnalytics';
import { followUpPlanToQuestion, inferPlanFromQuestion, resolveFollowUp } from '../assistantFollowUp';
import { answerExpenseQuery, type QueryContext } from '../expenseQuery';
import type { Expense } from '../../models/expense';

const NOW = new Date('2026-07-19T12:00:00Z').getTime();
const members = [
  { userId: 'u1', displayName: 'You' },
  { userId: 'u2', displayName: 'Six' },
];

const mkExpense = (monthIso: string, amount: number, category = 'Food'): Expense => ({
  expenseId: `e-${monthIso}-${amount}`,
  groupId: 'g1',
  title: `${category} ${monthIso}`,
  category,
  amount,
  paidBy: 'u1',
  splitType: 'equal',
  participants: [
    { userId: 'u1', share: amount / 2 },
    { userId: 'u2', share: amount / 2 },
  ],
  settled: false,
  createdAt: new Date(monthIso).getTime(),
  updatedAt: 0,
});

const ctx: QueryContext = {
  expenses: [
    mkExpense('2026-03-15', 100),
    mkExpense('2026-04-10', 200),
    mkExpense('2026-04-20', 40, 'Transport'),
    mkExpense('2026-07-01', 60),
  ],
  settlements: [],
  members,
  currentUserId: 'u1',
  currency: 'USD',
  now: NOW,
};

describe('#1 greeting is not an expense query', () => {
  it('"Hello" is a greeting', () => {
    expect(detectMetaCommand('Hello')).toBe('greeting');
  });
});

describe('#2 chat-control is not an expense query', () => {
  it('"Clear the chat" is clear_chat', () => {
    expect(detectMetaCommand('Clear the chat')).toBe('clear_chat');
  });
});

describe('#3 "Aprils total?" scopes to April', () => {
  it('parses the April window', () => {
    const tf = parseTimeframe('Aprils total?', NOW);
    expect(tf?.label).toBe('in April');
  });

  it('answers with only April expenses (200 + 40 = 240), not all-time', () => {
    const r = answerExpenseQuery('how much did we spend in April', ctx);
    expect(r.handled).toBe(true);
    expect(r.answer).toContain('240.00');
    expect(r.answer).not.toContain('400.00'); // all-time total
  });
});

describe('#4 "what about the month before that?" follows April → March', () => {
  it('remembers the April query, then answers for March (100)', () => {
    // Turn 1: the April question is answered and remembered as a plan.
    const last = inferPlanFromQuestion('how much did we spend in April', members, NOW);
    expect(last.timeframe).toBe('april');

    // Turn 2: the fragment resolves against that memory.
    const merged = resolveFollowUp('what about the month before that?', last, members, NOW);
    expect(merged?.timeframe).toBe('march');

    const canonical = followUpPlanToQuestion(merged!, NOW);
    const r = answerExpenseQuery(canonical, ctx);
    expect(r.handled).toBe(true);
    expect(r.answer).toContain('100.00');
    expect(r.answer).not.toContain('240.00'); // April's number must not leak
  });
});

describe('follow-up category swap keeps the timeframe', () => {
  it('"and for transport?" after April → April Transport (40)', () => {
    const last = inferPlanFromQuestion('how much did we spend in April', members, NOW);
    const merged = resolveFollowUp('and for transport?', last, members, NOW);
    expect(merged).toMatchObject({ category: 'Transport', timeframe: 'april' });
    const r = answerExpenseQuery(followUpPlanToQuestion(merged!, NOW), ctx);
    expect(r.answer).toContain('40.00');
  });
});
