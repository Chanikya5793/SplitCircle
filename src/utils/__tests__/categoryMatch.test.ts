/**
 * categoryMatch.test.ts — coercing a model's free-text category onto the list.
 */

import { describe, expect, it } from 'vitest';
import { coerceCategory, EXPENSE_CATEGORIES } from '../categoryMatch';

describe('coerceCategory', () => {
  it('matches exactly, case-insensitively', () => {
    expect(coerceCategory('Food')).toBe('Food');
    expect(coerceCategory('food')).toBe('Food');
    expect(coerceCategory('  TRANSPORT ')).toBe('Transport');
  });

  it('matches when the model adds extra words/punctuation', () => {
    expect(coerceCategory('Category: Food.')).toBe('Food');
    expect(coerceCategory('Entertainment!!!')).toBe('Entertainment');
  });

  it('falls back for off-list or empty answers', () => {
    expect(coerceCategory('Groceries')).toBe('General'); // not in list, no overlap
    expect(coerceCategory('')).toBe('General');
    expect(coerceCategory(null)).toBe('General');
    expect(coerceCategory('xyz', 'Shopping')).toBe('Shopping');
  });

  it('respects a custom allowed list', () => {
    expect(coerceCategory('food', 'Other', ['Other', 'Bills'])).toBe('Other');
  });

  it('exposes the canonical list', () => {
    expect(EXPENSE_CATEGORIES).toContain('Health');
    expect(EXPENSE_CATEGORIES[0]).toBe('General');
  });
});
