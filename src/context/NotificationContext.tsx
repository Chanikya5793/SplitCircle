import { useAuth } from '@/context/AuthContext';
import { db } from '@/firebase';
import type { NotificationPreference } from '@/models';
import {
  clearBadgeCount,
  registerForPushNotificationsAsync,
  scheduleLocalNotification,
  type NotificationData,
  type NotificationType,
} from '@/utils/notifications';
import * as Notifications from 'expo-notifications';
import { doc, onSnapshot, updateDoc } from 'firebase/firestore';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface NotificationContextValue {
  /** Current notification preferences (synced from Firestore) */
  preferences: NotificationPreference;
  /** Push token (null until registered) */
  pushToken: string | null;
  /** Whether the device has notification permission */
  permissionGranted: boolean;
  /** Update a single notification preference key */
  updatePreference: <K extends keyof NotificationPreference>(
    key: K,
    value: NotificationPreference[K],
  ) => Promise<void>;
  /** Clear app badge count */
  clearBadge: () => Promise<void>;
  /** Send a test notification locally */
  sendTestNotification: () => Promise<void>;
  /** Pending deep-link data from a tapped notification */
  pendingNavigation: NotificationData | null;
  /** Clear the pending navigation after it has been consumed */
  consumeNavigation: () => void;
}

const DEFAULT_PREFERENCES: NotificationPreference = {
  pushEnabled: false,
  emailEnabled: true,
  messages: true,
  expenses: true,
  settlements: true,
  groupUpdates: true,
  calls: true,
  sounds: true,
  vibration: true,
};

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

// ─────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────

export const NotificationProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const [preferences, setPreferences] = useState<NotificationPreference>(DEFAULT_PREFERENCES);
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<NotificationData | null>(null);

  const notificationListenerRef = useRef<Notifications.EventSubscription | null>(null);
  const responseListenerRef = useRef<Notifications.EventSubscription | null>(null);

  // ─── Sync preferences from Firestore ─────────────────────
  useEffect(() => {
    if (!user) {
      setPreferences(DEFAULT_PREFERENCES);
      return;
    }

    const unsubscribe = onSnapshot(
      doc(db, 'users', user.userId),
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data?.preferences) {
            setPreferences({ ...DEFAULT_PREFERENCES, ...data.preferences });
          }
        }
      },
      (error) => {
        console.warn('⚠️ Failed to sync notification preferences:', error);
      },
    );

    return () => unsubscribe();
  }, [user?.userId]);

  // ─── Register push token ──────────────────────────────────
  useEffect(() => {
    if (!user) {
      setPushToken(null);
      setPermissionGranted(false);
      return;
    }

    let isMounted = true;

    const syncToken = async () => {
      try {
        const token = await registerForPushNotificationsAsync();
        if (!isMounted) return;

        if (token) {
          setPushToken(token);
          setPermissionGranted(true);

          // Persist token + enable push in Firestore
          await updateDoc(doc(db, 'users', user.userId), {
            pushToken: token,
            'preferences.pushEnabled': true,
          });
        } else {
          setPermissionGranted(false);
        }
      } catch (error) {
        console.error('Failed to register push notifications', error);
      }
    };

    void syncToken();

    return () => {
      isMounted = false;
    };
  }, [user?.userId]);

  // ─── Notification Listeners ───────────────────────────────
  useEffect(() => {
    // Foreground notification received
    notificationListenerRef.current = Notifications.addNotificationReceivedListener((notification) => {
      console.log('🔔 Notification received (foreground):', notification.request.content.title);
    });

    // User tapped on a notification
    responseListenerRef.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as NotificationData | undefined;
      console.log('👆 Notification tapped:', data);

      if (data?.type) {
        setPendingNavigation(data);
      }
    });

    // Check if app was opened from a killed-state notification
    const checkInitialNotification = async () => {
      const lastResponse = await Notifications.getLastNotificationResponseAsync();
      if (lastResponse) {
        const data = lastResponse.notification.request.content.data as NotificationData | undefined;
        if (data?.type) {
          setPendingNavigation(data);
        }
      }
    };

    void checkInitialNotification();

    return () => {
      if (notificationListenerRef.current) {
        notificationListenerRef.current.remove();
      }
      if (responseListenerRef.current) {
        responseListenerRef.current.remove();
      }
    };
  }, []);

  // ─── Update a preference ──────────────────────────────────
  const updatePreference = useCallback(
    async <K extends keyof NotificationPreference>(key: K, value: NotificationPreference[K]) => {
      if (!user) return;

      setPreferences((prev) => ({ ...prev, [key]: value }));

      try {
        await updateDoc(doc(db, 'users', user.userId), {
          [`preferences.${key}`]: value,
        });
      } catch (error) {
        console.error('Failed to update notification preference:', error);
        // Revert optimistic update on failure
        setPreferences((prev) => ({ ...prev, [key]: !value }));
      }
    },
    [user?.userId],
  );

  // ─── Badge ────────────────────────────────────────────────
  const clearBadge = useCallback(async () => {
    await clearBadgeCount();
  }, []);

  // ─── Test Notification ────────────────────────────────────
  const sendTestNotification = useCallback(async () => {
    await scheduleLocalNotification(
      '🎉 Notifications Working!',
      'You will receive push notifications for messages, expenses, and more.',
      { type: 'general' as NotificationType },
      'general',
    );
  }, []);

  // ─── Consume navigation ───────────────────────────────────
  const consumeNavigation = useCallback(() => {
    setPendingNavigation(null);
  }, []);

  // ─── Context Value ────────────────────────────────────────
  const value = useMemo<NotificationContextValue>(
    () => ({
      preferences,
      pushToken,
      permissionGranted,
      updatePreference,
      clearBadge,
      sendTestNotification,
      pendingNavigation,
      consumeNavigation,
    }),
    [
      preferences,
      pushToken,
      permissionGranted,
      updatePreference,
      clearBadge,
      sendTestNotification,
      pendingNavigation,
      consumeNavigation,
    ],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
};

// ─────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────

export const useNotificationContext = () => {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotificationContext must be used inside NotificationProvider');
  }
  return context;
};
