/**
 * receiptParse.test.ts — pure helpers for the on-device receipt parser.
 * No RN/native runtime needed.
 */

import { describe, expect, it } from 'vitest';
import { buildReceiptFewShot, mapOnDeviceReceipt } from '../receiptParse';

describe('buildReceiptFewShot', () => {
  it('renders learned corrections as a few-shot block', () => {
    const out = buildReceiptFewShot([
      { from: 'choc mlk', to: 'Chocolate Milk' },
      { from: 'org bananas', to: 'Organic Bananas' },
    ]);
    expect(out).toBe('- "choc mlk" -> "Chocolate Milk"\n- "org bananas" -> "Organic Bananas"');
  });

  it('returns empty string with no hints', () => {
    expect(buildReceiptFewShot([])).toBe('');
  });
});

describe('mapOnDeviceReceipt', () => {
  it('keeps valid items, trims names, defaults quantity, and validates totals', () => {
    const out = mapOnDeviceReceipt({
      items: [
        { name: '  Latte ', price: 4.5, quantity: 2 },
        { name: 'Bagel', price: 3, quantity: 0 }, // bad qty -> 1
        { name: 'Free sample', price: 0 }, // zero price -> dropped
        { name: '   ', price: 5 }, // blank name -> dropped
        { name: 'Bad', price: Number.NaN }, // NaN -> dropped
      ],
      merchantName: '  Blue Bottle ',
      date: '2026-06-13',
      subtotal: 7.5,
      tax: 0,
      tip: -1,
      total: 8.1,
    });

    expect(out.items).toEqual([
      { name: 'Latte', price: 4.5, quantity: 2 },
      { name: 'Bagel', price: 3, quantity: 1 },
    ]);
    expect(out.merchantName).toBe('Blue Bottle');
    expect(out.date).toBe('2026-06-13');
    expect(out.subtotal).toBe(7.5);
    expect(out.tax).toBeNull(); // 0 -> null
    expect(out.tip).toBeNull(); // negative -> null
    expect(out.total).toBe(8.1);
  });

  it('handles a sparse/empty payload', () => {
    const out = mapOnDeviceReceipt({});
    expect(out.items).toEqual([]);
    expect(out.merchantName).toBeNull();
    expect(out.date).toBeNull();
    expect(out.total).toBeNull();
  });

  it('normalizes empty merchant/date strings to null', () => {
    const out = mapOnDeviceReceipt({ merchantName: '   ', date: '' });
    expect(out.merchantName).toBeNull();
    expect(out.date).toBeNull();
  });
});
