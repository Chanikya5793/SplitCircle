import { app, db } from '@/firebase';
import type {
  NotificationDeviceRecord,
  NotificationPermissionState,
  NotificationRegistrationStatus,
} from '@/models';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { doc, onSnapshot, type Unsubscribe } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { Platform } from 'react-native';
import { v4 as uuidv4 } from 'uuid';

const INSTALLATION_ID_STORAGE_KEY = 'notification_installation_id';
const functions = getFunctions(app);

type SyncNotificationDeviceInput = {
  deviceId: string;
  platform: 'ios' | 'android';
  expoPushToken: string | null;
  permissionState: NotificationPermissionState;
  projectId: string | null;
  appVersion: string | null;
  deviceName: string | null;
  modelName: string | null;
  isPhysicalDevice: boolean;
  lastRegistrationError: string | null;
};

type SyncNotificationDeviceResponse = {
  deviceId: string;
  registrationStatus: NotificationRegistrationStatus;
};

type UnregisterNotificationDeviceInput = {
  deviceId: string;
};

type SendTestPushNotificationResponse = {
  deliveryId: string;
  acceptedCount: number;
  targetedDeviceCount: number;
  droppedCount: number;
  pendingReceiptCount: number;
};

const syncNotificationDeviceCallable = httpsCallable<
  SyncNotificationDeviceInput,
  SyncNotificationDeviceResponse
>(functions, 'syncNotificationDevice');

const unregisterNotificationDeviceCallable = httpsCallable<
  UnregisterNotificationDeviceInput,
  { success: boolean }
>(functions, 'unregisterNotificationDevice');

const sendTestPushNotificationCallable = httpsCallable<
  Record<string, never>,
  SendTestPushNotificationResponse
>(functions, 'sendTestPushNotification');

export type NotificationPermissionSnapshot = {
  state: NotificationPermissionState;
  granted: boolean;
  canAskAgain: boolean;
  allowsAlert: boolean | null;
  allowsBadge: boolean | null;
  allowsSound: boolean | null;
};

export type NotificationRegistrationAttempt = {
  deviceId: string;
  projectId: string | null;
  expoPushToken: string | null;
  permission: NotificationPermissionSnapshot;
  isPhysicalDevice: boolean;
  error: string | null;
};

const getFunctionErrorCode = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return '';
};

const getFunctionErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return 'Unknown Firebase Functions error';
};

const normalizeCallableError = (functionName: string, error: unknown): Error => {
  const code = getFunctionErrorCode(error);
  const message = getFunctionErrorMessage(error);

  if (code === 'functions/not-found' || code === 'not-found') {
    return new Error(
      `Cloud Function "${functionName}" was not found in the active Firebase project. ` +
      `Deploy the latest Functions code, or point the app at the Firebase project where "${functionName}" exists.`,
    );
  }

  return new Error(`${functionName} failed: ${message}`);
};

const getExpoProjectId = (): string | null => {
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId ??
    null;

  return typeof projectId === 'string' && projectId.trim().length > 0
    ? projectId.trim()
    : null;
};

const toMillis = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'object' && value !== null) {
    const maybeTimestamp = value as { toMillis?: () => number; seconds?: number };
    if (typeof maybeTimestamp.toMillis === 'function') {
      return maybeTimestamp.toMillis();
    }
    if (typeof maybeTimestamp.seconds === 'number') {
      return maybeTimestamp.seconds * 1000;
    }
  }

  return null;
};

const derivePermissionState = (
  status: Notifications.NotificationPermissionsStatus,
): NotificationPermissionState => {
  const iosStatus = status.ios?.status;

  if (status.granted) {
    return 'granted';
  }

  if (Platform.OS === 'ios') {
    if (iosStatus === Notifications.IosAuthorizationStatus.PROVISIONAL) {
      return 'provisional';
    }
    if (iosStatus === Notifications.IosAuthorizationStatus.EPHEMERAL) {
      return 'ephemeral';
    }
  }

  if (status.status === 'denied') {
    return 'denied';
  }

  return 'undetermined';
};

const toPermissionSnapshot = (
  status: Notifications.NotificationPermissionsStatus,
): NotificationPermissionSnapshot => ({
  state: derivePermissionState(status),
  granted:
    status.granted ||
    status.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    status.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL,
  canAskAgain: status.canAskAgain,
  allowsAlert: status.ios?.allowsAlert ?? null,
  allowsBadge: status.ios?.allowsBadge ?? null,
  allowsSound: status.ios?.allowsSound ?? null,
});

export const getNotificationPermissionSnapshot = async (): Promise<NotificationPermissionSnapshot> => {
  const status = await Notifications.getPermissionsAsync();
  return toPermissionSnapshot(status);
};

export const requestNotificationPermissionSnapshot = async (): Promise<NotificationPermissionSnapshot> => {
  const status = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowBadge: true,
      allowSound: true,
    },
  });
  return toPermissionSnapshot(status);
};

export const getOrCreateInstallationId = async (): Promise<string> => {
  const existing = await AsyncStorage.getItem(INSTALLATION_ID_STORAGE_KEY);
  if (existing && existing.trim().length > 0) {
    return existing.trim();
  }

  const generated = uuidv4();
  await AsyncStorage.setItem(INSTALLATION_ID_STORAGE_KEY, generated);
  return generated;
};

export const setupNotificationChannels = async (): Promise<void> => {
  if (Platform.OS !== 'android') {
    return;
  }

  await Promise.allSettled([
    Notifications.setNotificationChannelAsync('messages', {
      name: 'Messages',
      description: 'Chat message notifications',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#1F6FEB',
      sound: 'default',
      enableVibrate: true,
      enableLights: true,
    }),
    Notifications.setNotificationChannelAsync('expenses', {
      name: 'Expenses',
      description: 'New expense and split notifications',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 200, 200],
      lightColor: '#10B981',
      sound: 'default',
      enableVibrate: true,
    }),
    Notifications.setNotificationChannelAsync('groups', {
      name: 'Groups',
      description: 'Group membership updates',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 150],
      lightColor: '#8B5CF6',
      sound: 'default',
    }),
    Notifications.setNotificationChannelAsync('calls', {
      name: 'Calls',
      description: 'Incoming call notifications',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 500, 500],
      lightColor: '#EF4444',
      sound: 'default',
      enableVibrate: true,
      enableLights: true,
    }),
    Notifications.setNotificationChannelAsync('general', {
      name: 'General',
      description: 'General app notifications',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
    }),
  ]);
};

const getAppVersion = (): string | null => {
  const version = Constants.expoConfig?.version ?? null;
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : null;
};

const parseRegistrationError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return 'Unknown notification registration error';
};

export const createNotificationRegistrationAttempt = async (
  options?: { requestPermission?: boolean; tokenOverride?: string | null },
): Promise<NotificationRegistrationAttempt> => {
  const deviceId = await getOrCreateInstallationId();

  if (Platform.OS === 'web') {
    return {
      deviceId,
      projectId: null,
      expoPushToken: null,
      permission: {
        state: 'denied',
        granted: false,
        canAskAgain: false,
        allowsAlert: null,
        allowsBadge: null,
        allowsSound: null,
      },
      isPhysicalDevice: false,
      error: 'Push notifications are not supported on web in this app.',
    };
  }

  const isPhysicalDevice = Device.isDevice;
  const projectId = getExpoProjectId();
  const permission = options?.requestPermission
    ? await requestNotificationPermissionSnapshot()
    : await getNotificationPermissionSnapshot();

  if (!permission.granted) {
    return {
      deviceId,
      projectId,
      expoPushToken: null,
      permission,
      isPhysicalDevice,
      error: null,
    };
  }

  if (!isPhysicalDevice) {
    return {
      deviceId,
      projectId,
      expoPushToken: null,
      permission,
      isPhysicalDevice,
      error: 'Remote push notifications require a physical device.',
    };
  }

  if (!projectId) {
    return {
      deviceId,
      projectId: null,
      expoPushToken: null,
      permission,
      isPhysicalDevice,
      error: 'EAS projectId is missing; Expo push token registration cannot complete.',
    };
  }

  if (options?.tokenOverride) {
    await setupNotificationChannels();
    return {
      deviceId,
      projectId,
      expoPushToken: options.tokenOverride,
      permission,
      isPhysicalDevice,
      error: null,
    };
  }

  try {
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    await setupNotificationChannels();

    return {
      deviceId,
      projectId,
      expoPushToken: tokenData.data,
      permission,
      isPhysicalDevice,
      error: null,
    };
  } catch (error) {
    return {
      deviceId,
      projectId,
      expoPushToken: null,
      permission,
      isPhysicalDevice,
      error: parseRegistrationError(error),
    };
  }
};

export const syncCurrentDeviceRegistration = async (
  options?: { requestPermission?: boolean; tokenOverride?: string | null },
): Promise<NotificationRegistrationAttempt> => {
  const attempt = await createNotificationRegistrationAttempt(options);

  try {
    await syncNotificationDeviceCallable({
      deviceId: attempt.deviceId,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      expoPushToken: attempt.expoPushToken,
      permissionState: attempt.permission.state,
      projectId: attempt.projectId,
      appVersion: getAppVersion(),
      deviceName: Device.deviceName ?? null,
      modelName: Device.modelName ?? null,
      isPhysicalDevice: attempt.isPhysicalDevice,
      lastRegistrationError: attempt.error,
    });
  } catch (error) {
    throw normalizeCallableError('syncNotificationDevice', error);
  }

  return attempt;
};

export const unregisterCurrentDevice = async (): Promise<void> => {
  const deviceId = await getOrCreateInstallationId();
  try {
    await unregisterNotificationDeviceCallable({ deviceId });
  } catch (error) {
    throw normalizeCallableError('unregisterNotificationDevice', error);
  }
};

export const sendRemoteTestPush = async (): Promise<SendTestPushNotificationResponse> => {
  try {
    const response = await sendTestPushNotificationCallable({});
    return response.data;
  } catch (error) {
    throw normalizeCallableError('sendTestPushNotification', error);
  }
};

const normalizeDeviceRecord = (
  userId: string,
  deviceId: string,
  data: Record<string, unknown>,
): NotificationDeviceRecord => ({
  deviceId,
  userId,
  platform: data.platform === 'android' ? 'android' : 'ios',
  expoPushToken: typeof data.expoPushToken === 'string' ? data.expoPushToken : null,
  permissionState:
    data.permissionState === 'granted' ||
    data.permissionState === 'provisional' ||
    data.permissionState === 'ephemeral' ||
    data.permissionState === 'denied'
      ? data.permissionState
      : 'undetermined',
  registrationStatus:
    data.registrationStatus === 'active' ||
    data.registrationStatus === 'permission_blocked' ||
    data.registrationStatus === 'token_missing' ||
    data.registrationStatus === 'invalid_token' ||
    data.registrationStatus === 'signed_out'
      ? data.registrationStatus
      : 'error',
  isPhysicalDevice: data.isPhysicalDevice === true,
  projectId: typeof data.projectId === 'string' ? data.projectId : null,
  appVersion: typeof data.appVersion === 'string' ? data.appVersion : null,
  deviceName: typeof data.deviceName === 'string' ? data.deviceName : null,
  modelName: typeof data.modelName === 'string' ? data.modelName : null,
  lastRegistrationError:
    typeof data.lastRegistrationError === 'string' ? data.lastRegistrationError : null,
  lastDeliveryId: typeof data.lastDeliveryId === 'string' ? data.lastDeliveryId : null,
  lastDeliveryAt: toMillis(data.lastDeliveryAt),
  lastReceiptStatus:
    data.lastReceiptStatus === 'ok' || data.lastReceiptStatus === 'error' || data.lastReceiptStatus === 'pending'
      ? data.lastReceiptStatus
      : null,
  lastReceiptError: typeof data.lastReceiptError === 'string' ? data.lastReceiptError : null,
  lastReceiptAt: toMillis(data.lastReceiptAt),
  lastRegisteredAt: toMillis(data.lastRegisteredAt),
  lastTokenRefreshAt: toMillis(data.lastTokenRefreshAt),
  invalidatedAt: toMillis(data.invalidatedAt),
  invalidationReason: typeof data.invalidationReason === 'string' ? data.invalidationReason : null,
  updatedAt: toMillis(data.updatedAt),
  createdAt: toMillis(data.createdAt),
});

export const subscribeToCurrentDeviceRecord = async (
  userId: string,
  onChange: (device: NotificationDeviceRecord | null) => void,
): Promise<Unsubscribe> => {
  const deviceId = await getOrCreateInstallationId();
  const deviceRef = doc(db, 'users', userId, 'notificationDevices', deviceId);

  return onSnapshot(deviceRef, (snapshot) => {
    if (!snapshot.exists()) {
      onChange(null);
      return;
    }

    onChange(normalizeDeviceRecord(userId, deviceId, snapshot.data()));
  });
};
