import { describe, expect, it } from 'vitest';
import { numbersGrounded, sanitizeNarrative, stripModelDecorations } from '../aiText';

/** A realistic facts blob (shape of buildStatsFacts output). */
const FACTS = JSON.stringify({
  group: 'Flat 7B',
  currency: 'USD',
  range: 'month',
  total: 1234.56,
  count: 18,
  topCategories: [
    { c: 'Food', t: 640.2 },
    { c: 'Utilities', t: 210 },
  ],
  trends: [{ c: 'Food', cur: 640.2, prev: 512.75, d: 25 }],
  forecast: { mtd: 1234.56, projected: 2100.5, prevMonth: 1980, recurring: 150 },
  budgets: [{ c: 'Food', pct: 80 }],
  savings: 42.1,
});

describe('stripModelDecorations', () => {
  it('removes code fences, wrapping quotes, and markdown', () => {
    expect(stripModelDecorations('```\n"**Spending** is _up_."\n```')).toBe('Spending is up.');
  });

  it('flattens bullet lists into sentences', () => {
    expect(stripModelDecorations('- Food is up.\n- Settle soon.')).toBe('Food is up. Settle soon.');
  });

  it('collapses newlines and whitespace runs', () => {
    expect(stripModelDecorations('Food rose.\n\n  Try   a budget.')).toBe('Food rose. Try a budget.');
  });

  it('strips emphasis followed by punctuation', () => {
    expect(stripModelDecorations('*Food*: rising fast, *watch it*.')).toBe(
      'Food: rising fast, watch it.',
    );
  });

  it('keeps plain text untouched', () => {
    const s = 'Food spending rose 25% to $640.20 this month.';
    expect(stripModelDecorations(s)).toBe(s);
  });
});

describe('numbersGrounded', () => {
  it('accepts verbatim and rounded fact numbers', () => {
    expect(numbersGrounded('You spent $1,234.56, about 1200 overall.', FACTS)).toBe(true);
  });

  it('accepts percentages present in the facts', () => {
    expect(numbersGrounded('Food is up 25% and the budget is 80% used.', FACTS)).toBe(true);
  });

  it('rejects invented amounts', () => {
    expect(numbersGrounded('You spent $3,450 on Food.', FACTS)).toBe(false);
  });

  it('ignores small counts and years', () => {
    expect(numbersGrounded('Over 2 weeks in 2026, spending held steady.', FACTS)).toBe(true);
  });
});

describe('sanitizeNarrative', () => {
  it('passes a clean narrative through', () => {
    const s = 'Food spending rose 25% to $640.20 this month. Consider setting a Food budget.';
    expect(sanitizeNarrative(s, FACTS)).toBe(s);
  });

  it('strips preamble and decorations before validating', () => {
    expect(
      sanitizeNarrative("Sure! Here's the insight: **Food** rose 25% this month. Settle up soon.", FACTS),
    ).toBe('Food rose 25% this month. Settle up soon.');
  });

  it('strips label prefixes like "Insight:"', () => {
    expect(
      sanitizeNarrative('Insight: Food rose 25% to $640.20 this month. Consider a budget.', FACTS),
    ).toBe('Food rose 25% to $640.20 this month. Consider a budget.');
  });

  it('rejects the askOnDevice-style deflection', () => {
    expect(
      sanitizeNarrative("I don't have enough expense data for that question.", FACTS),
    ).toBeNull();
  });

  it('rejects scaffold echoes and meta-talk', () => {
    expect(sanitizeNarrative('Based on the numbered expense lines, spending is stable overall.', FACTS)).toBeNull();
    expect(sanitizeNarrative('The FACTS show your spending this month went well overall.', FACTS)).toBeNull();
    expect(sanitizeNarrative('As an AI, I think your group spending looks healthy overall.', FACTS)).toBeNull();
  });

  it('rejects JSON residue', () => {
    expect(sanitizeNarrative('{"total": 1234.56, "count": 18} — a busy month for the group.', FACTS)).toBeNull();
  });

  it('rejects ungrounded numbers', () => {
    expect(sanitizeNarrative('Your group spent $9,999 on Food this month. Impressive work everyone.', FACTS)).toBeNull();
  });

  it('rejects fragments', () => {
    expect(sanitizeNarrative('Spending is up.', FACTS)).toBeNull();
  });

  it('clamps runaway output to four sentences', () => {
    const out = sanitizeNarrative(
      'Total spend was $1,234.56. Food led at $640.20. Utilities held at $210. ' +
        'Budgets sit at 80%. Savings reached $42.10. Projection is $2,100.50.',
      FACTS,
    );
    expect(out).toBe(
      'Total spend was $1,234.56. Food led at $640.20. Utilities held at $210. Budgets sit at 80%.',
    );
  });
});
