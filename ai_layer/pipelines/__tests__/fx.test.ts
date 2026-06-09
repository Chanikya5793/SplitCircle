/**
 * fx.test.ts — multi-currency normalization (Open Question #5).
 */

import { describe, it, expect } from 'vitest';
import { fxNormalize, loadFxConfig, type FxConfig } from '../firestore_to_bq/fx';

const cfg: FxConfig = { base: 'USD', rates: { USD: 1, EUR: 1.1, GBP: 1.25 } };

describe('fxNormalize', () => {
  it('is identity for the base currency', () => {
    expect(fxNormalize(40, 'USD', cfg)).toEqual({ amount_normalized: 40, normalized_currency: 'USD', fx_rate: 1 });
  });

  it('converts a foreign currency at the configured rate', () => {
    expect(fxNormalize(10, 'EUR', cfg)).toEqual({ amount_normalized: 11, normalized_currency: 'USD', fx_rate: 1.1 });
  });

  it('defaults a missing currency to the base', () => {
    expect(fxNormalize(5, undefined, cfg).fx_rate).toBe(1);
  });

  it('returns NULL (never a wrong number) for an unknown currency', () => {
    expect(fxNormalize(100, 'JPY', cfg)).toEqual({ amount_normalized: null, normalized_currency: 'USD', fx_rate: null });
  });

  it('rounds to cents', () => {
    expect(fxNormalize(3.333, 'GBP', cfg).amount_normalized).toBe(4.17); // 3.333*1.25=4.16625
  });
});

describe('loadFxConfig', () => {
  it('always includes the base with rate 1 and survives bad FX_RATES', () => {
    const prevBase = process.env.NORMALIZED_CURRENCY;
    const prevRates = process.env.FX_RATES;
    process.env.NORMALIZED_CURRENCY = 'EUR';
    process.env.FX_RATES = 'not-json';
    const c = loadFxConfig();
    expect(c.base).toBe('EUR');
    expect(c.rates.EUR).toBe(1);
    process.env.NORMALIZED_CURRENCY = prevBase;
    process.env.FX_RATES = prevRates;
  });
});
