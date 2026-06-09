import { describe, it, expect } from 'vitest';
import { suggestItemizedSplit, type ReceiptItem } from '../receipt_split';

const sum = (m: Record<string, number>) => Number(Object.values(m).reduce((s, v) => s + v, 0).toFixed(2));

describe('suggestItemizedSplit', () => {
  it('splits items per assignee and prorates tax + tip by subtotal', () => {
    const items: ReceiptItem[] = [
      { name: 'steak', price: 30, assignedTo: ['a'] },
      { name: 'salad', price: 10, assignedTo: ['b'] },
      { name: 'wine', price: 20, assignedTo: ['a', 'b'] }, // 10 each
    ];
    // subtotals: a=40, b=20, assignedSum=60. tax+tip=12 prorated 2:1.
    const res = suggestItemizedSplit(items, { tax: 6, tip: 6 });
    expect(res.perUser.a).toBe(48); // 40 + (40/60)*12
    expect(res.perUser.b).toBe(24); // 20 + (20/60)*12
    expect(res.total).toBe(72);
    expect(sum(res.perUser)).toBe(72);
  });

  it('honors quantity and pools unassigned items', () => {
    const items: ReceiptItem[] = [
      { name: 'coffee', price: 4, quantity: 3, assignedTo: ['a'] }, // 12
      { name: 'shared dessert', price: 8, assignedTo: [] },          // unassigned
    ];
    const res = suggestItemizedSplit(items);
    expect(res.perUser.a).toBe(12);
    expect(res.unassignedTotal).toBe(8);
    expect(res.total).toBe(20);
  });

  it('is safe with no items', () => {
    expect(suggestItemizedSplit([], { tax: 5 })).toEqual({ perUser: {}, unassignedTotal: 0, total: 5 });
  });
});
