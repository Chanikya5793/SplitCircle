/**
 * groupCache.ts — on-device persistence of the user's groups so the app (and the
 * on-device AI) shows last-known data offline and on a cold start, before/without
 * the Firestore listener. The Firebase JS SDK can't persist on React Native
 * (memory-only cache), so we mirror the adapted groups to AsyncStorage.
 *
 * Live Firestore data always wins when online; this is purely a fallback +
 * fast-paint cache. Best-effort (never throws into the data path).
 */

import type { Group } from '@/models';
import { getItem, removeItem, setItem } from '@/utils/storage';

const cacheKey = (userId: string) => `groups_cache_v1_${userId}`;

/** Last-known groups for this user, or null if nothing cached. */
export async function loadCachedGroups(userId: string): Promise<Group[] | null> {
  if (!userId) return null;
  try {
    const cached = await getItem<Group[]>(cacheKey(userId));
    return Array.isArray(cached) ? cached : null;
  } catch {
    return null;
  }
}

/** Persist the latest groups snapshot (fire-and-forget; never blocks). */
export async function persistGroups(userId: string, groups: Group[]): Promise<void> {
  if (!userId) return;
  try {
    await setItem(cacheKey(userId), groups);
  } catch {
    // Non-blocking: caching must never break the data flow.
  }
}

/** Clear the cache (e.g. on sign-out). */
export async function clearCachedGroups(userId: string): Promise<void> {
  if (!userId) return;
  try {
    await removeItem(cacheKey(userId));
  } catch {
    // ignore
  }
}
