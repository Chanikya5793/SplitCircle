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
/** How scrambled TEXT renders: dots ••••, blocks ████, or garble (fake but
 *  plausible characters — deterministic per string, so the UI stays stable). */
export type GuardTextStyle = 'dots' | 'blocks' | 'garble';
/** How scrambled AMOUNTS render: dots, zeros, or decoy (fake but plausible). */
export type GuardAmountStyle = 'dots' | 'zeros' | 'decoy';

export interface GuardScope {
  /** all = every entity; only = just ids; except = everything but ids. */
  mode: 'all' | 'only' | 'except';
  ids: string[];
}

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
  textStyle: GuardTextStyle;
  amountStyle: GuardAmountStyle;
  /** Scramble names too (group names, chat titles, people). */
  hideNames: boolean;
  /** Replace profile/group photos with plain initials. */
  hidePhotos: boolean;
  /** Hide last-message previews in the chat list. */
  hidePreviews: boolean;
  /** Revert custom wallpapers/backgrounds to the default liquid background. */
  hideWallpaper: boolean;
  /** Hide the user's own profile photo + email in Settings. */
  hideProfile: boolean;
  /** Which expense groups the guard touches. */
  groupScope: GuardScope;
  /** Which conversations the guard touches. */
  chatScope: GuardScope;
  /** Trip automatically whenever the app goes to the background. */
  rearmOnBackground: boolean;
  /** Allow Face ID / Touch ID as an alternative to the secret code. */
  biometricUnlock: boolean;
}

export const DEFAULT_GUARD_SETTINGS: PrivacyGuardSettings = {
  enabled: false,
  codeHash: null,
  action: 'scramble',
  targets: { expenses: true, charts: true, calls: false, friends: false, chats: false, everything: false },
  sensitivity: 'normal',
  active: false,
  textStyle: 'garble',
  amountStyle: 'dots',
  hideNames: false,
  hidePhotos: false,
  hidePreviews: true,
  hideWallpaper: false,
  hideProfile: false,
  groupScope: { mode: 'all', ids: [] },
  chatScope: { mode: 'all', ids: [] },
  rearmOnBackground: false,
  biometricUnlock: false,
};

/** Whether an entity id falls inside a scope. */
export const inScope = (scope: GuardScope, id: string | undefined): boolean => {
  if (!id || scope.mode === 'all') return true;
  const listed = scope.ids.includes(id);
  return scope.mode === 'only' ? listed : !listed;
};

// ---------------------------------------------------------------------------
// Disguise primitives — deterministic per input so the UI is stable frame to
// frame and across screens (a garbled name always garbles the same way).

const mulberry = (seedInput: string) => {
  let seed = 2166136261 >>> 0;
  for (let i = 0; i < seedInput.length; i++) {
    seed = Math.imul(seed ^ seedInput.charCodeAt(i), 16777619) >>> 0;
  }
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
};

const CONSONANTS = 'bcdfghklmnprstvz';
const VOWELS = 'aeiou';

/** Fake-but-plausible text: keeps length, casing and word breaks. */
export const garbleText = (input: string): string => {
  const rand = mulberry(`garble:${input}`);
  let out = '';
  let useVowel = rand() > 0.5;
  for (const ch of input) {
    if (!/[a-z0-9]/i.test(ch)) {
      out += ch;
      useVowel = rand() > 0.5;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      out += String(Math.floor(rand() * 10));
      continue;
    }
    const pool = useVowel ? VOWELS : CONSONANTS;
    const c = pool[Math.floor(rand() * pool.length)];
    out += ch === ch.toUpperCase() ? c.toUpperCase() : c;
    useVowel = !useVowel && rand() > 0.3;
  }
  return out;
};

/** Redacted text in the configured style. */
export const maskTextValue = (input: string, style: GuardTextStyle): string => {
  if (style === 'garble') return garbleText(input);
  const glyph = style === 'blocks' ? '█' : '•';
  const len = Math.max(4, Math.min(input.length, 14));
  return glyph.repeat(len);
};

/** Decoy amount: plausible, stable for a given real value. */
export const decoyAmount = (value: number): number => {
  const rand = mulberry(`decoy:${value.toFixed(4)}`);
  const magnitude = Math.abs(value) < 1 ? 10 : Math.abs(value) < 100 ? 100 : 1000;
  const fake = Math.round((rand() * magnitude + magnitude * 0.05) * 100) / 100;
  return value < 0 ? -fake : fake;
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
