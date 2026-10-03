import { app } from '@/firebase';
import { getFunctions, httpsCallable } from 'firebase/functions';

const mutate = httpsCallable<
  { groupId: string; targetUserId: string; action: 'promote' | 'demote' | 'remove' },
  { updated: true }
>(getFunctions(app), 'mutateGroupMember');

export const mutateGroupMember = async (
  groupId: string,
  targetUserId: string,
  action: 'promote' | 'demote' | 'remove',
): Promise<void> => {
  await mutate({ groupId, targetUserId, action });
};
