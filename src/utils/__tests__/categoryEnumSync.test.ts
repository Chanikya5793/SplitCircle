import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_EXPENSE_CATEGORIES } from '../categoryMatch';

describe('SplitCircleCategoryAppEnum ↔ ALL_EXPENSE_CATEGORIES', () => {
  it('the Swift enum raw values match the JS category list exactly', () => {
    const swift = readFileSync(
      resolve(__dirname, '../../../modules/splitcircle-ai/ios/SplitCircleCategory.swift'),
      'utf8',
    );
    // Only `case X = "…"` lines — NOT the caseDisplayRepresentations strings.
    const rawValues = [...swift.matchAll(/case\s+\w+\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(rawValues)).toEqual(new Set(ALL_EXPENSE_CATEGORIES));
    expect(rawValues.length).toBe(ALL_EXPENSE_CATEGORIES.length); // catches dupes / one-sided adds
  });
});
