export type PresenceStatus = 'online' | 'offline' | 'busy' | 'away';

export interface LinkedGroup {
  groupId: string;
  name: string;
  lastActive: number;
}

export interface NotificationPreference {
  pushEnabled: boolean;
  emailEnabled: boolean;
  muteChatIds?: string[];
  // Granular per-category toggles (default to true when missing)
  messages?: boolean;
  expenses?: boolean;
  settlements?: boolean;
  groupUpdates?: boolean;
  calls?: boolean;
  sounds?: boolean;
  vibration?: boolean;
}

export type NotificationPermissionState =
  | 'granted'
  | 'provisional'
  | 'ephemeral'
  | 'denied'
  | 'undetermined';

export type NotificationRegistrationStatus =
  | 'active'
  | 'permission_blocked'
  | 'token_missing'
  | 'invalid_token'
  | 'signed_out'
  | 'error';

export type NotificationReceiptStatus = 'ok' | 'error' | 'pending' | null;

export interface NotificationDeviceRecord {
  deviceId: string;
  userId: string;
  platform: 'ios' | 'android';
  expoPushToken: string | null;
  permissionState: NotificationPermissionState;
  registrationStatus: NotificationRegistrationStatus;
  isPhysicalDevice: boolean;
  projectId: string | null;
  appVersion: string | null;
  deviceName: string | null;
  modelName: string | null;
  lastRegistrationError: string | null;
  lastDeliveryId: string | null;
  lastDeliveryAt: number | null;
  lastReceiptStatus: NotificationReceiptStatus;
  lastReceiptError: string | null;
  lastReceiptAt: number | null;
  lastRegisteredAt: number | null;
  lastTokenRefreshAt: number | null;
  invalidatedAt: number | null;
  invalidationReason: string | null;
  updatedAt: number | null;
  createdAt: number | null;
}

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string;
  photoURL: string | null;  // Must be null not undefined for Firestore compatibility
  phoneNumber?: string;
  groups: LinkedGroup[];
  status: PresenceStatus;
  pushToken?: string;
  createdAt: number;
  updatedAt: number;
  preferences: NotificationPreference;
}
