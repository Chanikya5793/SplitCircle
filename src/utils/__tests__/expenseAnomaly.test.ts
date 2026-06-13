/**
 * expenseAnomaly.test.ts — pure duplicate / unusually-large detection.
 */

import { describe, expect, it } from 'vitest';
import type { Expense } from '../../models/expense';
import { detectExpenseAnomalies } from '../expenseAnomaly';

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

const makeExpense = (over: Partial<Expense>, i: number): Expense => ({
  expenseId: `e${i}`,
  groupId: 'g1',
  title: `Expense ${i}`,
  category: 'General',
  amount: 10,
  paidBy: 'u1',
  splitType: 'equal',
  participants: [{ userId: 'u1', share: 10 }],
  settled: false,
  createdAt: NOW - i * DAY,
  updatedAt: NOW - i * DAY,
  ...over,
});

describe('detectExpenseAnomalies', () => {
  it('flags a likely duplicate (same amount, similar title, recent)', () => {
    const history = [makeExpense({ title: 'Dinner at Joe', amount: 42.5, createdAt: NOW - DAY }, 1)];
    const out = detectExpenseAnomalies({ title: 'Dinner at Joe', amount: 42.5, createdAt: NOW }, history);
    expect(out.some((a) => a.type === 'duplicate')).toBe(true);
  });

  it('does not flag a duplicate outside the time window', () => {
    const history = [makeExpense({ title: 'Dinner at Joe', amount: 42.5, createdAt: NOW - 10 * DAY }, 1)];
    const out = detectExpenseAnomalies({ title: 'Dinner at Joe', amount: 42.5, createdAt: NOW }, history);
    expect(out.some((a) => a.type === 'duplicate')).toBe(false);
  });

  it('does not flag a duplicate when titles are dissimilar', () => {
    const history = [makeExpense({ title: 'Groceries', amount: 42.5, createdAt: NOW - DAY }, 1)];
    const out = detectExpenseAnomalies({ title: 'Concert tickets', amount: 42.5, createdAt: NOW }, history);
    expect(out.some((a) => a.type === 'duplicate')).toBe(false);
  });

  it('flags an unusually large amount vs the group median', () => {
    const history = Array.from({ length: 6 }, (_, i) => makeExpense({ amount: 10, title: `Item ${i}` }, i + 1));
    const out = detectExpenseAnomalies({ title: 'Big trip', amount: 80, createdAt: NOW }, history);
    expect(out.some((a) => a.type === 'unusually_large')).toBe(true);
  });

  it('does not flag large with too little history', () => {
    const history = [makeExpense({ amount: 10 }, 1), makeExpense({ amount: 12 }, 2)];
    const out = detectExpenseAnomalies({ title: 'Big', amount: 200, createdAt: NOW }, history);
    expect(out.some((a) => a.type === 'unusually_large')).toBe(false);
  });

  it('excludes the edited expense and ignores invalid amounts', () => {
    const history = [makeExpense({ expenseId: 'self', title: 'Dinner', amount: 42.5, createdAt: NOW }, 1)];
    expect(
      detectExpenseAnomalies({ title: 'Dinner', amount: 42.5, createdAt: NOW, excludeExpenseId: 'self' }, history),
    ).toEqual([]);
    expect(detectExpenseAnomalies({ title: 'Dinner', amount: 0 }, history)).toEqual([]);
  });
});
