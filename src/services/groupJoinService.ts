import { app } from '@/firebase';
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions(app);

interface JoinGroupRequest {
  inviteCode: string;
  requestId?: string;
}

interface JoinGroupResponse {
  groupId: string;
  alreadyMember: boolean;
}

const joinGroupByInviteCodeCallable = httpsCallable<JoinGroupRequest, JoinGroupResponse>(
  functions,
  'joinGroupByInviteCode',
);

export const joinGroupByInviteCode = async (
  inviteCode: string,
  requestId?: string,
): Promise<JoinGroupResponse> => {
  const { data } = await joinGroupByInviteCodeCallable({ inviteCode, requestId });
  return data;
};
