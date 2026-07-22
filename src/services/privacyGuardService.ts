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

export type PanicCorner = 'off' | 'top-left' | 'top-right';

export interface PrivacyGuardSettings {
  /** Master switch — when false, shaking does nothing. */
  enabled: boolean;
  /** SHA-256 hash of the secret code; null until first setup. */
  codeHash: string | null;
  /**
   * Optional SHA-256 hash of a DURESS code. Entering it at any unlock prompt
   * fakes a successful unlock (neutral dismissal, no error) but leaves the
   * guard fully armed — so a coerced "open it" reveals nothing. null = unset.
   */
  duressCodeHash: string | null;
  /** Trip the guard automatically when a screenshot is taken. */
  hideOnScreenshot: boolean;
  /** Blur the app in screen recordings / the app switcher while armed. */
  blockScreenRecording: boolean;
  /** A silent alternative to shaking: triple-tap a hidden screen corner. */
  panicCorner: PanicCorner;
  /** Trip when the phone rests face-down for a moment (flip-to-shush style). */
  flipToHide: boolean;
  /**
   * Auto re-hide: ms after a reveal before the shields raise themselves
   * again (1Password-style auto-lock). 0 = stay revealed until tripped.
   */
  revealTimeoutMs: number;
  /**
   * Salt mixed into every disguise/decoy seed. "Shuffle disguise" rotates it
   * so all fake names and amounts re-randomize — for when someone has
   * already seen the current decoys.
   */
  disguiseSalt: string;
  action: GuardAction;
  targets: GuardTargets;
  sensitivity: GuardSensitivity;
  /** Whether the guard is currently tripped (persists across relaunches). */
  active: boolean;
  /**
   * Duress decoy world: set when the DURESS code was entered at an unlock
   * prompt. The app looks unlocked (no lock panels, no visible masking style)
   * but scoped-sensitive entities are silently absent and every still-visible
   * sensitive surface renders convincing fakes (dictionary names, scaled
   * ledger). Persists across relaunches — the coercer may keep the phone.
   * Cleared only by a REAL-code unlock.
   */
  duressActive: boolean;
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
  duressCodeHash: null,
  hideOnScreenshot: false,
  blockScreenRecording: false,
  panicCorner: 'off',
  flipToHide: false,
  revealTimeoutMs: 0,
  disguiseSalt: '',
  action: 'scramble',
  targets: { expenses: true, charts: true, calls: false, friends: false, chats: false, everything: false },
  sensitivity: 'normal',
  active: false,
  duressActive: false,
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
// frame and across screens (a disguised name always disguises the same way).

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

/**
 * Legacy per-character garble — kept for content with no dictionary shape
 * (invite codes, dates, arbitrary strings). Keeps length, casing, word breaks;
 * digits stay digits.
 */
export const garbleText = (input: string): string => {
  const rand = mulberry(`garble:${cache?.disguiseSalt ?? ''}:${input}`);
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

// Curated pools — the "Disguise" style swaps sensitive text for entries picked
// deterministically from these, so a glance shows a perfectly ordinary app
// instead of visibly-scrambled data. Pools are intentionally bland.

const FAKE_FIRST_NAMES = [
  'Aarav', 'Alex', 'Ana', 'Arjun', 'Ben', 'Chris', 'Dana', 'Dev', 'Diego',
  'Elena', 'Emma', 'Farah', 'Felix', 'Hana', 'Ishan', 'Ivy', 'Jamie', 'Jon',
  'Kavya', 'Kim', 'Lea', 'Leo', 'Lucas', 'Maya', 'Mia', 'Mila', 'Nate',
  'Neha', 'Nina', 'Noah', 'Omar', 'Priya', 'Rahul', 'Ravi', 'Rhea', 'Rohan',
  'Ryan', 'Sam', 'Sana', 'Sara', 'Sean', 'Tara', 'Tom', 'Uma', 'Vik', 'Zara',
];

const FAKE_GROUP_NAMES = [
  'Weekend plans', 'Lunch crew', 'Trip fund', 'Roommates', 'Office snacks',
  'Movie night', 'Game night', 'Gym buddies', 'Road trip', 'Brunch club',
  'Study group', 'Book club', 'Coffee run', 'Grocery pool', 'Carpool',
  'Flat 4B', 'House stuff', 'Birthday plan', 'Potluck', 'Badminton',
  'Hiking gang', 'Dinner club', 'Old friends', 'Cricket squad', 'Picnic plan',
  'Team outing', 'Neighbours', 'Family plan', 'Getaway fund', 'Fantasy league',
];

const FAKE_EXPENSE_TITLES = [
  'Groceries', 'Dinner', 'Lunch', 'Coffee', 'Taxi', 'Fuel', 'Snacks',
  'Breakfast', 'Parking', 'Tickets', 'Pizza night', 'Supplies', 'Utilities',
  'Internet', 'Rent share', 'Cleaning', 'Takeout', 'Ice cream', 'Pharmacy',
  'Bus fare', 'Milk & eggs', 'Fruit', 'Water bottles', 'Paper towels',
  'Detergent', 'Chai', 'Sandwiches', 'Dessert', 'Veggies', 'Cab home',
];

const FAKE_CATEGORIES = [
  'Food & drink', 'Groceries', 'Transport', 'Home', 'Entertainment',
  'Utilities', 'Travel', 'Shopping', 'Health', 'Other',
];

const FAKE_PREVIEWS = [
  'Sounds good!', 'See you at 6', 'On my way', 'Sure 👍', 'Thanks!',
  'Ok done', 'Haha nice', 'Yes please', 'Let me check', 'Cool cool',
  'Almost there', 'Good morning!', 'Same time tomorrow?', 'Perfect',
  'Got it', 'No worries', 'Sent it', 'Call me when free', 'Okk',
  'Where are you?', 'Just left', 'Nice one', 'Will do', 'Great idea',
  'Maybe Saturday?', 'Congrats!!', 'Happy birthday!', 'Safe travels',
  'Good night', 'Talk later',
];

const FAKE_NOTES = [
  'Split evenly', 'Paid in cash', 'Will settle later', 'From last week',
  'Counted everyone', 'Added tip', 'Receipt with me', 'Rounded off',
  'For the whole month', 'As discussed',
];

/** What KIND of text is being disguised — picks the dictionary. */
export type DisguiseKind =
  | 'person'   // people names → plausible fake names
  | 'group'    // group / group-chat titles → generic circle names
  | 'title'    // expense titles → mundane purchases
  | 'category' // expense categories
  | 'preview'  // chat last-message previews → stock mundane lines
  | 'note'     // free-form notes → short bland phrases
  | 'raw';     // no dictionary shape (codes, dates) → legacy garble

/** Current shuffle salt — rotating it re-randomizes every disguise/decoy. */
const salt = (): string => (cache?.disguiseSalt ?? '');

const pickFrom = (pool: string[], seed: string, avoid?: string): string => {
  const rand = mulberry(`disguise:${salt()}:${seed}`);
  let idx = Math.floor(rand() * pool.length);
  if (avoid && pool[idx].toLowerCase() === avoid.toLowerCase()) {
    idx = (idx + 1) % pool.length;
  }
  return pool[idx];
};

/**
 * Fake-but-convincing replacement text, deterministic per input. Unlike the
 * legacy garble (which reads as obviously scrambled), the output is drawn from
 * curated real-word pools so nothing on screen looks redacted.
 */
export const disguiseText = (input: string, kind: DisguiseKind): string => {
  const trimmed = input.trim();
  if (!trimmed) return input;
  switch (kind) {
    case 'person': {
      const first = pickFrom(FAKE_FIRST_NAMES, `p:${trimmed}`, trimmed.split(/\s+/)[0]);
      // Multi-word real names get a surname initial so rosters look varied.
      if (trimmed.includes(' ')) {
        const rand = mulberry(`pi:${salt()}:${trimmed}`);
        const initial = String.fromCharCode(65 + Math.floor(rand() * 26));
        return `${first} ${initial}`;
      }
      return first;
    }
    case 'group':
      return pickFrom(FAKE_GROUP_NAMES, `g:${trimmed}`, trimmed);
    case 'title':
      return pickFrom(FAKE_EXPENSE_TITLES, `t:${trimmed}`, trimmed);
    case 'category':
      return pickFrom(FAKE_CATEGORIES, `c:${trimmed}`, trimmed);
    case 'preview':
      return pickFrom(FAKE_PREVIEWS, `v:${trimmed}`, trimmed);
    case 'note':
      return pickFrom(FAKE_NOTES, `n:${trimmed}`, trimmed);
    case 'raw':
    default:
      return garbleText(input);
  }
};

/** Redacted text in the configured style. */
export const maskTextValue = (
  input: string,
  style: GuardTextStyle,
  kind: DisguiseKind = 'raw',
): string => {
  if (style === 'garble') return disguiseText(input, kind);
  const glyph = style === 'blocks' ? '█' : '•';
  const len = Math.max(4, Math.min(input.length, 14));
  return glyph.repeat(len);
};

/**
 * Stable multiplier for the decoy ledger. ONE factor per seed (pass the
 * groupId) so every amount in a group scales linearly — sums, splits, and
 * balances all still reconcile, which is what makes the fake ledger survive
 * scrutiny. The factor skips the ~1.0 band so decoys visibly differ from
 * the truth.
 */
export const decoyScaleFor = (seedKey: string): number => {
  const r = mulberry(`decoy-scale:${salt()}:${seedKey}`)();
  const factor = 0.45 + r * 1.25; // 0.45 – 1.70
  return factor > 0.88 && factor < 1.12 ? factor + 0.3 : factor;
};

/**
 * Decoy amount: the real value times the seed's stable scale factor, rounded
 * to cents. Deterministic and LINEAR — a group's expenses still add up to its
 * totals and balances (within rounding), unlike independent random decoys.
 */
export const decoyAmount = (value: number, seedKey: string = 'global'): number => {
  if (!Number.isFinite(value) || value === 0) return 0;
  return Math.round(value * decoyScaleFor(seedKey) * 100) / 100;
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

// ---------------------------------------------------------------------------
// Failed-attempt lockout — a 4-char code is brute-forceable, so escalating
// cooldowns are enforced after repeated wrong entries. State persists (in the
// settings blob) so killing the app doesn't reset the counter.

const LOCKOUT_KEY = 'guard_lockout_v1';
interface LockoutState {
  fails: number;
  until: number; // ms epoch; 0 = not locked out
  /** When the most recent failed attempt happened (0 = none since unlock). */
  lastFailAt: number;
  /**
   * Snapshot taken at the moment of the last successful unlock (macOS
   * "there have been N failed attempts since last login" style) — the live
   * counter resets on unlock, so this is what the settings sheet shows.
   */
  prevFails: number;
  prevLastFailAt: number;
}
let lockout: LockoutState = { fails: 0, until: 0, lastFailAt: 0, prevFails: 0, prevLastFailAt: 0 };
let lockoutHydrated = false;

const loadLockout = async (): Promise<LockoutState> => {
  if (lockoutHydrated) return lockout;
  try {
    const raw = await AsyncStorage.getItem(LOCKOUT_KEY);
    if (raw) lockout = JSON.parse(raw) as LockoutState;
  } catch {
    // keep defaults
  }
  lockoutHydrated = true;
  return lockout;
};

const saveLockout = async () => {
  try {
    await AsyncStorage.setItem(LOCKOUT_KEY, JSON.stringify(lockout));
  } catch {
    // ephemeral fallback
  }
};

/** Escalating cooldown after each threshold of failures (ms). */
const cooldownFor = (fails: number): number => {
  if (fails < 5) return 0;
  if (fails < 8) return 30_000; // 30s
  if (fails < 11) return 5 * 60_000; // 5m
  return 60 * 60_000; // 1h
};

/** Remaining lockout in ms (0 = free to try). Hydrates on first call. */
export const lockoutRemainingMs = async (): Promise<number> => {
  await loadLockout();
  return Math.max(0, lockout.until - Date.now());
};

export interface UnlockResult {
  ok: boolean;
  /**
   * True when the DURESS code was entered. Callers must treat this like a
   * neutral non-event: dismiss the prompt without an error, but do NOT drop
   * the shields — the guard stays armed so nothing is revealed.
   */
  duress: boolean;
  /** When ok is false, ms the caller must wait before another attempt. */
  lockedForMs: number;
}

/** Whether a code matches the (optional) duress code. */
export const isDuressCode = async (code: string): Promise<boolean> => {
  const settings = getGuardSync();
  if (!settings.duressCodeHash) return false;
  return (await hashCode(code)) === settings.duressCodeHash;
};

/**
 * Verify a code with brute-force protection. On success the counter resets;
 * on failure it increments and, past the threshold, sets an escalating
 * cooldown. A duress-code match returns { ok: false, duress: true } WITHOUT
 * counting as a failure, so the coercer sees no error. Callers should surface
 * `lockedForMs` when non-zero and stay silent on `duress`.
 */
export const attemptUnlock = async (code: string): Promise<UnlockResult> => {
  await loadLockout();

  // Duress code: look like nothing happened. Don't reveal, don't penalize —
  // and never RECORD it anywhere a later real unlock could surface. This is
  // checked BEFORE the lockout cooldown below on purpose: a coercer who has
  // already burned a few guesses (tripping the escalating lockout) must
  // still get a silent fake success from the duress code, not a "too many
  // attempts" message — that would both fail to trigger the decoy world and
  // reveal that a lockout mechanism exists at all.
  if (await isDuressCode(code)) {
    return { ok: false, duress: true, lockedForMs: 0 };
  }

  const remaining = Math.max(0, lockout.until - Date.now());
  if (remaining > 0) return { ok: false, duress: false, lockedForMs: remaining };

  const ok = await verifyCode(code);
  if (ok) {
    lockout = {
      fails: 0,
      until: 0,
      lastFailAt: 0,
      prevFails: lockout.fails,
      prevLastFailAt: lockout.lastFailAt,
    };
    await saveLockout();
    return { ok: true, duress: false, lockedForMs: 0 };
  }

  lockout.fails += 1;
  lockout.lastFailAt = Date.now();
  const cd = cooldownFor(lockout.fails);
  lockout.until = cd > 0 ? Date.now() + cd : 0;
  await saveLockout();
  return { ok: false, duress: false, lockedForMs: cd };
};

/**
 * Failed code attempts around the last successful REAL unlock — a quiet
 * tamper indicator ("did someone try my phone?"). Prefers the live counter
 * (biometric unlocks don't reset it), falling back to the snapshot captured
 * when the code last unlocked. Duress entries are never counted or recorded.
 */
export const getFailedAttempts = async (): Promise<{ count: number; lastAt: number }> => {
  await loadLockout();
  if (lockout.fails > 0) return { count: lockout.fails, lastAt: lockout.lastFailAt };
  return { count: lockout.prevFails ?? 0, lastAt: lockout.prevLastFailAt ?? 0 };
};
