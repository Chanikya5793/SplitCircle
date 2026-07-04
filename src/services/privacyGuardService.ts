/**
 * privacyGuardService.ts — settings + state for the hidden "shake to hide"
 * privacy guard.
 *
 * When armed, a firm shake of the device scrambles or vanishes the chosen
 * surfaces (expenses, charts, calls, friends, chats — or the whole app).
 * Everything lives on-device: the feature is invisible until unlocked with a
 * secret code from a hidden entry point in Settings (7 taps on the version
 * footer). The active flag persists, so relaunching the app keeps the guard
 * up until the code is entered.
 *
 * The code is stored as a SHA-256 hash — this shields against shoulder-surf
 * of the storage file, not a determined attacker with the device unlocked
 * (same threat model as WhatsApp's chat lock).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const STORAGE_KEY = 'privacy_guard_v1';

export type GuardAction = 'scramble' | 'vanish';
export type GuardSensitivity = 'gentle' | 'normal' | 'vigorous';

export interface GuardTargets {
  expenses: boolean;
  charts: boolean;
  calls: boolean;
  friends: boolean;
  chats: boolean;
  everything: boolean;
}

export interface PrivacyGuardSettings {
  /** Master switch — when false, shaking does nothing. */
  enabled: boolean;
  /** SHA-256 hash of the secret code; null until first setup. */
  codeHash: string | null;
  action: GuardAction;
  targets: GuardTargets;
  sensitivity: GuardSensitivity;
  /** Whether the guard is currently tripped (persists across relaunches). */
  active: boolean;
}

export const DEFAULT_GUARD_SETTINGS: PrivacyGuardSettings = {
  enabled: false,
  codeHash: null,
  action: 'scramble',
  targets: { expenses: true, charts: true, calls: false, friends: false, chats: false, everything: false },
  sensitivity: 'normal',
  active: false,
};

/** Acceleration magnitude (in g) that counts as a shake, per sensitivity. */
export const SHAKE_THRESHOLDS: Record<GuardSensitivity, number> = {
  gentle: 1.8,
  normal: 2.6,
  vigorous: 3.4,
};

let cache: PrivacyGuardSettings | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const onGuardChanged = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getGuardSync = (): PrivacyGuardSettings => cache ?? DEFAULT_GUARD_SETTINGS;

export const hydrateGuard = async (): Promise<PrivacyGuardSettings> => {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    cache = raw
      ? { ...DEFAULT_GUARD_SETTINGS, ...(JSON.parse(raw) as Partial<PrivacyGuardSettings>) }
      : { ...DEFAULT_GUARD_SETTINGS };
  } catch {
    cache = { ...DEFAULT_GUARD_SETTINGS };
  }
  notify();
  return cache;
};

export const updateGuard = async (patch: Partial<PrivacyGuardSettings>): Promise<void> => {
  const next = { ...(cache ?? DEFAULT_GUARD_SETTINGS), ...patch };
  cache = next;
  notify();
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // In-memory state still applies this session.
  }
};

export const hashCode = async (code: string): Promise<string> =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `splitcircle-guard:${code.trim()}`);

export const verifyCode = async (code: string): Promise<boolean> => {
  const settings = getGuardSync();
  if (!settings.codeHash) return false;
  return (await hashCode(code)) === settings.codeHash;
};
