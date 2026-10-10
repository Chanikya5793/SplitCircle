/**
 * duressDecoy.test.ts — the disguised copy of a group that every screen reads
 * in the Privacy Guard duress world. Run with `npm run test:services`.
 *
 * Contract: nothing identifying survives, the structure is unchanged, and the
 * money still reconciles (shares add up to amounts, balances net to zero).
 */
import { describe, expect, it } from 'vitest';
import type { Group } from '@/models';
import { decoyGroup, decoyRecurringBill } from '../duressDecoy';

const realGroup = {
  groupId: 'g-goa',
  inviteCode: 'DB5250',
  name: 'Goa Trip 2026',
  description: 'Beach house with the college gang',
  photoURL: 'https://example.com/goa.jpg',
  currency: 'INR',
  createdBy: 'u1',
  createdAt: Date.UTC(2026, 7, 30),
  updatedAt: Date.UTC(2026, 8, 2),
  members: [
    { userId: 'u1', displayName: 'Taylor Tester', role: 'owner', balance: 3000, photoURL: 'https://example.com/t.jpg' },
    { userId: 'u2', displayName: 'Priya Sharma', role: 'member', balance: -1800 },
    { userId: 'u3', displayName: 'Arjun Mehta', role: 'member', balance: -1200 },
  ],
  archivedMembers: [{ userId: 'u4', displayName: 'Maya Chen', role: 'member', balance: 0 }],
  expenses: [
    {
      expenseId: 'e1',
      groupId: 'g-goa',
      title: 'Scuba diving at Grande Island',
      category: 'Travel',
      amount: 4500,
      paidBy: 'u1',
      splitType: 'equal',
      participants: [
        { userId: 'u1', share: 1500 },
        { userId: 'u2', share: 1500 },
        { userId: 'u3', share: 1500 },
      ],
      settled: false,
      notes: 'Booked through the hotel desk',
      receipt: { url: 'https://example.com/receipt.jpg' },
      createdAt: Date.UTC(2026, 8, 1),
      updatedAt: Date.UTC(2026, 8, 1),
    },
  ],
  settlements: [
    { settlementId: 's1', fromUserId: 'u2', toUserId: 'u1', amount: 500, createdAt: Date.UTC(2026, 8, 2), status: 'completed', note: 'GPay' },
  ],
  budgets: { Travel: 10000 },
} as unknown as Group;

const REAL_STRINGS = [
  'Goa Trip 2026', 'Beach house', 'DB5250', 'Taylor', 'Priya', 'Arjun', 'Maya',
  'Scuba', 'Grande Island', 'hotel desk', 'GPay', 'example.com',
];

describe('decoyGroup', () => {
  const decoy = decoyGroup(realGroup);

  it('carries no identifying real text anywhere in the copy', () => {
    const json = JSON.stringify(decoy);
    for (const real of REAL_STRINGS) expect(json).not.toContain(real);
  });

  it('keeps ids, roles, counts, categories and ordering', () => {
    expect(decoy.groupId).toBe(realGroup.groupId);
    expect(decoy.members.map((m) => [m.userId, m.role])).toEqual(realGroup.members.map((m) => [m.userId, m.role]));
    expect(decoy.expenses.map((e) => [e.expenseId, e.category, e.paidBy])).toEqual(
      realGroup.expenses.map((e) => [e.expenseId, e.category, e.paidBy]),
    );
    expect(decoy.currency).toBe('INR');
  });

  it('scales money with one factor so the ledger still reconciles', () => {
    const e = decoy.expenses[0];
    expect(e.amount).not.toBe(4500);
    const shares = e.participants.reduce((sum, p) => sum + p.share, 0);
    expect(Math.abs(shares - e.amount)).toBeLessThan(0.05);
    const net = decoy.members.reduce((sum, m) => sum + m.balance, 0);
    expect(Math.abs(net)).toBeLessThan(0.05);
    const ratio = e.amount / 4500;
    expect(decoy.settlements[0].amount / 500).toBeCloseTo(ratio, 2);
    expect(decoy.budgets!.Travel / 10000).toBeCloseTo(ratio, 2);
  });

  it('moves dates back by one stable offset, keeping their order', () => {
    const shift = realGroup.expenses[0].createdAt - decoy.expenses[0].createdAt;
    expect(shift).toBeGreaterThan(0);
    expect(realGroup.settlements[0].createdAt - decoy.settlements[0].createdAt).toBe(shift);
  });

  it('drops photos, receipts and itemized split details', () => {
    expect(decoy.photoURL).toBeUndefined();
    expect(decoy.members[0].photoURL).toBeUndefined();
    expect(decoy.expenses[0].receipt).toBeUndefined();
  });

  it('gives a person the same fake name in every copy', () => {
    const again = decoyGroup(realGroup);
    expect(again.members.map((m) => m.displayName)).toEqual(decoy.members.map((m) => m.displayName));
    expect(again.name).toBe(decoy.name);
  });
});

describe('decoyRecurringBill', () => {
  it('disguises the title and scales with the group factor', () => {
    const bill = decoyRecurringBill({
      billId: 'b1',
      groupId: 'g-goa',
      title: 'Villa rent',
      amount: 4500,
      participants: [{ userId: 'u1', share: 4500 }],
    } as never);
    expect(bill.title).not.toBe('Villa rent');
    expect(bill.amount).toBe(decoyGroup(realGroup).expenses[0].amount);
  });
});
