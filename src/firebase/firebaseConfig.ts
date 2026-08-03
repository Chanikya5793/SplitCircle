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

/**
 * `ignoreUndefinedProperties` — a field whose value is `undefined` is SKIPPED
 * rather than throwing.
 *
 * Without it the SDK rejects the whole write with "Unsupported field value:
 * undefined", and an optional field spread from a source object is the ordinary
 * way to produce one. That took out chat creation entirely for anyone with no
 * profile photo: `photoURL: member.photoURL` on an avatar-less member threw
 * before the write left the device, so you could not start a group chat or a DM
 * with them at all.
 *
 * A blanket setting rather than only fixing those call sites, because the call
 * sites are not the point — there were six building participants by hand and
 * one had it right. Any optional field, anywhere, is the same landmine.
 *
 * The trade-off, stated plainly: a field you MEANT to write but computed as
 * undefined is now silently dropped instead of throwing. That is strictly
 * better than today, where it takes the entire document with it — and clearing
 * a field was never `undefined`'s job anyway; `deleteField()` does that, and
 * still does.
 */
const db: Firestore = Platform.OS === 'web'
  ? initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
        cacheSizeBytes: CACHE_SIZE_UNLIMITED,
      }),
    })
  : initializeFirestore(app, {
      ignoreUndefinedProperties: true,
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
