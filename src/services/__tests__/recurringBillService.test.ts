/**
 * recurringBillService (ai_layer/docs/26) — pure v2 helpers: share scaling,
 * rotation payer resolution, and the deterministic expense builder. Firebase
 * is mocked out; the generation batch paths are covered by the byte-compat
 * contract with functions/src/recurringBills.ts, not re-tested here.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/firebase', () => ({ app: {}, db: {} }));
vi.mock('firebase/firestore', () => ({
  addDoc: vi.fn(),
  arrayUnion: vi.fn(),
  collection: vi.fn(),
  deleteDoc: vi.fn(),
  doc: vi.fn(),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  query: vi.fn(),
  updateDoc: vi.fn(),
  where: vi.fn(),
  writeBatch: vi.fn(),
}));
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => vi.fn()),
}));

import type { RecurringBill } from '@/models/recurringBill';
import {
  generateExpenseFromBill,
  recurringExpenseId,
  resolveRotationPayer,
  scaleShares,
} from '../recurringBillService';

const OCCURRENCE = new Date('2026-07-01T00:00:00Z').getTime();

const bill = (extra: Partial<RecurringBill> = {}): RecurringBill => ({
  billId: 'b1',
  groupId: 'g1',
  title: 'Rent',
  amount: 3000,
  category: 'Rent',
  paidBy: 'u1',
  participants: [
    { userId: 'u1', share: 1000 },
    { userId: 'u2', share: 1000 },
    { userId: 'u3', share: 1000 },
  ],
  recurrenceRule: { frequency: 'monthly', interval: 1 },
  startAt: OCCURRENCE - 90 * 86400000,
  isActive: true,
  nextDueAt: OCCURRENCE,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

describe('scaleShares', () => {
  it('scales proportionally and lands exactly on the new total', () => {
    const scaled = scaleShares(
      [
        { userId: 'u1', share: 700 },
        { userId: 'u2', share: 300 },
      ],
      1000,
      1234.56,
    );
    expect(scaled.map((p) => p.share).reduce((a, b) => a + b, 0)).toBeCloseTo(1234.56, 2);
    expect(scaled[0].share / scaled[1].share).toBeCloseTo(7 / 3, 1);
  });

  it('returns participants untouched when totals match or target is invalid', () => {
    const parts = [{ userId: 'u1', share: 500 }];
    expect(scaleShares(parts, 500, 500)).toBe(parts);
    expect(scaleShares(parts, 500, 0)).toBe(parts);
    expect(scaleShares(parts, 500, Number.NaN)).toBe(parts);
  });

  it('falls back to an equal split when the stored total is degenerate', () => {
    const scaled = scaleShares(
      [
        { userId: 'u1', share: 0 },
        { userId: 'u2', share: 0 },
      ],
      0,
      100,
    );
    expect(scaled.map((p) => p.share)).toEqual([50, 50]);
  });
});

describe('resolveRotationPayer', () => {
  it('falls back to paidBy without a rotation', () => {
    expect(resolveRotationPayer(bill())).toBe('u1');
  });

  it('resolves the current turn and wraps the index', () => {
    const rotating = bill({ rotation: { order: ['u1', 'u2', 'u3'], index: 4 } });
    expect(resolveRotationPayer(rotating)).toBe('u2'); // 4 % 3 = 1
  });
});

describe('generateExpenseFromBill', () => {
  it('uses the sacred deterministic id and clean title (no "(Recurring)" suffix, no auto-note)', () => {
    const expense = generateExpenseFromBill(bill(), OCCURRENCE);
    expect(expense.expenseId).toBe(recurringExpenseId('b1', OCCURRENCE));
    expect(expense.expenseId).toBe(`rec_b1_${OCCURRENCE}`);
    expect(expense.title).toBe('Rent');
    expect(expense.notes).toBeUndefined();
    expect(expense.recurring).toEqual({ billId: 'b1', occurrenceAt: OCCURRENCE });
    expect(expense.createdAt).toBe(OCCURRENCE);
  });

  it('resolves the rotation payer by default and honors an explicit override', () => {
    const rotating = bill({ rotation: { order: ['u1', 'u2'], index: 1 } });
    expect(generateExpenseFromBill(rotating, OCCURRENCE).paidBy).toBe('u2');
    expect(generateExpenseFromBill(rotating, OCCURRENCE, { paidBy: 'u1' }).paidBy).toBe('u1');
  });

  it('scales shares when a variable amount is confirmed', () => {
    const expense = generateExpenseFromBill(bill(), OCCURRENCE, { amount: 1500 });
    expect(expense.amount).toBe(1500);
    expect(expense.participants.map((p) => p.share)).toEqual([500, 500, 500]);
    // splitMetadata mirrors the scaled shares (both generation paths agree).
    expect(expense.splitMetadata?.participantConfig.map((p) => p.exactAmount)).toEqual([500, 500, 500]);
  });
});
