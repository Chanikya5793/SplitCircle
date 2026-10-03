import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ callable: vi.fn() }));

vi.mock('@/firebase', () => ({ app: {}, db: {} }));
vi.mock('firebase/firestore', () => ({
  arrayUnion: vi.fn(),
  collection: vi.fn(() => ({ path: 'recurringBills' })),
  doc: vi.fn((_parent, id?: string) => ({ id: id ?? 'generated-bill-id' })),
  getDocs: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  writeBatch: vi.fn(),
}));
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn((_functions, name: string) => async (payload: unknown) => {
    await mocks.callable(name, payload);
    if (name === 'mutateRecurringBill') {
      return { data: { success: true, duplicate: false, billId: 'generated-bill-id' } };
    }
    return { data: {} };
  }),
}));

import type { RecurringBill } from '@/models/recurringBill';
import {
  createRecurringBill,
  deleteRecurringBill,
  skipOccurrence,
  toggleRecurringBillStatus,
  updateRecurringBill,
} from '../recurringBillService';

const bill: RecurringBill = {
  billId: 'bill-1',
  groupId: 'group-1',
  title: 'Rent',
  amount: 100,
  category: 'Housing',
  paidBy: 'owner',
  participants: [
    { userId: 'owner', share: 50 },
    { userId: 'friend', share: 50 },
  ],
  recurrenceRule: { frequency: 'monthly', interval: 1, daysOfMonth: [7] },
  startAt: 1,
  nextDueAt: 1,
  isActive: true,
  createdAt: 1,
  updatedAt: 1,
};

describe('recurring bill mutation callable contract', () => {
  beforeEach(() => mocks.callable.mockClear());

  it('routes create and edit through currency-aware callable payloads', async () => {
    await createRecurringBill({
      groupId: bill.groupId,
      title: bill.title,
      amount: bill.amount,
      category: bill.category,
      paidBy: bill.paidBy,
      participants: bill.participants,
      recurrenceRule: bill.recurrenceRule,
      startAt: bill.startAt,
      nextDueAt: bill.nextDueAt,
      isActive: true,
    }, 'usd');
    await updateRecurringBill('bill-1', 'group-1', { amount: 120 }, 'usd');
    expect(mocks.callable).toHaveBeenNthCalledWith(1, 'mutateRecurringBill', expect.objectContaining({
      action: 'create',
      expectedCurrency: 'USD',
      billId: 'generated-bill-id',
    }));
    expect(mocks.callable).toHaveBeenNthCalledWith(2, 'mutateRecurringBill', {
      action: 'update',
      billId: 'bill-1',
      groupId: 'group-1',
      expectedCurrency: 'USD',
      updates: { amount: 120 },
    });
  });

  it('routes toggle, skip, and delete through the same server boundary', async () => {
    await toggleRecurringBillStatus(bill, false, 'usd');
    await skipOccurrence(bill, 1, 'usd');
    await deleteRecurringBill('bill-1', 'group-1');
    expect(mocks.callable).toHaveBeenNthCalledWith(1, 'mutateRecurringBill', expect.objectContaining({
      action: 'update',
      updates: { isActive: false },
    }));
    expect(mocks.callable).toHaveBeenNthCalledWith(2, 'mutateRecurringBill', {
      action: 'skip',
      billId: 'bill-1',
      groupId: 'group-1',
      expectedCurrency: 'USD',
      occurrenceAt: 1,
    });
    expect(mocks.callable).toHaveBeenNthCalledWith(3, 'mutateRecurringBill', {
      action: 'delete',
      billId: 'bill-1',
      groupId: 'group-1',
    });
  });
});
