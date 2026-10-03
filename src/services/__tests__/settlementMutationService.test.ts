import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ callable: vi.fn() }));

vi.mock('@/firebase', () => ({ app: {} }));
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn((_functions, name: string) => async (payload: unknown) => {
    await mocks.callable(name, payload);
    return { data: { success: true, duplicate: false } };
  }),
}));

import type { Settlement } from '@/models';
import {
  createSettlementOnServer,
  deleteSettlementOnServer,
  updateSettlementOnServer,
} from '../settlementMutationService';

const settlement: Settlement = {
  settlementId: 'settlement-1',
  requestId: 'settlement-1',
  revision: 1,
  fromUserId: 'friend',
  toUserId: 'owner',
  amount: 25,
  createdAt: 1,
  updatedAt: 1,
  status: 'pending',
};

describe('settlement mutation callable contract', () => {
  beforeEach(() => mocks.callable.mockClear());

  it('sends the currency observed at authoring time for create and update', async () => {
    await createSettlementOnServer('group-1', settlement, 'usd');
    await updateSettlementOnServer(
      'group-1',
      { ...settlement, amount: 30 },
      { expectedRevision: 1 },
      'usd',
    );
    expect(mocks.callable).toHaveBeenNthCalledWith(1, 'mutateSettlement', {
      action: 'create',
      groupId: 'group-1',
      expectedCurrency: 'USD',
      settlement,
    });
    expect(mocks.callable).toHaveBeenNthCalledWith(2, 'mutateSettlement', expect.objectContaining({
      action: 'update',
      expectedCurrency: 'USD',
      expectation: { expectedRevision: 1 },
    }));
  });

  it('keeps delete revision guarded without reinterpreting an amount', async () => {
    await deleteSettlementOnServer('group-1', 'settlement-1', { expectedRevision: 2 });
    expect(mocks.callable).toHaveBeenCalledWith('mutateSettlement', {
      action: 'delete',
      groupId: 'group-1',
      settlementId: 'settlement-1',
      expectation: { expectedRevision: 2 },
    });
  });
});
