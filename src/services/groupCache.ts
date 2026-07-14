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
import { pruneGroupMeta, upsertGroupMeta } from '@/services/aiIndexStore';
import { publishWidgetSnapshot } from '@/services/widgetService';

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
  // Mirror group identity (name/member count) into the SQLite index so native
  // Swift (App Intents / Spotlight — see aiIndexStore.upsertGroupMeta) can
  // resolve "which group" headlessly, without going through AsyncStorage.
  try {
    for (const g of groups) {
      upsertGroupMeta(g.groupId, userId, g.name, g.members?.length ?? 0);
    }
    pruneGroupMeta(userId, new Set(groups.map((g) => g.groupId)));
  } catch {
    // Best-effort — never break the cache-write path over the Siri index mirror.
  }
  // Refresh the home/lock-screen/Control-Center widgets from the same data.
  publishWidgetSnapshot(userId, groups);
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
