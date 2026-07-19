/**
 * aiThreadStore.ts — local-only persistence for AI chat threads (doc 23).
 *
 * One AsyncStorage doc per `surface:scope` holding that scope's thread list
 * (messages inline — threads are small and capped at THREADS_PER_SCOPE_CAP).
 * Local tier only, like messages: these never touch Firestore. All operations
 * are best-effort; storage failures degrade to in-memory behavior rather than
 * breaking chat.
 */

import {
  pruneThreads,
  THREADS_PER_SCOPE_CAP,
  type AiThread,
  type AiThreadMessage,
} from '@/utils/aiThreads';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = 'ai_threads_v1';

const storageKey = (surface: string, scope: string): string => `${KEY_PREFIX}:${surface}:${scope}`;

const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function readScope(surface: string, scope: string): Promise<AiThread[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(surface, scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { threads?: AiThread[] };
    return Array.isArray(parsed.threads) ? parsed.threads : [];
  } catch {
    return [];
  }
}

async function writeScope(surface: string, scope: string, threads: AiThread[]): Promise<void> {
  try {
    const capped = pruneThreads(threads, THREADS_PER_SCOPE_CAP);
    await AsyncStorage.setItem(storageKey(surface, scope), JSON.stringify({ threads: capped }));
  } catch {
    // Best-effort — chat still works in memory for this session.
  }
}

/** Newest-first thread list for a scope. */
export async function listThreads(surface: string, scope: string): Promise<AiThread[]> {
  const threads = await readScope(surface, scope);
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The most recently touched thread, or null. */
export async function latestThread(surface: string, scope: string): Promise<AiThread | null> {
  const threads = await listThreads(surface, scope);
  return threads[0] ?? null;
}

export async function getThread(
  surface: string,
  scope: string,
  threadId: string,
): Promise<AiThread | null> {
  const threads = await readScope(surface, scope);
  return threads.find((t) => t.threadId === threadId) ?? null;
}

export async function createThread(args: {
  surface: string;
  scope: string;
  title: string;
  factsHash?: string;
  messages?: AiThreadMessage[];
  meta?: Record<string, unknown>;
}): Promise<AiThread> {
  const now = Date.now();
  const thread: AiThread = {
    threadId: newId(),
    surface: args.surface,
    scope: args.scope,
    title: args.title,
    createdAt: now,
    updatedAt: now,
    factsHash: args.factsHash,
    messages: args.messages ?? [],
    meta: args.meta,
  };
  const threads = await readScope(args.surface, args.scope);
  await writeScope(args.surface, args.scope, [thread, ...threads]);
  return thread;
}

/** Persist an updated thread object wholesale (touches updatedAt). */
export async function saveThread(thread: AiThread): Promise<AiThread> {
  const next: AiThread = { ...thread, updatedAt: Date.now() };
  const threads = await readScope(thread.surface, thread.scope);
  const idx = threads.findIndex((t) => t.threadId === thread.threadId);
  if (idx >= 0) threads[idx] = next;
  else threads.unshift(next);
  await writeScope(thread.surface, thread.scope, threads);
  return next;
}

export async function deleteThread(
  surface: string,
  scope: string,
  threadId: string,
): Promise<void> {
  const threads = await readScope(surface, scope);
  await writeScope(
    surface,
    scope,
    threads.filter((t) => t.threadId !== threadId),
  );
}

/** Stable-enough message id for thread messages. */
export const newMessageId = newId;
