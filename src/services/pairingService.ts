import { app, auth, db } from '@/firebase';
import { authenticate, isBiometricAvailable } from '@/services/biometrics';
import { getOrCreateInstallationId } from '@/services/notificationService';
import * as Device from 'expo-device';
import {
  collection,
  doc,
  onSnapshot,
  type FirestoreError,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { signInWithCustomToken } from 'firebase/auth';
import { Platform } from 'react-native';

/**
 * Client wrapper for the pairing Cloud Functions
 * (ai_layer/docs/31_multi_device_icloud_sync.md §3.4). Mirrors
 * groupJoinService.ts's shape — thin httpsCallable wrappers, no business
 * logic duplicated client-side.
 */

const functions = getFunctions(app);

export interface PairedDevice {
  deviceId: string;
  platform: 'ios' | 'android';
  deviceName: string | null;
  modelName: string | null;
  isMainDevice: boolean;
  pairingStatus: 'pending_confirmation' | 'confirmed';
  /** Only present while pairingStatus is 'pending_confirmation'. */
  confirmationCode?: string;
  confirmationExpiresAt?: number | null;
  pairedAt?: unknown;
  lastSeenAt?: unknown;
}

/** This device's own stable id — same identity notificationDevices already uses. */
export const getCurrentDeviceId = getOrCreateInstallationId;

const currentDeviceInfo = () => ({
  platform: (Platform.OS === 'ios' ? 'ios' : 'android') as 'ios' | 'android',
  deviceName: Device.deviceName ?? null,
  modelName: Device.modelName ?? null,
});

// ── Main device: generate + share a pairing code ──────────────────────────

interface CreatePairingCodeResponse {
  code: string;
  expiresAt: number;
}

const createPairingCodeCallable = httpsCallable<Record<string, never>, CreatePairingCodeResponse>(
  functions,
  'createPairingCode',
);

/**
 * Gates on biometric re-auth BEFORE the pairing screen is ever reachable
 * (doc 31 §3.4 point 1) — same trust model / API shape as
 * SettlementsScreen.tsx's confirm-settlement gate. Returns null if the user
 * cancels or fails biometric auth; the caller should not navigate to the
 * pairing screen in that case.
 */
export const requestPairingCode = async (): Promise<CreatePairingCodeResponse | null> => {
  if (await isBiometricAvailable()) {
    const ok = await authenticate('Link a device', true);
    if (!ok) return null;
  }
  const { data } = await createPairingCodeCallable({});
  return data;
};

// ── New device: redeem a code, sign in as a companion ──────────────────────

interface RedeemPairingCodeRequest {
  code: string;
  deviceId: string;
  platform: 'ios' | 'android';
  deviceName: string | null;
  modelName: string | null;
}

interface RedeemPairingCodeResponse {
  customToken: string;
  confirmationCode: string;
  confirmationExpiresAt: number;
}

const redeemPairingCodeCallable = httpsCallable<RedeemPairingCodeRequest, RedeemPairingCodeResponse>(
  functions,
  'redeemPairingCode',
);

/**
 * Redeems a pairing code (from QR scan or manual entry, doc 31 decision #8)
 * and signs this device in as a companion via the returned custom token.
 * Note: this call itself must happen while UNAUTHENTICATED (or at least,
 * this device isn't yet signed in as this account) — it's how a brand new
 * device joins the account in the first place, matching WhatsApp's
 * QR-scan-to-link flow.
 */
export const redeemPairingCode = async (
  code: string,
): Promise<RedeemPairingCodeResponse> => {
  const deviceId = await getCurrentDeviceId();
  const { deviceName, modelName, platform } = currentDeviceInfo();

  const { data } = await redeemPairingCodeCallable({
    code: code.trim().toUpperCase(),
    deviceId,
    platform,
    deviceName,
    modelName,
  });

  await signInWithCustomToken(auth, data.customToken);
  return data;
};

// ── Main device: confirm or deny a pending companion ────────────────────────

interface ConfirmPairingRequest {
  callerDeviceId: string;
  targetDeviceId: string;
  confirm: boolean;
}

interface ConfirmPairingResponse {
  status: 'confirmed' | 'denied';
}

const confirmPairingCallable = httpsCallable<ConfirmPairingRequest, ConfirmPairingResponse>(
  functions,
  'confirmPairing',
);

export const confirmPairing = async (
  targetDeviceId: string,
  confirm: boolean,
): Promise<ConfirmPairingResponse> => {
  const callerDeviceId = await getCurrentDeviceId();
  const { data } = await confirmPairingCallable({ callerDeviceId, targetDeviceId, confirm });
  return data;
};

// ── Either device: revoke a linked device ──────────────────────────────────

interface RevokeDeviceRequest {
  callerDeviceId: string;
  targetDeviceId: string;
}

const revokeDeviceCallable = httpsCallable<RevokeDeviceRequest, { success: boolean }>(
  functions,
  'revokeDevice',
);

export const revokeDevice = async (targetDeviceId: string): Promise<void> => {
  const callerDeviceId = await getCurrentDeviceId();
  await revokeDeviceCallable({ callerDeviceId, targetDeviceId });
};

// ── Reads ───────────────────────────────────────────────────────────────────

const pairedDevicesCollection = (userId: string) => collection(db, 'users', userId, 'pairedDevices');

/** Linked Devices settings screen. */
export const subscribeToPairedDevices = (
  userId: string,
  onChange: (devices: PairedDevice[]) => void,
  onError?: (error: FirestoreError) => void,
): (() => void) => {
  return onSnapshot(
    pairedDevicesCollection(userId),
    (snapshot) => {
      onChange(snapshot.docs.map((docSnap) => docSnap.data() as PairedDevice));
    },
    (error) => onError?.(error),
  );
};

/** A specific device's own pairing record — the new device's waiting screen. */
export const subscribeToOwnPairedDevice = (
  userId: string,
  deviceId: string,
  onChange: (device: PairedDevice | null) => void,
  onError?: (error: FirestoreError) => void,
): (() => void) => {
  return onSnapshot(
    doc(pairedDevicesCollection(userId), deviceId),
    (snap) => onChange(snap.exists() ? (snap.data() as PairedDevice) : null),
    (error) => onError?.(error),
  );
};
