import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
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

const firebaseConfig = Constants.expoConfig?.extra?.firebase ?? Constants?.manifest?.extra?.firebase;

if (!firebaseConfig) {
  console.warn('Firebase config is missing. Populate EXPO_PUBLIC_FIREBASE_* env vars.');
}

const app: FirebaseApp = getApps().length === 0 ? initializeApp(firebaseConfig ?? {}) : getApp();

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
