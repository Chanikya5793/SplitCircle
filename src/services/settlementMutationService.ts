import { app } from '@/firebase';
import type { Settlement } from '@/models';
import type { MutationExpectation } from '@/utils/mutationConflict';
import { getFunctions, httpsCallable } from 'firebase/functions';

type SettlementMutationInput =
  | {
      action: 'create';
      groupId: string;
      expectedCurrency: string;
      settlement: Settlement;
    }
  | {
      action: 'update';
      groupId: string;
      expectedCurrency: string;
      settlement: Settlement;
      expectation: MutationExpectation;
    }
  | {
      action: 'delete';
      groupId: string;
      settlementId: string;
      expectation: MutationExpectation;
    };

interface SettlementMutationResult {
  success: true;
  duplicate: boolean;
  settlement?: Settlement;
}

const mutateSettlementCallable = httpsCallable<SettlementMutationInput, SettlementMutationResult>(
  getFunctions(app),
  'mutateSettlement',
);

export const createSettlementOnServer = async (
  groupId: string,
  settlement: Settlement,
  expectedCurrency: string,
): Promise<SettlementMutationResult> => (
  await mutateSettlementCallable({
    action: 'create',
    groupId,
    expectedCurrency: expectedCurrency.toUpperCase(),
    settlement,
  })
).data;

export const updateSettlementOnServer = async (
  groupId: string,
  settlement: Settlement,
  expectation: MutationExpectation,
  expectedCurrency: string,
): Promise<SettlementMutationResult> => (
  await mutateSettlementCallable({
    action: 'update',
    groupId,
    expectedCurrency: expectedCurrency.toUpperCase(),
    settlement,
    expectation,
  })
).data;

export const deleteSettlementOnServer = async (
  groupId: string,
  settlementId: string,
  expectation: MutationExpectation,
): Promise<SettlementMutationResult> => (
  await mutateSettlementCallable({ action: 'delete', groupId, settlementId, expectation })
).data;
