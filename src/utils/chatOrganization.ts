/**
 * chatOrganization.ts — PURE list-organization logic shared by the chat &
 * group lists. Kept free of `@/firebase` / native imports so it is unit
 * testable in a plain node environment.
 *
 * Buckets a set of items (chats or groups) into four disjoint groups applying
 * a strict precedence:
 *   locked  → highest (never rendered inline, never counted as active/pinned)
 *   archived
 *   pinned  → floats atop the active list, ordered by pin time (newest first)
 *   active
 *
 * "Locked wins" — a chat that is both locked AND archived (or pinned) is only
 * ever surfaced behind the biometric folder.
 */

export type ChatMap = Record<string, number> | undefined;

/** True when `id` has an entry in the map (value is a truthy ms epoch). */
export const isInChatMap = (map: ChatMap, id: string): boolean =>
  !!map && map[id] != null;

/** Immutably add `id → at` to a map (used by lock/pin toggles / tests). */
export const addToChatMap = (
  map: Record<string, number> | undefined,
  id: string,
  at: number = Date.now(),
): Record<string, number> => ({ ...(map ?? {}), [id]: at });

/** Immutably remove `id` from a map. */
export const removeFromChatMap = (
  map: Record<string, number> | undefined,
  id: string,
): Record<string, number> => {
  if (!map) return {};
  const next = { ...map };
  delete next[id];
  return next;
};

/**
 * Stable sort of `items` by their timestamp in `map`, most-recent first.
 * Items missing from the map sink to the bottom (treated as 0).
 */
export const sortByChatMapTimeDesc = <T>(
  items: T[],
  map: ChatMap,
  getId: (item: T) => string,
): T[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ta = map?.[getId(a.item)] ?? 0;
      const tb = map?.[getId(b.item)] ?? 0;
      if (tb !== ta) return tb - ta;
      return a.index - b.index; // preserve incoming order on ties
    })
    .map((entry) => entry.item);

export interface ChatBuckets<T> {
  pinned: T[];
  active: T[];
  archived: T[];
  locked: T[];
}

export interface PartitionOptions<T> {
  getId: (item: T) => string;
  /** Whether the item currently reads as archived (already auto-unarchive aware). */
  isArchived: (item: T) => boolean;
  pinnedChats?: ChatMap;
  lockedChats?: ChatMap;
}

/**
 * Split `items` into locked / archived / pinned / active buckets applying the
 * precedence above. The incoming order of `items` is preserved within each
 * bucket except `pinned`, which is re-ordered by pin time (newest first).
 */
export function partitionChats<T>(
  items: T[],
  opts: PartitionOptions<T>,
): ChatBuckets<T> {
  const { getId, isArchived, pinnedChats, lockedChats } = opts;
  const pinned: T[] = [];
  const active: T[] = [];
  const archived: T[] = [];
  const locked: T[] = [];

  for (const item of items) {
    const id = getId(item);
    if (isInChatMap(lockedChats, id)) {
      locked.push(item); // locked wins — never listed anywhere else
      continue;
    }
    if (isArchived(item)) {
      archived.push(item);
      continue;
    }
    if (isInChatMap(pinnedChats, id)) {
      pinned.push(item);
      continue;
    }
    active.push(item);
  }

  return {
    pinned: sortByChatMapTimeDesc(pinned, pinnedChats, getId),
    active,
    archived,
    locked,
  };
}
