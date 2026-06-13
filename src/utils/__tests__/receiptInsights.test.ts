/**
 * receiptInsights.test.ts — pure display-row builder for receipt "More info".
 */

import { describe, expect, it } from 'vitest';
import { buildReceiptInsightRows } from '../receiptInsights';

const fmt = (n: number) => `$${n.toFixed(2)}`;

describe('buildReceiptInsightRows', () => {
  it('builds labeled rows in a stable order, skipping empty fields', () => {
    const rows = buildReceiptInsightRows(
      {
        merchantAddress: '123 Main St',
        paymentMethod: 'Visa ••1234',
        savings: 4.5,
      },
      fmt,
    );
    expect(rows).toEqual([
      { label: 'Address', value: '123 Main St' },
      { label: 'Payment', value: 'Visa ••1234' },
      { label: 'You saved', value: '$4.50' },
    ]);
  });

  it('includes all fields when present, trimming whitespace', () => {
    const rows = buildReceiptInsightRows(
      {
        merchantAddress: ' 1 A St ',
        merchantPhone: '555-0100',
        paymentMethod: 'Cash',
        savings: 1,
        returnPolicy: '30-day returns',
      },
      fmt,
    );
    expect(rows.map((r) => r.label)).toEqual(['Address', 'Phone', 'Payment', 'You saved', 'Returns']);
    expect(rows[0].value).toBe('1 A St');
  });

  it('returns empty for null/empty insights and skips non-positive savings', () => {
    expect(buildReceiptInsightRows(null, fmt)).toEqual([]);
    expect(buildReceiptInsightRows({}, fmt)).toEqual([]);
    expect(buildReceiptInsightRows({ savings: 0 }, fmt)).toEqual([]);
    expect(buildReceiptInsightRows({ savings: -2 }, fmt)).toEqual([]);
    expect(buildReceiptInsightRows({ merchantAddress: '   ' }, fmt)).toEqual([]);
  });
});
