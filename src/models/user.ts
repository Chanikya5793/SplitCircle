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
  /**
   * Per-user group archive (Splitwise-style). Lives on the user doc because
   * firestore.rules key-restricts group doc updates — clients cannot add an
   * `archived` flag there without a rules deploy. Archived groups stay fully
   * functional (balances still count); they are just tucked away in the UI.
   */
  archivedGroupIds?: string[];
  /**
   * Per-user chat archive: chatId → ms epoch when archived. Stored as a map
   * (not an array) so chats can auto-unarchive WhatsApp-style: a thread whose
   * lastMessage.timestamp is newer than its archivedAt renders as unarchived.
   */
  archivedChats?: Record<string, number>;
  /**
   * Per-user pinned chats: chatId → ms epoch when pinned. Pinned chats float
   * in a cluster at the top of the active list, ordered by pin time (most
   * recently pinned first). Same user-doc storage rationale as archivedChats.
   */
  pinnedChats?: Record<string, number>;
  /**
   * Per-user locked chats: chatId → ms epoch when locked. Locked chats never
   * render in the normal list; they live behind a biometric-gated "Locked"
   * folder. Stored on the user doc so the state syncs across the user's
   * devices (the biometric unlock itself is always device-local).
   */
  lockedChats?: Record<string, number>;
}
