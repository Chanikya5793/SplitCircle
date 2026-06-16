/**
 * profileCache.ts — on-device persistence of the signed-in user's profile so the
 * app renders instantly and works offline on a cold start, before/without the
 * Firestore `users/{uid}` snapshot. The Firebase JS SDK can't persist Firestore
 * data on React Native (memory-only cache), so we mirror the profile to
 * AsyncStorage — mirroring `groupCache`.
 *
 * The persisted auth session (getReactNativePersistence) already restores the
 * core identity (uid/email/displayName/photoURL) offline; this cache preserves
 * the richer fields (preferences, groups, createdAt) across offline launches.
 * Live Firestore data always wins when online. Best-effort (never throws).
 */

import type { UserProfile } from '@/models';
import { getItem, removeItem, setItem } from '@/utils/storage';

const KEY = 'auth_profile_v1';

/** Last-known signed-in profile, or null if nothing cached. */
export async function loadCachedProfile(): Promise<UserProfile | null> {
  try {
    const cached = await getItem<UserProfile>(KEY);
    return cached && typeof cached === 'object' && 'userId' in cached ? cached : null;
  } catch {
    return null;
  }
}

/** Persist the latest profile (fire-and-forget; never blocks). */
export async function persistProfile(profile: UserProfile): Promise<void> {
  try {
    await setItem(KEY, profile);
  } catch {
    // Non-blocking: caching must never break auth.
  }
}

/** Clear the cache (on sign-out). */
export async function clearCachedProfile(): Promise<void> {
  try {
    await removeItem(KEY);
  } catch {
    // ignore
  }
}
