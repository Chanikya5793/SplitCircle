import { db } from '@/firebase';
import {
  type SettingsSyncKey,
  getSettingScope,
} from '@/config/settingsSyncRegistry';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type FirestoreError,
} from 'firebase/firestore';

/**
 * Reads/writes per-device-setting values per the sync/local split declared in
 * `@/config/settingsSyncRegistry` (doc 31 §3.8).
 *
 * 'synced' settings live at Firestore `users/{uid}/settings/{key}` — one
 * flat doc per key ({value, updatedAt}), never a nested map, so a plain
 * `setDoc` (full overwrite) is safe without the merge:true/mergeFields
 * shrink gotcha ever coming into play (see firestore.rules' comment on this
 * collection).
 *
 * 'local' settings live in AsyncStorage only, scoped to this device — no
 * cross-device concept applies, so there's nothing to subscribe to.
 */

const LOCAL_KEY_PREFIX = 'setting_local_';

const settingsCollection = (userId: string) => collection(db, 'users', userId, 'settings');
const settingDoc = (userId: string, key: SettingsSyncKey) => doc(settingsCollection(userId), key);
const localStorageKey = (key: SettingsSyncKey) => `${LOCAL_KEY_PREFIX}${key}`;

interface SettingValueDoc<T> {
  value: T;
  updatedAt?: unknown;
}

export const getSetting = async <T,>(
  userId: string,
  key: SettingsSyncKey,
  defaultValue: T,
): Promise<T> => {
  if (getSettingScope(key) === 'local') {
    const raw = await AsyncStorage.getItem(localStorageKey(key));
    if (raw === null) return defaultValue;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return defaultValue;
    }
  }

  const snap = await getDoc(settingDoc(userId, key));
  if (!snap.exists()) return defaultValue;
  const data = snap.data() as SettingValueDoc<T>;
  return data.value ?? defaultValue;
};

export const setSetting = async <T,>(
  userId: string,
  key: SettingsSyncKey,
  value: T,
): Promise<void> => {
  if (getSettingScope(key) === 'local') {
    await AsyncStorage.setItem(localStorageKey(key), JSON.stringify(value));
    return;
  }

  await setDoc(settingDoc(userId, key), {
    value,
    updatedAt: serverTimestamp(),
  });
};

/**
 * Live updates for a 'synced' setting only — a 'local' setting has no other
 * device to hear from, so this resolves once from AsyncStorage and never
 * fires again. Callers that need live local updates should react to their
 * own setSetting calls directly instead of relying on this subscription.
 */
export const subscribeToSetting = <T,>(
  userId: string,
  key: SettingsSyncKey,
  defaultValue: T,
  onChange: (value: T) => void,
  onError?: (error: FirestoreError) => void,
): (() => void) => {
  if (getSettingScope(key) === 'local') {
    void getSetting(userId, key, defaultValue).then(onChange);
    return () => {};
  }

  return onSnapshot(
    settingDoc(userId, key),
    (snap) => {
      if (!snap.exists()) {
        onChange(defaultValue);
        return;
      }
      const data = snap.data() as SettingValueDoc<T>;
      onChange(data.value ?? defaultValue);
    },
    (error) => onError?.(error),
  );
};
