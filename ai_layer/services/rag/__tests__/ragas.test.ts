/**
 * ragas.test.ts — pure RAG quality metrics + the release gate.
 */

import { describe, it, expect } from 'vitest';
import { citedIndices, faithfulness, answerRelevancy, scoreSample, aggregate } from '../eval/ragas';

describe('citation + faithfulness', () => {
  it('extracts distinct citation indices', () => {
    expect(citedIndices('You spent $40 [1] and $18 [2], also [1].')).toEqual([1, 2]);
  });
  it('faithfulness is cited/used, capped at 1, 0 when nothing used', () => {
    expect(faithfulness('a [1] b [2]', 2)).toBe(1);
    expect(faithfulness('a [1]', 2)).toBe(0.5);
    expect(faithfulness('no citations', 3)).toBe(0);
    expect(faithfulness('x', 0)).toBe(0);
  });
});

describe('answerRelevancy', () => {
  it('is the fraction of expected substrings present (case-insensitive)', () => {
    expect(answerRelevancy('You spent on FOOD with Sam', ['food', 'Sam'])).toBe(1);
    expect(answerRelevancy('You spent on food', ['food', 'Sam'])).toBe(0.5);
  });
  it('is 1 when nothing specific is required', () => {
    expect(answerRelevancy('anything', [])).toBe(1);
  });
});

describe('scoreSample + aggregate', () => {
  const gold = { question: 'q', mustInclude: ['food'], minSources: 1 };

  it('passes a well-cited, relevant, sourced answer', () => {
    const s = scoreSample(gold, 'You spent on food [1].', 1);
    expect(s.pass).toBe(true);
  });

  it('fails when uncited (low faithfulness)', () => {
    const s = scoreSample(gold, 'You spent on food.', 1);
    expect(s.faithfulness).toBe(0);
    expect(s.pass).toBe(false);
  });

  it('fails when no sources were used', () => {
    expect(scoreSample(gold, 'food [1]', 0).pass).toBe(false);
  });

  it('aggregate gates on mean faithfulness >= 0.85', () => {
    const good = aggregate([scoreSample(gold, 'food [1]', 1), scoreSample(gold, 'food [1]', 1)]);
    expect(good.gatePassed).toBe(true);
    const mixed = aggregate([scoreSample(gold, 'food [1]', 1), scoreSample(gold, 'food', 1)]);
    expect(mixed.meanFaithfulness).toBe(0.5);
    expect(mixed.gatePassed).toBe(false);
  });
});
