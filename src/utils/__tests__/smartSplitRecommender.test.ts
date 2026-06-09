/**
 * smartSplitRecommender.test.ts — on-device "split like last time" (MODEL-05
 * port) + the adapter from the app's Expense model.
 */

import { describe, it, expect } from 'vitest';
import {
  recommendSplit,
  equalSplit,
  buildSplitHistory,
  type PastSplit,
} from '../smartSplitRecommender';
import type { Expense } from '../../models/expense';

const sum = (ps: { share: number }[]) => Number(ps.reduce((s, p) => s + p.share, 0).toFixed(2));

describe('equalSplit', () => {
  it('splits evenly and sums exactly (remainder on last)', () => {
    const parts = equalSplit(['a', 'b', 'c'], 10);
    expect(sum(parts)).toBe(10);
    expect(parts.map((p) => p.share)).toEqual([3.33, 3.33, 3.34]);
  });
});

describe('recommendSplit', () => {
  it('falls back to equal with low confidence when there is no history', () => {
    const rec = recommendSplit({ participants: ['a', 'b'], amount: 50 }, []);
    expect(rec.basis).toBe('equal');
    expect(sum(rec.participants)).toBe(50);
    expect(rec.confidence).toBeLessThan(0.5);
  });

  it('recalls the usual method + ratios for the same people, scaled to the new amount', () => {
    const history: PastSplit[] = [
      { method: 'shares', participants: [{ userId: 'a', share: 70 }, { userId: 'b', share: 30 }] },
      { method: 'shares', participants: [{ userId: 'a', share: 35 }, { userId: 'b', share: 15 }] },
    ];
    const rec = recommendSplit({ participants: ['a', 'b'], amount: 200 }, history);
    expect(rec.basis).toBe('history');
    expect(rec.method).toBe('shares');
    expect(rec.participants.find((p) => p.userId === 'a')!.share).toBeCloseTo(140, 1);
    expect(sum(rec.participants)).toBe(200);
  });

  it('prefers same-category history', () => {
    const history: PastSplit[] = [
      { method: 'equal', category: 'food', participants: [{ userId: 'a', share: 1 }, { userId: 'b', share: 1 }] },
      { method: 'percentage', category: 'rent', participants: [{ userId: 'a', share: 80 }, { userId: 'b', share: 20 }] },
    ];
    const rec = recommendSplit({ participants: ['a', 'b'], amount: 100, category: 'rent' }, history);
    expect(rec.matchedOn).toBe('category');
    expect(rec.method).toBe('percentage');
  });

  it('ignores history with a different participant set', () => {
    const history: PastSplit[] = [
      { method: 'shares', participants: [{ userId: 'a', share: 90 }, { userId: 'c', share: 10 }] },
    ];
    expect(recommendSplit({ participants: ['a', 'b'], amount: 100 }, history).basis).toBe('equal');
  });
});

describe('buildSplitHistory (Expense adapter)', () => {
  it('maps splitMetadata.method, category, and participant shares; falls back to splitType', () => {
    const expenses = [
      {
        expenseId: 'e1', groupId: 'g1', title: 'Rent', category: 'rent', amount: 100,
        paidBy: 'a', splitType: 'custom', settled: false, createdAt: 1, updatedAt: 1,
        participants: [{ userId: 'a', share: 80 }, { userId: 'b', share: 20 }],
        splitMetadata: { version: 1, method: 'percentage', participantConfig: [] },
      },
      {
        expenseId: 'e2', groupId: 'g1', title: 'Dinner', category: 'food', amount: 30,
        paidBy: 'b', splitType: 'equal', settled: false, createdAt: 2, updatedAt: 2,
        participants: [{ userId: 'a', share: 15 }, { userId: 'b', share: 15 }],
      },
      { // no participants — dropped
        expenseId: 'e3', groupId: 'g1', title: 'X', category: 'misc', amount: 1,
        paidBy: 'a', splitType: 'equal', settled: false, createdAt: 3, updatedAt: 3,
        participants: [],
      },
    ] as unknown as Expense[];

    const history = buildSplitHistory(expenses);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ method: 'percentage', category: 'rent' });
    expect(history[1].method).toBe('equal'); // splitType fallback
    expect(history[0].participants).toEqual([{ userId: 'a', share: 80 }, { userId: 'b', share: 20 }]);
  });

  it('feeds recommendSplit end-to-end ("split rent like last time")', () => {
    const expenses = [
      {
        expenseId: 'e1', groupId: 'g1', title: 'Rent', category: 'rent', amount: 100,
        paidBy: 'a', splitType: 'custom', settled: false, createdAt: 1, updatedAt: 1,
        participants: [{ userId: 'a', share: 80 }, { userId: 'b', share: 20 }],
        splitMetadata: { version: 1, method: 'percentage', participantConfig: [] },
      },
    ] as unknown as Expense[];

    const rec = recommendSplit(
      { participants: ['a', 'b'], amount: 1200, category: 'rent' },
      buildSplitHistory(expenses),
    );
    expect(rec.method).toBe('percentage');
    expect(rec.participants.find((p) => p.userId === 'a')!.share).toBeCloseTo(960, 1);
    expect(sum(rec.participants)).toBe(1200);
  });
});
