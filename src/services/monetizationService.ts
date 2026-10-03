import { app, auth } from '@/firebase';
import {
  isFinalizeMonetizedOperationResult,
  isMonetizationSnapshot,
  isMonetizedOperationAuthorization,
  isVerifyAppleTransactionResult,
  type AuthorizeMonetizedOperationInput,
  type FinalizeMonetizedOperationInput,
  type FinalizeMonetizedOperationResult,
  type MonetizationSnapshot,
  type MonetizationUsageDecision,
  type MonetizedOperationAuthorization,
  type RecordMonetizationUsageInput,
  type VerifyAppleTransactionInput,
  type VerifyAppleTransactionResult,
} from '@/models/monetization';
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions(app);

const getSnapshotCallable = httpsCallable<Record<string, never>, unknown>(
  functions,
  'getMonetizationSnapshot',
);

const recordUsageCallable = httpsCallable<
  RecordMonetizationUsageInput,
  MonetizationUsageDecision
>(functions, 'recordMonetizationUsage');

const verifyAppleTransactionCallable = httpsCallable<VerifyAppleTransactionInput, unknown>(
  functions,
  'verifyAppleTransaction',
);

const authorizeOperationCallable = httpsCallable<AuthorizeMonetizedOperationInput, unknown>(
  functions,
  'authorizeMonetizedOperation',
);

const finalizeOperationCallable = httpsCallable<FinalizeMonetizedOperationInput, unknown>(
  functions,
  'finalizeMonetizedOperation',
);

/**
 * Refreshes Firebase custom claims before a purchase-sensitive server read.
 * Sandbox commerce access is carried in the ID token, so merely calling the
 * snapshot endpoint again can keep using an older production-only session.
 */
export const refreshMonetizationIdentityToken = async (): Promise<void> => {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    const error = new Error('A signed-in account is required to refresh purchase access.') as Error & {
      code?: string;
    };
    error.code = 'not-authenticated';
    throw error;
  }
  await currentUser.getIdToken(true);
};

export const getMonetizationSnapshot = async (): Promise<MonetizationSnapshot> => {
  const response = await getSnapshotCallable({});
  if (!isMonetizationSnapshot(response.data)) {
    throw new Error('The access service returned an unsupported response.');
  }
  return response.data;
};

/**
 * Records privacy-minimized product usage. During shadow mode this never
 * blocks a feature and never spends credits. Call it only after the operation
 * has reached the outcome represented by the input.
 */
export const recordMonetizationUsage = async (
  input: RecordMonetizationUsageInput,
): Promise<MonetizationUsageDecision> => (await recordUsageCallable(input)).data;

export const verifyAppleTransaction = async (
  input: VerifyAppleTransactionInput,
): Promise<VerifyAppleTransactionResult> => {
  const response = await verifyAppleTransactionCallable(input);
  if (!isVerifyAppleTransactionResult(response.data)) {
    throw new Error('The purchase service returned an unsupported response.');
  }
  return response.data;
};

export const authorizeMonetizedOperation = async (
  input: AuthorizeMonetizedOperationInput,
): Promise<MonetizedOperationAuthorization> => {
  const response = await authorizeOperationCallable(input);
  if (!isMonetizedOperationAuthorization(response.data)) {
    throw new Error('The access service returned an unsupported authorization.');
  }
  return response.data;
};

export const finalizeMonetizedOperation = async (
  input: FinalizeMonetizedOperationInput,
): Promise<FinalizeMonetizedOperationResult> => {
  const response = await finalizeOperationCallable(input);
  if (!isFinalizeMonetizedOperationResult(response.data)) {
    throw new Error('The access service could not finalize this operation.');
  }
  return response.data;
};
