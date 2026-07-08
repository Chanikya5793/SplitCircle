import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  getNotificationPermissionSnapshot,
  requestNotificationPermissionSnapshot,
} from '@/services/notificationService';

// ─────────────────────────────────────────────────────────────
// Notification Channels (Android)
// ─────────────────────────────────────────────────────────────

export const NOTIFICATION_CHANNELS = {
  MESSAGES: 'messages',
  EXPENSES: 'expenses',
  GROUPS: 'groups',
  CALLS: 'calls',
  GENERAL: 'general',
} as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[keyof typeof NOTIFICATION_CHANNELS];

// ─────────────────────────────────────────────────────────────
// Notification Data Types (used in push payloads)
// ─────────────────────────────────────────────────────────────

export type NotificationType =
  | 'message'
  | 'expense'
  | 'settlement'
  | 'group_join'
  | 'call'
  | 'missed_call'
  | 'general';

export interface NotificationData {
  type: NotificationType;
  chatId?: string;
  groupId?: string;
  expenseId?: string;
  settlementId?: string;
  callId?: string;
  callType?: 'audio' | 'video';
  senderId?: string;
  senderName?: string;
}

// ─────────────────────────────────────────────────────────────
// Default handler — show notifications in foreground
// ─────────────────────────────────────────────────────────────

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// ─────────────────────────────────────────────────────────────
// Notification Categories (action buttons — iOS + Android)
// ─────────────────────────────────────────────────────────────
// iOS has no customizable "Message" button on the CallKit lock-screen UI for
// third-party apps (that button is reserved for SMS on phone-number handles).
// The closest platform-sanctioned equivalent: the missed-call push carries
// this category, so pulling the notification down (or long-pressing it)
// reveals a quick-reply text field that sends an in-app chat message back to
// the caller without fully opening the app.

export const MISSED_CALL_CATEGORY_ID = 'missed_call';
export const MISSED_CALL_REPLY_ACTION_ID = 'reply_message';

export const setupNotificationCategories = async (): Promise<void> => {
  if (Platform.OS === 'web') {
    return;
  }

  try {
    await Notifications.setNotificationCategoryAsync(MISSED_CALL_CATEGORY_ID, [
      {
        identifier: MISSED_CALL_REPLY_ACTION_ID,
        buttonTitle: 'Reply',
        textInput: {
          submitButtonTitle: 'Send',
          placeholder: 'Type a message…',
        },
        options: {
          // Handle the reply in the background — WhatsApp-style, no app open.
          // If the app process is dead, iOS wakes it; the reply is delivered
          // via the notification-response listener (or the last-response check
          // on next launch as the fallback).
          opensAppToForeground: false,
        },
      },
    ]);
  } catch (error) {
    console.warn('Failed to register notification categories:', error);
  }
};

// ─────────────────────────────────────────────────────────────
// Setup Android Notification Channels
// ─────────────────────────────────────────────────────────────

export const setupNotificationChannels = async (): Promise<void> => {
  // Categories apply to iOS AND Android — register them on every platform
  // before the Android-only channel setup below.
  await setupNotificationCategories();

  if (Platform.OS !== 'android') {
    return;
  }

  await Promise.allSettled([
    Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNELS.MESSAGES, {
      name: 'Messages',
      description: 'Chat message notifications',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#1F6FEB',
      sound: 'default',
      enableVibrate: true,
      enableLights: true,
    }),
    Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNELS.EXPENSES, {
      name: 'Expenses',
      description: 'New expense and split notifications',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 200, 200],
      lightColor: '#10B981',
      sound: 'default',
      enableVibrate: true,
    }),
    Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNELS.GROUPS, {
      name: 'Groups',
      description: 'Group membership updates',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 150],
      lightColor: '#8B5CF6',
      sound: 'default',
    }),
    Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNELS.CALLS, {
      name: 'Calls',
      description: 'Incoming call notifications',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 500, 500],
      lightColor: '#EF4444',
      sound: 'default',
      enableVibrate: true,
      enableLights: true,
    }),
    Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNELS.GENERAL, {
      name: 'General',
      description: 'General app notifications',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
    }),
  ]);
};

// ─────────────────────────────────────────────────────────────
// Permission Helpers
// ─────────────────────────────────────────────────────────────

export const getNotificationPermissionStatus = async (): Promise<Notifications.PermissionStatus> => {
  const snapshot = await getNotificationPermissionSnapshot();
  switch (snapshot.state) {
    case 'granted':
    case 'provisional':
    case 'ephemeral':
      return 'granted' as Notifications.PermissionStatus;
    case 'denied':
      return 'denied' as Notifications.PermissionStatus;
    default:
      return 'undetermined' as Notifications.PermissionStatus;
  }
};

export const requestNotificationPermission = async (): Promise<boolean> => {
  const snapshot = await requestNotificationPermissionSnapshot();
  return snapshot.granted;
};

// ─────────────────────────────────────────────────────────────
// Badge Management
// ─────────────────────────────────────────────────────────────

export const setBadgeCount = async (count: number): Promise<void> => {
  try {
    await Notifications.setBadgeCountAsync(count);
  } catch {
    // Badge not supported on all platforms
  }
};

export const clearBadgeCount = async (): Promise<void> => {
  await setBadgeCount(0);
};

// ─────────────────────────────────────────────────────────────
// Local Notifications (for test / in-app)
// ─────────────────────────────────────────────────────────────

export const scheduleLocalNotification = async (
  title: string,
  body: string,
  data?: NotificationData,
  channelId?: NotificationChannel,
  categoryId?: string,
): Promise<string> => {
  return Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data: (data as unknown) as Record<string, unknown>,
      sound: 'default',
      ...(categoryId ? { categoryIdentifier: categoryId } : {}),
      ...(Platform.OS === 'android' && channelId
        ? { channelId }
        : {}),
    },
    trigger: null, // immediate
  });
};

// ─────────────────────────────────────────────────────────────
// Dismiss All
// ─────────────────────────────────────────────────────────────

export const dismissAllNotifications = async (): Promise<void> => {
  await Notifications.dismissAllNotificationsAsync();
  await clearBadgeCount();
};
