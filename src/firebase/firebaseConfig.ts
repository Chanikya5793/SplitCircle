import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
import {
    getAuth,
    initializeAuth,
    type Auth,
    type Persistence,
} from 'firebase/auth';
import {
    CACHE_SIZE_UNLIMITED,
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    type Firestore,
} from 'firebase/firestore';
import { getMessaging, isSupported, type Messaging } from 'firebase/messaging';
import { getStorage, type FirebaseStorage } from 'firebase/storage';
import { Platform } from 'react-native';

const firebaseConfig = Constants.expoConfig?.extra?.firebase ?? Constants?.manifest?.extra?.firebase;

if (!firebaseConfig) {
  console.warn('Firebase config is missing. Populate EXPO_PUBLIC_FIREBASE_* env vars.');
}

type ReactNativePersistence = {
  type: 'LOCAL';
  _isAvailable: () => Promise<boolean>;
  _set: (key: string, value: unknown) => Promise<void>;
  _get: (key: string) => Promise<unknown>;
  _remove: (key: string) => Promise<void>;
  _addListener: () => void;
  _removeListener: () => void;
};

const asyncStoragePersistence: ReactNativePersistence = {
  type: 'LOCAL',
  async _isAvailable() {
    try {
      const testKey = '__firebase_persistence_test__';
      await AsyncStorage.setItem(testKey, '1');
      await AsyncStorage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  },
  async _set(key, value) {
    if (typeof value === 'string') {
      await AsyncStorage.setItem(key, value);
      return;
    }
    await AsyncStorage.setItem(key, JSON.stringify(value));
  },
  async _get(key) {
    const stored = await AsyncStorage.getItem(key);
    if (!stored) {
      return null;
    }
    try {
      return JSON.parse(stored);
    } catch {
      return stored;
    }
  },
  async _remove(key) {
    await AsyncStorage.removeItem(key);
  },
  _addListener() {
    // AsyncStorage has no native change listeners; no-op for RN
  },
  _removeListener() {
    // Matching no-op for subscription removal
  },
};

const app: FirebaseApp = getApps().length === 0 ? initializeApp(firebaseConfig ?? {}) : getApp();

let auth: Auth;
if (Platform.OS === 'web') {
  auth = getAuth(app);
} else {
  try {
    auth = initializeAuth(app, {
      persistence: asyncStoragePersistence as unknown as Persistence,
    });
  } catch (error) {
    // Fast refresh may have already initialized the instance – fall back to the existing one.
    auth = getAuth(app);
  }
}

const db: Firestore = initializeFirestore(app, {
  experimentalForceLongPolling: Platform.OS !== 'web',
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
    cacheSizeBytes: CACHE_SIZE_UNLIMITED,
  }),
});

const storage: FirebaseStorage = getStorage(app);

let messagingPromise: Promise<Messaging | null> | null = null;

export const getMessagingInstance = async (): Promise<Messaging | null> => {
  if (Platform.OS !== 'web') {
    return null; // Firebase messaging only works on the native layers via FCM
  }
  if (!messagingPromise) {
    messagingPromise = (async () => {
      if (!(await isSupported())) {
        return null;
      }
      return getMessaging(app);
    })();
  }
  return messagingPromise;
};

export { app, auth, db, storage };
