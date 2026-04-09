import { useAuth } from '@/context/AuthContext';
import { db } from '@/firebase';
import type {
  NotificationDeviceRecord,
  NotificationPreference,
} from '@/models';
import {
  getNotificationPermissionSnapshot,
  type NotificationPermissionSnapshot,
  sendRemoteTestPush,
  subscribeToCurrentDeviceRecord,
  syncCurrentDeviceRegistration,
} from '@/services/notificationService';
import {
  clearBadgeCount,
  scheduleLocalNotification,
  type NotificationData,
  type NotificationType,
} from '@/utils/notifications';
import * as Notifications from 'expo-notifications';
import { doc, onSnapshot, updateDoc } from 'firebase/firestore';
import { AppState, Linking, Platform } from 'react-native';
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

interface RemoteTestPushResult {
  deliveryId: string;
  acceptedCount: number;
  targetedDeviceCount: number;
  droppedCount: number;
  pendingReceiptCount: number;
}

interface NotificationContextValue {
  preferences: NotificationPreference;
  pushToken: string | null;
  permissionGranted: boolean;
  permission: NotificationPermissionSnapshot;
  currentDevice: NotificationDeviceRecord | null;
  refreshRegistration: (options?: { requestPermission?: boolean }) => Promise<void>;
  openSystemSettings: () => Promise<void>;
  updatePreference: <K extends keyof NotificationPreference>(
    key: K,
    value: NotificationPreference[K],
  ) => Promise<void>;
  clearBadge: () => Promise<void>;
  sendLocalTestNotification: () => Promise<void>;
  sendRemoteTestNotification: () => Promise<RemoteTestPushResult>;
  pendingNavigation: NotificationData | null;
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

const DEFAULT_PERMISSION: NotificationPermissionSnapshot = {
  state: 'undetermined',
  granted: false,
  canAskAgain: true,
  allowsAlert: null,
  allowsBadge: null,
  allowsSound: null,
};

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

type RegistrationSyncOptions = {
  requestPermission?: boolean;
  tokenOverride?: string | null;
};

const mergeRegistrationSyncOptions = (
  current: RegistrationSyncOptions | null,
  incoming: RegistrationSyncOptions | undefined,
): RegistrationSyncOptions => ({
  requestPermission: (current?.requestPermission ?? false) || (incoming?.requestPermission ?? false),
  tokenOverride: incoming?.tokenOverride ?? current?.tokenOverride ?? null,
});

export const NotificationProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const [preferences, setPreferences] = useState<NotificationPreference>(DEFAULT_PREFERENCES);
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermissionSnapshot>(DEFAULT_PERMISSION);
  const [currentDevice, setCurrentDevice] = useState<NotificationDeviceRecord | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<NotificationData | null>(null);

  const notificationListenerRef = useRef<Notifications.EventSubscription | null>(null);
  const responseListenerRef = useRef<Notifications.EventSubscription | null>(null);
  const currentDeviceRef = useRef<NotificationDeviceRecord | null>(null);
  const syncInFlightRef = useRef<Promise<void> | null>(null);
  const queuedSyncOptionsRef = useRef<RegistrationSyncOptions | null>(null);
  const lastSyncStartedAtRef = useRef(0);

  useEffect(() => {
    if (!user) {
      setPreferences(DEFAULT_PREFERENCES);
      return;
    }

    const unsubscribe = onSnapshot(
      doc(db, 'users', user.userId),
      (docSnap) => {
        if (!docSnap.exists()) {
          setPreferences(DEFAULT_PREFERENCES);
          return;
        }

        const data = docSnap.data();
        if (data?.preferences) {
          setPreferences({ ...DEFAULT_PREFERENCES, ...data.preferences });
        } else {
          setPreferences(DEFAULT_PREFERENCES);
        }
      },
      (error) => {
        console.warn('Failed to sync notification preferences:', error);
      },
    );

    return () => unsubscribe();
  }, [user?.userId]);

  useEffect(() => {
    currentDeviceRef.current = currentDevice;
  }, [currentDevice]);

  const refreshRegistration = useCallback(
    async (options?: RegistrationSyncOptions) => {
      if (!user) {
        queuedSyncOptionsRef.current = null;
        setPermission(DEFAULT_PERMISSION);
        setCurrentDevice(null);
        setPushToken(null);
        return;
      }

      const requestedOptions = mergeRegistrationSyncOptions(null, options);

      if (syncInFlightRef.current) {
        queuedSyncOptionsRef.current = mergeRegistrationSyncOptions(queuedSyncOptionsRef.current, requestedOptions);
        await syncInFlightRef.current;
        return;
      }

      const runSyncLoop = async () => {
        let nextOptions: RegistrationSyncOptions | null = requestedOptions;

        while (nextOptions) {
          queuedSyncOptionsRef.current = null;
          lastSyncStartedAtRef.current = Date.now();

          try {
            const attempt = await syncCurrentDeviceRegistration(nextOptions);
            setPermission(attempt.permission);
            setPushToken(attempt.expoPushToken ?? currentDeviceRef.current?.expoPushToken ?? null);
          } catch (error) {
            console.warn('Failed to sync notification device registration', error);
          }

          nextOptions = queuedSyncOptionsRef.current;
        }
      };

      const syncPromise = runSyncLoop().finally(() => {
        syncInFlightRef.current = null;
      });

      syncInFlightRef.current = syncPromise;
      await syncPromise;
    },
    [user?.userId],
  );

  useEffect(() => {
    if (!user) {
      currentDeviceRef.current = null;
      queuedSyncOptionsRef.current = null;
      setPushToken(null);
      setPermission(DEFAULT_PERMISSION);
      setCurrentDevice(null);
      return;
    }

    let isMounted = true;
    let unsubscribeDevice: () => void = () => {};
    let appStateSubscription: { remove: () => void } | null = null;
    let pushTokenSubscription: Notifications.EventSubscription | null = null;

    const setup = async () => {
      try {
        const permissionSnapshot = await getNotificationPermissionSnapshot();
        if (isMounted) {
          setPermission(permissionSnapshot);
        }

        unsubscribeDevice = await subscribeToCurrentDeviceRecord(user.userId, (device) => {
          if (!isMounted) {
            return;
          }
          setCurrentDevice(device);
          setPushToken(device?.expoPushToken ?? null);
        });

        await refreshRegistration();

        pushTokenSubscription = Notifications.addPushTokenListener(({ data }) => {
          if (typeof data === 'string' && data.trim().length > 0) {
            void refreshRegistration({ tokenOverride: data }).catch((error) => {
              console.error('Failed to sync refreshed push token', error);
            });
          }
        });

        appStateSubscription = AppState.addEventListener('change', (nextState) => {
          if (nextState === 'active') {
            if (Date.now() - lastSyncStartedAtRef.current < 2500) {
              return;
            }
            void refreshRegistration().catch((error) => {
              console.error('Failed to refresh notification status on foreground', error);
            });
          }
        });
      } catch (error) {
        console.error('Failed to initialize notification registration', error);
      }
    };

    void setup();

    return () => {
      isMounted = false;
      unsubscribeDevice();
      pushTokenSubscription?.remove();
      appStateSubscription?.remove();
    };
  }, [refreshRegistration, user?.userId]);

  useEffect(() => {
    notificationListenerRef.current = Notifications.addNotificationReceivedListener((notification) => {
      console.log('Notification received (foreground):', notification.request.content.title);
    });

    responseListenerRef.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as NotificationData | undefined;
      if (data?.type) {
        setPendingNavigation(data);
      }
    });

    const checkInitialNotification = async () => {
      const lastResponse = await Notifications.getLastNotificationResponseAsync();
      const data = lastResponse?.notification.request.content.data as NotificationData | undefined;
      if (data?.type) {
        setPendingNavigation(data);
      }
    };

    void checkInitialNotification();

    return () => {
      notificationListenerRef.current?.remove();
      responseListenerRef.current?.remove();
    };
  }, []);

  const updatePreference = useCallback(
    async <K extends keyof NotificationPreference>(key: K, value: NotificationPreference[K]) => {
      if (!user) return;

      const previousValue = preferences[key];
      setPreferences((prev) => ({ ...prev, [key]: value }));

      try {
        await updateDoc(doc(db, 'users', user.userId), {
          [`preferences.${key}`]: value,
        });
      } catch (error) {
        console.error('Failed to update notification preference:', error);
        setPreferences((prev) => ({ ...prev, [key]: previousValue }));
      }
    },
    [preferences, user?.userId],
  );

  const clearBadge = useCallback(async () => {
    await clearBadgeCount();
  }, []);

  const sendLocalTestNotification = useCallback(async () => {
    await scheduleLocalNotification(
      'ManaSplit local notification test',
      'This preview confirms in-app presentation, sound, and tap handling on this device.',
      { type: 'general' as NotificationType },
      'general',
    );
  }, []);

  const sendRemoteTestNotification = useCallback(async (): Promise<RemoteTestPushResult> => {
    const result = await sendRemoteTestPush();
    return result;
  }, []);

  const consumeNavigation = useCallback(() => {
    setPendingNavigation(null);
  }, []);

  const openSystemSettings = useCallback(async () => {
    if (Platform.OS === 'ios') {
      await Linking.openURL('app-settings:');
      return;
    }

    await Linking.openSettings();
  }, []);

  const value = useMemo<NotificationContextValue>(
    () => ({
      preferences,
      pushToken,
      permissionGranted: permission.granted,
      permission,
      currentDevice,
      refreshRegistration,
      openSystemSettings,
      updatePreference,
      clearBadge,
      sendLocalTestNotification,
      sendRemoteTestNotification,
      pendingNavigation,
      consumeNavigation,
    }),
    [
      preferences,
      pushToken,
      permission,
      currentDevice,
      refreshRegistration,
      openSystemSettings,
      updatePreference,
      clearBadge,
      sendLocalTestNotification,
      sendRemoteTestNotification,
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

export const useNotificationContext = () => {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotificationContext must be used inside NotificationProvider');
  }
  return context;
};
