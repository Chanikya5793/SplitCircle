/**
 * Durable chat-list metadata for network-free cold starts.
 *
 * Message bodies already live in localMessageStorage. Previously the thread
 * list itself existed only in Firestore/memory, so killing the app before an
 * offline launch made locally stored conversations unreachable from the UI.
 */
import type { ChatThread } from '@/models';
import { getItem, removeItem, setItem } from '@/utils/storage';

const cacheKey = (userId: string): string => `chat_threads_cache_v1_${userId}`;

export async function loadCachedChatThreads(userId: string): Promise<ChatThread[] | null> {
  if (!userId) return null;
  try {
    const cached = await getItem<ChatThread[]>(cacheKey(userId));
    return Array.isArray(cached) ? cached : null;
  } catch {
    return null;
  }
}

export async function persistChatThreads(userId: string, threads: ChatThread[]): Promise<void> {
  if (!userId) return;
  try {
    await setItem(cacheKey(userId), threads);
  } catch {
    // Best-effort cache: a failed mirror must not break live chat.
  }
}

export async function clearCachedChatThreads(userId: string): Promise<void> {
  if (!userId) return;
  try {
    await removeItem(cacheKey(userId));
  } catch {
    // Best-effort sign-out cleanup.
  }
}
