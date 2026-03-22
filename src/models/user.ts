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
