// Persistent render-state cache for chat messages.
//
// The data behind the chat list (the messages themselves) already lives in
// AsyncStorage — but every time the user opens a chat we still re-derive a
// pile of *expensive* per-message UI state:
//   - "is this local file actually still on disk?"  → fs.stat per bubble
//   - "what's the thumbnail for this video?"        → expo-video-thumbnails
//   - (room to grow: URL previews, gif first-frame, audio waveforms…)
//
// All of that is deterministic from the message + its on-disk file. So we
// snapshot the answers, persist them per chat, and short-circuit the work on
// subsequent renders. Entries are versioned with a `stamp` derived from the
// message's mutable fields so edits / deletes automatically invalidate.
//
// Layout:
//   In-memory: Map<chatId, Map<messageId, Entry>>
//   On disk:   one AsyncStorage key per chat,  `chatRenderCache:${chatId}`
//
// Writes are debounced per chat — a flurry of cache updates while a list
// scrolls into view consolidates into a single AsyncStorage.setItem.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = 'chatRenderCache:';
// Bumped when the cache schema changes incompatibly — older payloads are
// ignored on load. Cheap insurance against subtle shape drift.
const CACHE_VERSION = 1;
const FLUSH_DEBOUNCE_MS = 600;
// Hard ceiling so a single chat's cache never balloons unboundedly. Old
// entries fall off the tail when we exceed this; the resolver/thumbnail
// hooks will just rebuild them on demand.
const MAX_ENTRIES_PER_CHAT = 4000;

export interface RenderCacheEntry {
  /** Version stamp derived from `${updatedAt ?? createdAt}:${status}`. If the
   *  message gets edited or its status changes, this differs and the entry
   *  is treated as a miss (and overwritten on next resolve). */
  stamp: string;
  /** Local file path that the resolver verified existed at write time.
   *  Allows future renders to skip the `mediaExistsLocally` round-trip — the
   *  resolver still has the `onError` safety net for the rare case where the
   *  file goes away mid-session. */
  mediaUri?: string;
  /** Path of the generated video thumbnail (also a local file). Persisting
   *  this is the big one — without it, every app launch regenerates frames
   *  for every video bubble via expo-video-thumbnails. */
  videoThumbUri?: string;
  /** Last-written timestamp — useful when we want to age entries out. */
  ts: number;
}

interface ChatCache {
  entries: Map<string, RenderCacheEntry>;
  /** Whether we've already pulled this chat's persisted state into memory.
   *  Without this, the first few bubbles to render race the hydration and
   *  return misses for entries that *would* hydrate seconds later. */
  hydrated: boolean;
  /** Pending hydration so concurrent callers share one AsyncStorage read. */
  hydration?: Promise<void>;
  /** Pending flush timer so multiple writes within FLUSH_DEBOUNCE_MS coalesce. */
  flushTimer?: ReturnType<typeof setTimeout>;
}

const chats = new Map<string, ChatCache>();

const getOrCreateChat = (chatId: string): ChatCache => {
  let entry = chats.get(chatId);
  if (!entry) {
    entry = { entries: new Map(), hydrated: false };
    chats.set(chatId, entry);
  }
  return entry;
};

const storageKey = (chatId: string) => `${KEY_PREFIX}${chatId}`;

const scheduleFlush = (chatId: string) => {
  const chat = getOrCreateChat(chatId);
  if (chat.flushTimer) clearTimeout(chat.flushTimer);
  chat.flushTimer = setTimeout(() => {
    void persistChat(chatId);
  }, FLUSH_DEBOUNCE_MS);
};

const persistChat = async (chatId: string): Promise<void> => {
  const chat = chats.get(chatId);
  if (!chat) return;
  chat.flushTimer = undefined;

  // Cap memory + persisted size. Drop oldest by `ts` first. Iterating Maps
  // is insertion-ordered, so once we exceed the cap we delete the oldest
  // entries first — they're the least likely to be on screen.
  if (chat.entries.size > MAX_ENTRIES_PER_CHAT) {
    const overflow = chat.entries.size - MAX_ENTRIES_PER_CHAT;
    let i = 0;
    for (const key of chat.entries.keys()) {
      if (i++ >= overflow) break;
      chat.entries.delete(key);
    }
  }

  const payload = {
    v: CACHE_VERSION,
    entries: Array.from(chat.entries.entries()),
  };
  try {
    await AsyncStorage.setItem(storageKey(chatId), JSON.stringify(payload));
  } catch (err) {
    console.warn('renderCache: persist failed', err);
  }
};

/**
 * Pull a chat's cache off disk into memory. Safe to call repeatedly — only
 * one read fires per chat, and subsequent callers await the same Promise.
 * Call this from the screen that's about to render the chat so the first
 * frame already has the cache hot.
 */
export const hydrateChatRenderCache = (chatId: string): Promise<void> => {
  const chat = getOrCreateChat(chatId);
  if (chat.hydrated) return Promise.resolve();
  if (chat.hydration) return chat.hydration;

  chat.hydration = (async () => {
    try {
      const raw = await AsyncStorage.getItem(storageKey(chatId));
      if (raw) {
        const parsed = JSON.parse(raw) as { v?: number; entries?: [string, RenderCacheEntry][] };
        if (parsed?.v === CACHE_VERSION && Array.isArray(parsed.entries)) {
          for (const [id, entry] of parsed.entries) {
            if (entry && typeof entry.stamp === 'string') {
              chat.entries.set(id, entry);
            }
          }
        }
      }
      // Evict entries older than 7 days
      const TTL_MS = 7 * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - TTL_MS;
      let evicted = false;
      for (const [id, entry] of chat.entries) {
        if (entry.ts < cutoff) {
          chat.entries.delete(id);
          evicted = true;
        }
      }
      if (evicted) scheduleFlush(chatId);
    } catch (err) {
      console.warn('renderCache: hydrate failed', err);
    } finally {
      chat.hydrated = true;
      chat.hydration = undefined;
    }
  })();
  return chat.hydration;
};

/**
 * Compose a stamp from the message's mutable fields. Returning a stable
 * string means callers can pass `message` straight through and the cache
 * automatically tracks edits / status transitions without invalidate calls.
 */
export const buildStamp = (input: {
  updatedAt?: number;
  createdAt?: number;
  timestamp?: number;
  /** Edit timestamp — independent from `updatedAt` in our schema. Editing a
   *  message sets `editedAt` but doesn't touch `updatedAt`, so the stamp has
   *  to read both or edits silently keep their stale cache entry. */
  editedAt?: number;
  status?: string;
  deletedForEveryone?: boolean;
}): string => {
  const t = input.updatedAt ?? input.createdAt ?? input.timestamp ?? 0;
  const e = input.editedAt ?? 0;
  const s = input.status ?? '';
  const dfe = input.deletedForEveryone ? '1' : '0';
  return `${t}:${e}:${s}:${dfe}`;
};

/**
 * Return the cached entry only if its stamp matches the caller's expected
 * version. Mismatches are treated as misses so stale entries don't surface.
 */
export const getCachedRender = (
  chatId: string,
  messageId: string,
  expectedStamp: string,
): RenderCacheEntry | null => {
  const chat = chats.get(chatId);
  if (!chat || !chat.hydrated) return null;
  const entry = chat.entries.get(messageId);
  if (!entry) return null;
  if (entry.stamp !== expectedStamp) return null;
  return entry;
};

/**
 * Merge a partial update into the cache. Lazily creates the chat shard and
 * schedules a debounced flush — callers can fire-and-forget; no `await`.
 */
export const updateCachedRender = (
  chatId: string,
  messageId: string,
  stamp: string,
  patch: Partial<Omit<RenderCacheEntry, 'stamp' | 'ts'>>,
): void => {
  const chat = getOrCreateChat(chatId);
  const existing = chat.entries.get(messageId);
  const next: RenderCacheEntry = {
    ...existing,
    ...patch,
    stamp,
    ts: Date.now(),
  };
  // Re-insert at the tail so LRU-style trimming drops the *oldest* keys.
  chat.entries.delete(messageId);
  chat.entries.set(messageId, next);
  scheduleFlush(chatId);
};

/** Drop a single message's entry — for delete-for-me / delete-for-everyone. */
export const invalidateMessageRender = (chatId: string, messageId: string): void => {
  const chat = chats.get(chatId);
  if (!chat) return;
  if (chat.entries.delete(messageId)) {
    scheduleFlush(chatId);
  }
};

/** Drop every entry for a chat — for "clear chat history". */
export const invalidateChatRender = async (chatId: string): Promise<void> => {
  const chat = chats.get(chatId);
  if (chat) {
    if (chat.flushTimer) clearTimeout(chat.flushTimer);
    chat.entries.clear();
    chat.flushTimer = undefined;
  }
  try {
    await AsyncStorage.removeItem(storageKey(chatId));
  } catch (err) {
    console.warn('renderCache: invalidate failed', err);
  }
};

/** Force-flush every pending write. Called on app background so we don't
 *  lose recent updates to a kill. */
export const flushAllPendingRenderCaches = async (): Promise<void> => {
  const tasks: Promise<void>[] = [];
  for (const chatId of chats.keys()) {
    const chat = chats.get(chatId);
    if (chat?.flushTimer) {
      clearTimeout(chat.flushTimer);
      chat.flushTimer = undefined;
      tasks.push(persistChat(chatId));
    }
  }
  await Promise.all(tasks);
};
