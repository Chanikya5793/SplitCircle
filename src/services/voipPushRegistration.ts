import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { getOrCreateInstallationId } from './notificationService';
import { voipPushService } from './voipPushService';

const debugLog = (...args: unknown[]) => {
  if (__DEV__) {
    console.log('[voipPushRegistration]', ...args);
  }
};

let lastRegisteredToken: string | null = null;
let lastRegisteredUserId: string | null = null;
let unsubscribeToken: (() => void) | null = null;
let activeUserId: string | null = null;

const callRegisterEndpoint = async (token: string): Promise<void> => {
  if (Platform.OS !== 'ios') return;
  if (!activeUserId) return;
  if (lastRegisteredToken === token && lastRegisteredUserId === activeUserId) return;

  try {
    const functions = getFunctions(getApp());
    const callable = httpsCallable(functions, 'registerVoipPushToken');
    const deviceId = await getOrCreateInstallationId();
    const bundleId =
      (Constants.expoConfig?.ios?.bundleIdentifier as string | undefined)
      ?? (Constants.easConfig as { ios?: { bundleIdentifier?: string } } | undefined)?.ios?.bundleIdentifier
      ?? undefined;

    await callable({
      deviceId,
      voipPushToken: token,
      bundleId,
      platform: 'ios',
    });

    lastRegisteredToken = token;
    lastRegisteredUserId = activeUserId;
    debugLog('VoIP token registered with backend');
  } catch (error) {
    console.warn('[voipPushRegistration] failed to register VoIP token', error);
  }
};

export function startVoipPushRegistration(userId: string | null): void {
  if (Platform.OS !== 'ios') return;

  if (!userId) {
    activeUserId = null;
    if (unsubscribeToken) {
      unsubscribeToken();
      unsubscribeToken = null;
    }
    return;
  }

  if (activeUserId === userId && unsubscribeToken) {
    return;
  }

  activeUserId = userId;
  // Reset cached fingerprint so a re-login forces re-registration even with the
  // same device token — backend doc is keyed on (userId, deviceId).
  lastRegisteredToken = null;
  lastRegisteredUserId = null;

  if (unsubscribeToken) {
    unsubscribeToken();
  }

  unsubscribeToken = voipPushService.onToken((token) => {
    void callRegisterEndpoint(token);
  });
}
