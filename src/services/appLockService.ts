/**
 * appLockService.ts — WhatsApp-style whole-app biometric lock settings.
 *
 * Separate from the shake privacy guard: this locks the ENTIRE app behind
 * Face ID / Touch ID on launch and after the app has been backgrounded past
 * the chosen timeout. Device-local (AsyncStorage), never synced.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'app_lock_v1';

/** Auto-lock delay presets (ms). 0 = lock immediately on leaving. */
export const AUTO_LOCK_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Immediately' },
  { value: 60_000, label: 'After 1 minute' },
  { value: 900_000, label: 'After 15 minutes' },
  { value: 3_600_000, label: 'After 1 hour' },
];

export interface AppLockSettings {
  enabled: boolean;
  /** Auto-lock delay in ms after backgrounding. */
  autoLockMs: number;
  /**
   * Require a biometric (Face ID / Touch ID) confirmation before finalizing a
   * settlement. Independent of the whole-app lock — stored here to reuse the
   * same device-local AsyncStorage record. Defaults OFF.
   */
  confirmSettlements: boolean;
}

export const DEFAULT_APP_LOCK: AppLockSettings = {
  enabled: false,
  autoLockMs: 0,
  confirmSettlements: false,
};

let cache: AppLockSettings | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const onAppLockChanged = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getAppLockSync = (): AppLockSettings => cache ?? DEFAULT_APP_LOCK;

export const hydrateAppLock = async (): Promise<AppLockSettings> => {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    cache = raw ? { ...DEFAULT_APP_LOCK, ...(JSON.parse(raw) as Partial<AppLockSettings>) } : { ...DEFAULT_APP_LOCK };
  } catch {
    cache = { ...DEFAULT_APP_LOCK };
  }
  notify();
  return cache;
};

export const updateAppLock = async (patch: Partial<AppLockSettings>): Promise<void> => {
  const next = { ...(cache ?? DEFAULT_APP_LOCK), ...patch };
  cache = next;
  notify();
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // In-memory value still applies this session.
  }
};
