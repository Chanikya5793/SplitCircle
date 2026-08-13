import { app } from '@/firebase';
import type {
  SecurityCenterSnapshot,
  SecurityFindingState,
  SecurityIdentityType,
} from '@/models/security';
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions(app);

const getCenterCallable = httpsCallable<Record<string, never>, SecurityCenterSnapshot>(functions, 'getSecurityCenter');
const enrollCallable = httpsCallable<
  { type: SecurityIdentityType; value: string; consentAccepted: true },
  {
    identityId: string;
    displayHint: string;
    verificationState: 'pending' | 'verified';
    verificationMethod: string;
    dnsRecordName?: string;
    dnsRecordValue?: string;
  }
>(functions, 'enrollSecurityIdentity');
const verifyCallable = httpsCallable<{ identityId: string }, { verified: boolean }>(functions, 'verifySecurityIdentity');
const scanCallable = httpsCallable<
  { requestId: string },
  { status: 'complete' | 'running'; findingCount?: number; newHighRiskCount?: number }
>(functions, 'startSecurityScan');
const updateFindingCallable = httpsCallable<
  { findingId: string; state: SecurityFindingState },
  { success: boolean }
>(functions, 'updateSecurityFinding');
const deleteFindingCallable = httpsCallable<{ findingId: string }, { success: boolean }>(functions, 'deleteSecurityFinding');
const updatePreferencesCallable = httpsCallable<
  { enabled?: boolean; detailedNotifications?: boolean },
  { success: boolean }
>(functions, 'updateSecurityPreferences');
const removeIdentityCallable = httpsCallable<{ identityId: string }, { success: boolean }>(functions, 'removeSecurityIdentity');
const deleteAllCallable = httpsCallable<Record<string, never>, { success: boolean }>(functions, 'deleteSecurityMonitoringData');
const analyzeUrlCallable = httpsCallable<
  { url: string },
  {
    hostname: string;
    risk: import('@/models/security').SecurityRiskAssessment;
    indicators: Array<{ code: string; label: string; evidence: string }>;
    providerStatus: 'success' | 'not_configured' | 'failed';
    enrichmentStatus: 'success' | 'partial' | 'failed';
    safeToOpen: boolean;
    checkedAt: number;
  }
>(functions, 'analyzeSecurityUrl');

export const getSecurityCenter = async (): Promise<SecurityCenterSnapshot> =>
  (await getCenterCallable({})).data;

export const enrollSecurityIdentity = async (type: SecurityIdentityType, value: string) =>
  (await enrollCallable({ type, value, consentAccepted: true })).data;

export const verifySecurityIdentity = async (identityId: string): Promise<boolean> =>
  (await verifyCallable({ identityId })).data.verified;

export const startSecurityScan = async () => {
  const requestId = `manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return (await scanCallable({ requestId })).data;
};

export const updateSecurityFinding = async (
  findingId: string,
  state: SecurityFindingState,
): Promise<void> => {
  await updateFindingCallable({ findingId, state });
};

export const deleteSecurityFinding = async (findingId: string): Promise<void> => {
  await deleteFindingCallable({ findingId });
};

export const updateSecurityPreferences = async (patch: {
  enabled?: boolean;
  detailedNotifications?: boolean;
}): Promise<void> => {
  await updatePreferencesCallable(patch);
};

export const removeSecurityIdentity = async (identityId: string): Promise<void> => {
  await removeIdentityCallable({ identityId });
};

export const deleteAllSecurityMonitoringData = async (): Promise<void> => {
  await deleteAllCallable({});
};

export const analyzeSecurityUrl = async (url: string) =>
  (await analyzeUrlCallable({ url })).data;
