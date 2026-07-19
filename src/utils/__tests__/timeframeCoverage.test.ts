/**
 * timeframeCoverage.test.ts — the doc-17 timeframe gaps: explicit month names
 * ("April", "Aprils total?", "April 2025"), quarters, years, and the relative
 * "the month before that" shift. Deterministic clock: 2026-07-19.
 */

import { describe, expect, it } from 'vitest';
import { parseTimeframe, previousTimeframe } from '../expenseAnalytics';

const NOW = new Date('2026-07-19T12:00:00Z').getTime();
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe('parseTimeframe — explicit months', () => {
  it('resolves a bare month name to the most recent past occurrence', () => {
    const tf = parseTimeframe('how much did we spend in April', NOW);
    expect(tf).not.toBeNull();
    expect(tf!.label).toBe('in April');
    expect(iso(tf!.startMs)).toBe('2026-04-01');
    expect(iso(tf!.endMs)).toBe('2026-04-30');
  });

  it('handles the possessive typo from the screenshot ("Aprils total?")', () => {
    const tf = parseTimeframe('Aprils total?', NOW);
    expect(tf?.label).toBe('in April');
    expect(iso(tf!.startMs)).toBe('2026-04-01');
  });

  it('rolls a future month back to last year (December asked in July)', () => {
    const tf = parseTimeframe('spending in December', NOW);
    expect(iso(tf!.startMs)).toBe('2025-12-01');
    expect(tf!.label).toBe('in December 2025');
  });

  it('honors an explicit year', () => {
    const tf = parseTimeframe('food in April 2025', NOW);
    expect(iso(tf!.startMs)).toBe('2025-04-01');
    expect(tf!.label).toBe('in April 2025');
  });

  it('does not read the modal verb "may" as the month', () => {
    expect(parseTimeframe('may I ask what we spent?', NOW)).toBeNull();
    // …but a real "in May" reference still resolves.
    expect(parseTimeframe('what did we spend in May?', NOW)?.label).toBe('in May');
  });
});

describe('parseTimeframe — quarters & years', () => {
  it('parses Q2', () => {
    const tf = parseTimeframe('spending in Q2', NOW);
    expect(iso(tf!.startMs)).toBe('2026-04-01');
    expect(iso(tf!.endMs)).toBe('2026-06-30');
  });

  it('parses an explicit year with a preposition', () => {
    const tf = parseTimeframe('total in 2025', NOW);
    expect(iso(tf!.startMs)).toBe('2025-01-01');
    expect(iso(tf!.endMs)).toBe('2025-12-31');
  });

  it('does not treat a bare 4-digit amount as a year', () => {
    expect(parseTimeframe('add 2025 for rent', NOW)).toBeNull();
  });
});

describe('previousTimeframe — "the month before that"', () => {
  it('steps a calendar month back', () => {
    const april = parseTimeframe('in April', NOW)!;
    const prev = previousTimeframe(april, NOW);
    expect(prev.label).toBe('in March');
    expect(iso(prev.startMs)).toBe('2026-03-01');
    expect(iso(prev.endMs)).toBe('2026-03-31');
  });

  it('wraps across the year boundary (January → December)', () => {
    const jan = parseTimeframe('in January', NOW)!;
    const prev = previousTimeframe(jan, NOW);
    expect(iso(prev.startMs)).toBe('2025-12-01');
  });

  it('steps a quarter back', () => {
    const q2 = parseTimeframe('in Q2', NOW)!;
    const prev = previousTimeframe(q2, NOW);
    expect(iso(prev.startMs)).toBe('2026-01-01');
    expect(iso(prev.endMs)).toBe('2026-03-31');
  });
});
