import { app } from '@/firebase';
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions(app);

export interface DeletionBlocker {
  groupId: string;
  groupName: string;
  reason: 'transfer_ownership' | 'unsettled_balance';
  memberCount?: number;
  balance?: number;
  currency?: string;
}

const checkAccountDeletionBlockersCallable = httpsCallable<
  Record<string, never>,
  { blockers: DeletionBlocker[] }
>(functions, 'checkAccountDeletionBlockers');

const deleteAccountCallable = httpsCallable<
  Record<string, never>,
  { success: boolean }
>(functions, 'deleteAccount');

export const checkDeletionBlockers = async (): Promise<DeletionBlocker[]> => {
  const { data } = await checkAccountDeletionBlockersCallable();
  return data.blockers;
};

export const deleteAccount = async (): Promise<void> => {
  await deleteAccountCallable();
};
