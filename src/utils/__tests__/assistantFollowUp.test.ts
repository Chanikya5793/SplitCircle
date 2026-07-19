/**
 * assistantFollowUp.test.ts — conversational memory on the Q&A path. A remembered
 * plan + a follow-up fragment ("what about April?", "the month before that",
 * "and for food?", "what about Sam?") must merge into the changed dimension and
 * re-render as a canonical question. Deterministic clock: 2026-07-19.
 */

import { describe, expect, it } from 'vitest';
import {
  followUpPlanToQuestion,
  inferPlanFromQuestion,
  resolveFollowUp,
  resolvePreviousPeriodToken,
  timeframeLabelToToken,
} from '../assistantFollowUp';
import type { QueryPlan } from '../expensePlan';

const NOW = new Date('2026-07-19T12:00:00Z').getTime();
const members = [
  { userId: 'u1', displayName: 'You' },
  { userId: 'u2', displayName: 'Sam' },
  { userId: 'u3', displayName: 'Priya' },
];

const spendGroup: QueryPlan = { intent: 'spend', scope: 'group', timeframe: 'april' };

describe('resolveFollowUp', () => {
  it('swaps the timeframe on "what about May?"', () => {
    const merged = resolveFollowUp('what about May?', spendGroup, members, NOW);
    expect(merged).toMatchObject({ intent: 'spend', scope: 'group', timeframe: 'may' });
  });

  it('resolves "the month before that" against the last timeframe', () => {
    const merged = resolveFollowUp('what about the month before that?', spendGroup, members, NOW);
    expect(merged?.timeframe).toBe('march');
  });

  it('swaps the category on "and for food?"', () => {
    const merged = resolveFollowUp('and for food?', spendGroup, members, NOW);
    expect(merged).toMatchObject({ category: 'Food', timeframe: 'april' });
  });

  it('swaps the person on "what about Sam?"', () => {
    const merged = resolveFollowUp('what about Sam?', spendGroup, members, NOW);
    expect(merged?.scope).toBe('Sam');
  });

  it('routes a member follow-up to `member` for balance questions', () => {
    const balance: QueryPlan = { intent: 'balance', scope: 'me' };
    const merged = resolveFollowUp('what about Priya?', balance, members, NOW);
    expect(merged?.member).toBe('Priya');
  });

  it('returns null for a full new question (not a fragment)', () => {
    expect(
      resolveFollowUp('how much did the whole group spend on travel last year in total', spendGroup, members, NOW),
    ).toBeNull();
  });

  it('returns null when there is nothing to anchor to', () => {
    expect(resolveFollowUp('what about April?', null, members, NOW)).toBeNull();
    expect(resolveFollowUp('what about April?', { intent: 'unknown' }, members, NOW)).toBeNull();
  });
});

describe('followUpPlanToQuestion', () => {
  it('renders a month-shifted follow-up into a canonical question', () => {
    const merged = resolveFollowUp('what about the month before that?', spendGroup, members, NOW)!;
    expect(followUpPlanToQuestion(merged, NOW)).toBe('how much did we spend in March');
  });

  it('renders a category swap', () => {
    const merged = resolveFollowUp('and for food?', spendGroup, members, NOW)!;
    expect(followUpPlanToQuestion(merged, NOW)).toBe('how much did we spend on Food in April');
  });
});

describe('resolvePreviousPeriodToken', () => {
  it('gives the previous month token', () => {
    expect(resolvePreviousPeriodToken('april', NOW)).toBe('march');
  });
  it('resolves the month before "this month" to the concrete previous month', () => {
    // NOW is July → the month before this month is June.
    expect(resolvePreviousPeriodToken('this_month', NOW)).toBe('june');
  });
});

describe('timeframeLabelToToken', () => {
  it('round-trips month labels', () => {
    expect(timeframeLabelToToken('in April')).toBe('april');
    expect(timeframeLabelToToken('in April 2025')).toBe('april_2025');
  });
  it('maps relative labels', () => {
    expect(timeframeLabelToToken('last month')).toBe('last_month');
    expect(timeframeLabelToToken('this year')).toBe('this_year');
  });
});

describe('inferPlanFromQuestion', () => {
  it('captures intent + scope + timeframe from a raw question', () => {
    const plan = inferPlanFromQuestion('how much did I spend on food last month', members, NOW);
    expect(plan).toMatchObject({ intent: 'spend', scope: 'me', category: 'Food', timeframe: 'last_month' });
  });

  it('captures a balance question with a member', () => {
    const plan = inferPlanFromQuestion('how much do I owe Sam', members, NOW);
    expect(plan.intent).toBe('balance');
  });
});
