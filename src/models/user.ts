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
}

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string;
  photoURL?: string;
  phoneNumber?: string;
  groups: LinkedGroup[];
  status: PresenceStatus;
  pushToken?: string;
  createdAt: number;
  updatedAt: number;
  preferences: NotificationPreference;
}
