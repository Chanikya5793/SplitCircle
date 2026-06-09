/**
 * recommender.test.ts — MODEL-05 smart split recommender.
 */

import { describe, it, expect } from 'vitest';
import { recommendSplit, equalSplit, type PastSplit } from '../recommender';

const sum = (ps: { share: number }[]) => Number(ps.reduce((s, p) => s + p.share, 0).toFixed(2));

describe('equalSplit', () => {
  it('splits evenly and sums to the exact amount (remainder on last)', () => {
    const parts = equalSplit(['a', 'b', 'c'], 10);
    expect(sum(parts)).toBe(10);
    expect(parts[0].share).toBe(3.33);
    expect(parts[2].share).toBe(3.34);
  });
});

describe('recommendSplit', () => {
  it('falls back to an equal split with low confidence when there is no history', () => {
    const rec = recommendSplit({ participants: ['a', 'b'], amount: 50 }, []);
    expect(rec.basis).toBe('equal');
    expect(rec.method).toBe('equal');
    expect(sum(rec.participants)).toBe(50);
    expect(rec.confidence).toBeLessThan(0.5);
  });

  it('recalls the usual method + share ratios for the same set of people and scales to the new amount', () => {
    const history: PastSplit[] = [
      { method: 'shares', participants: [{ userId: 'a', share: 70 }, { userId: 'b', share: 30 }] },
      { method: 'shares', participants: [{ userId: 'a', share: 35 }, { userId: 'b', share: 15 }] }, // same 70/30 ratio
    ];
    const rec = recommendSplit({ participants: ['a', 'b'], amount: 200 }, history);
    expect(rec.basis).toBe('history');
    expect(rec.method).toBe('shares');
    expect(rec.matchedOn).toBe('participants');
    expect(sum(rec.participants)).toBe(200);
    const a = rec.participants.find((p) => p.userId === 'a')!;
    expect(a.share).toBeCloseTo(140, 1); // 70%
    expect(rec.confidence).toBeGreaterThan(0.5);
  });

  it('prefers same-category history when available', () => {
    const history: PastSplit[] = [
      { method: 'equal', category: 'food', participants: [{ userId: 'a', share: 1 }, { userId: 'b', share: 1 }] },
      { method: 'percentage', category: 'rent', participants: [{ userId: 'a', share: 80 }, { userId: 'b', share: 20 }] },
    ];
    const rec = recommendSplit({ participants: ['a', 'b'], amount: 100, category: 'rent' }, history);
    expect(rec.matchedOn).toBe('category');
    expect(rec.method).toBe('percentage');
    expect(rec.participants.find((p) => p.userId === 'a')!.share).toBeCloseTo(80, 1);
  });

  it('ignores history with a different set of participants', () => {
    const history: PastSplit[] = [
      { method: 'shares', participants: [{ userId: 'a', share: 90 }, { userId: 'c', share: 10 }] },
    ];
    const rec = recommendSplit({ participants: ['a', 'b'], amount: 100 }, history);
    expect(rec.basis).toBe('equal');
  });

  it('handles empty participants safely', () => {
    expect(recommendSplit({ participants: [], amount: 10 }, [])).toMatchObject({ participants: [], confidence: 0 });
  });
});
