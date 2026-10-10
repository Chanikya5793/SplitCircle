import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { FirebaseApp, getApp, getApps, initializeApp, type FirebaseOptions } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import * as FirebaseAuth from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase } from 'firebase/database';
import {
    CACHE_SIZE_UNLIMITED,
    connectFirestoreEmulator,
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    type Firestore,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { getMessaging, isSupported, type Messaging } from 'firebase/messaging';
import { connectStorageEmulator, getStorage, type FirebaseStorage } from 'firebase/storage';
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

/**
 * Local Firebase Emulator Suite, for exercising the whole app (auth, data,
 * Cloud Functions, quotas, credits) against a disposable backend.
 *
 * Inert unless `EXPO_PUBLIC_FIREBASE_EMULATOR_HOST` is set when the bundle is
 * BUILT — babel inlines `EXPO_PUBLIC_*`, so a shipped bundle that was built
 * without it cannot be switched over at runtime. The client's project id is
 * replaced with a `demo-` project, which the emulators guarantee never reaches
 * a real Google service. Start the backend with `npm run emulators`.
 */
const emulatorHost = process.env.EXPO_PUBLIC_FIREBASE_EMULATOR_HOST?.trim() || null;
export const FIREBASE_EMULATOR_PROJECT_ID = 'demo-manasplit';

const firebaseConfig: FirebaseOptions = emulatorHost
  ? {
      ...getValidatedFirebaseConfig(rawFirebaseConfig),
      projectId: FIREBASE_EMULATOR_PROJECT_ID,
      databaseURL: `http://${emulatorHost}:9000?ns=${FIREBASE_EMULATOR_PROJECT_ID}`,
      storageBucket: `${FIREBASE_EMULATOR_PROJECT_ID}.appspot.com`,
    }
  : getValidatedFirebaseConfig(rawFirebaseConfig);

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
    // Only reuse a Firebase Auth instance that was already initialized (for
    // example during Fast Refresh). Falling back for any other error can create
    // a memory-only session that appears to sign in and then vanishes on boot.
    if ((error as { code?: string })?.code !== 'auth/already-initialized') {
      throw error;
    }
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

if (emulatorHost) {
  // Every other module reaches these services through the same per-app
  // singletons (`getFunctions(app)`, `getDatabase()`, `getStorage()`), so
  // connecting them once here, before any of them is used, covers the app.
  FirebaseAuth.connectAuthEmulator(auth, `http://${emulatorHost}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, emulatorHost, 8080);
  connectDatabaseEmulator(getDatabase(app), emulatorHost, 9000);
  connectFunctionsEmulator(getFunctions(app), emulatorHost, 5001);
  connectStorageEmulator(storage, emulatorHost, 9199);
  console.error(`[firebase] using the local emulator suite at ${emulatorHost}`);
}

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
