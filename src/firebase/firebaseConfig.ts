import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { FirebaseApp, getApp, getApps, initializeApp, type FirebaseOptions } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import * as FirebaseAuth from 'firebase/auth';
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

type LegacyManifestExtra = {
  firebase?: Record<string, string>;
};

const legacyExtra = (Constants as unknown as { manifest?: { extra?: LegacyManifestExtra } }).manifest?.extra;
const rawFirebaseConfig = Constants.expoConfig?.extra?.firebase ?? legacyExtra?.firebase;

const getValidatedFirebaseConfig = (config: Record<string, unknown> | undefined): FirebaseOptions => {
  if (!config) {
    throw new Error(
      'Firebase config is missing. Set EXPO_PUBLIC_FIREBASE_* env vars before starting the app.'
    );
  }

  const requiredKeys = [
    'apiKey',
    'authDomain',
    'projectId',
    'storageBucket',
    'messagingSenderId',
    'appId',
  ] as const;

  for (const key of requiredKeys) {
    const value = config[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Firebase config is invalid. Missing required field: ${key}`);
    }
  }

  return {
    apiKey: String(config.apiKey).trim(),
    authDomain: String(config.authDomain).trim(),
    projectId: String(config.projectId).trim(),
    storageBucket: String(config.storageBucket).trim(),
    messagingSenderId: String(config.messagingSenderId).trim(),
    appId: String(config.appId).trim(),
    ...(typeof config.measurementId === 'string' && config.measurementId.trim().length > 0
      ? { measurementId: config.measurementId.trim() }
      : {}),
  };
};

const firebaseConfig = getValidatedFirebaseConfig(rawFirebaseConfig);

const app: FirebaseApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

let auth: Auth;
// @ts-expect-error: getReactNativePersistence exists in the runtime export for React Native
const { getAuth, initializeAuth, getReactNativePersistence } = FirebaseAuth;

if (Platform.OS === 'web') {
  auth = getAuth(app);
} else {
  try {
    auth = initializeAuth(app, {
      persistence: getReactNativePersistence(AsyncStorage),
    });
  } catch (error) {
    auth = getAuth(app);
  }
}

const db: Firestore = Platform.OS === 'web'
  ? initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
        cacheSizeBytes: CACHE_SIZE_UNLIMITED,
      }),
    })
  : initializeFirestore(app, {
      experimentalForceLongPolling: true,
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
