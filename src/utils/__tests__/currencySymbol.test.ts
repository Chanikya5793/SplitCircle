import { describe, expect, it } from 'vitest';
import { getCurrencySymbol } from '../currency';

describe('getCurrencySymbol', () => {
  it('returns the currency’s own symbol, not a dollar sign', () => {
    expect(getCurrencySymbol('INR')).toBe('₹');
    expect(getCurrencySymbol('EUR')).toBe('€');
    expect(getCurrencySymbol('USD')).toBe('$');
    expect(getCurrencySymbol('JPY')).toMatch(/¥/);
  });

  it('never returns digits or separators', () => {
    for (const code of ['USD', 'INR', 'EUR', 'JPY', 'CHF', 'CAD']) {
      expect(getCurrencySymbol(code)).not.toMatch(/[\d.,\s]/);
    }
  });
});
