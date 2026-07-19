/**
 * chatSession.ts — per-group persistence of the AI assistant chat.
 *
 * MIGRATED (doc 23): the storage substrate is now the app-wide AI thread store
 * (surface 'assistant', scope = groupId, single active thread resumed via
 * latestThread). The public API is unchanged so AiChatScreen keeps working;
 * the assistant's rich messages (confirm cards, choices, citations) round-trip
 * through AiThreadMessage.payload verbatim. Slot-filling/proposal state rides
 * in thread.meta. Thread history UI for the assistant comes later — the store
 * already supports it.
 *
 * Local tier only (AsyncStorage) — never Firestore. Best-effort, never throws.
 */

import * as threadStore from '@/services/aiThreadStore';
import type { ConversationState } from '@/services/assistantService';
import type { AiThreadMessage } from '@/utils/aiThreads';
import { getItem, removeItem } from '@/utils/storage';

const SURFACE = 'assistant';
/** Pre-migration storage key — read once, imported, then removed. */
const legacyKey = (groupId: string) => `chat_session_v1_${groupId}`;
/** Cap stored history so the thread can't grow unbounded. */
const MAX_MESSAGES = 60;

export interface PersistedChat<M> {
  messages: M[];
  state: ConversationState;
  updatedAt: number;
}

interface RawChatMsg {
  id?: string;
  role?: 'user' | 'assistant';
  text?: string;
}

const toThreadMessage = (m: unknown): AiThreadMessage => {
  const raw = (m ?? {}) as RawChatMsg;
  return {
    id: raw.id ?? threadStore.newMessageId(),
    role: raw.role === 'user' ? 'user' : 'assistant',
    text: raw.text ?? '',
    createdAt: Date.now(),
    payload: m,
  };
};

const DEFAULT_TITLE = 'Assistant';

/** First user message excerpt — cheap history title, no model call per save. */
const titleFrom = (messages: readonly AiThreadMessage[], fallback: string): string => {
  const firstUser = messages.find((m) => m.role === 'user' && m.text.trim());
  return firstUser ? firstUser.text.trim().slice(0, 40) : fallback;
};

export async function loadChatSession<M>(groupId: string): Promise<PersistedChat<M> | null> {
  if (!groupId) return null;
  try {
    const thread = await threadStore.latestThread(SURFACE, groupId);
    if (thread && thread.messages.length > 0) {
      return {
        messages: thread.messages.map((m) => m.payload as M),
        state: (thread.meta?.state as ConversationState) ?? {},
        updatedAt: thread.updatedAt,
      };
    }
    // A fresh empty thread (explicit "New thread") means start clean — never
    // resurrect the legacy conversation into it.
    if (thread) return null;
    // One-time import of the pre-thread-store format.
    const legacy = await getItem<PersistedChat<M>>(legacyKey(groupId));
    if (legacy && Array.isArray(legacy.messages) && legacy.messages.length > 0) {
      await saveChatSession(groupId, legacy.messages, legacy.state ?? {});
      void removeItem(legacyKey(groupId)).catch(() => undefined);
      return { messages: legacy.messages, state: legacy.state ?? {}, updatedAt: legacy.updatedAt ?? 0 };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveChatSession<M>(
  groupId: string,
  messages: M[],
  state: ConversationState,
): Promise<void> {
  if (!groupId) return;
  try {
    const trimmed = messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages;
    const threadMessages = trimmed.map(toThreadMessage);
    const existing = await threadStore.latestThread(SURFACE, groupId);
    if (existing) {
      await threadStore.saveThread({
        ...existing,
        title:
          existing.title === DEFAULT_TITLE ? titleFrom(threadMessages, DEFAULT_TITLE) : existing.title,
        messages: threadMessages,
        meta: { ...existing.meta, state },
      });
    } else {
      await threadStore.createThread({
        surface: SURFACE,
        scope: groupId,
        title: titleFrom(threadMessages, DEFAULT_TITLE),
        messages: threadMessages,
        meta: { state },
      });
    }
  } catch {
    // Non-blocking.
  }
}

// ── Thread history (doc 23 — the assistant's multi-thread surface) ───────────

export interface ChatThreadSummary {
  threadId: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export async function listChatThreads(groupId: string): Promise<ChatThreadSummary[]> {
  if (!groupId) return [];
  try {
    const threads = await threadStore.listThreads(SURFACE, groupId);
    return threads.map((t) => ({
      threadId: t.threadId,
      title: t.title,
      updatedAt: t.updatedAt,
      messageCount: t.messages.length,
    }));
  } catch {
    return [];
  }
}

/**
 * Start a fresh thread. It becomes "latest", so subsequent saves land in it;
 * the previous conversation stays in history untouched.
 */
export async function newChatThread(groupId: string): Promise<void> {
  if (!groupId) return;
  try {
    await threadStore.createThread({
      surface: SURFACE,
      scope: groupId,
      title: DEFAULT_TITLE,
      messages: [],
      meta: { state: {} },
    });
  } catch {
    // Non-blocking.
  }
}

/**
 * Make an older thread the active one (bumps updatedAt so saves target it)
 * and return its conversation for the UI to load.
 */
export async function activateChatThread<M>(
  groupId: string,
  threadId: string,
): Promise<PersistedChat<M> | null> {
  if (!groupId) return null;
  try {
    const thread = await threadStore.getThread(SURFACE, groupId, threadId);
    if (!thread) return null;
    const saved = await threadStore.saveThread(thread);
    return {
      messages: saved.messages.map((m) => m.payload as M),
      state: (saved.meta?.state as ConversationState) ?? {},
      updatedAt: saved.updatedAt,
    };
  } catch {
    return null;
  }
}

export async function deleteChatThread(groupId: string, threadId: string): Promise<void> {
  if (!groupId) return;
  try {
    await threadStore.deleteThread(SURFACE, groupId, threadId);
  } catch {
    // ignore
  }
}

export async function clearChatSession(groupId: string): Promise<void> {
  if (!groupId) return;
  try {
    const existing = await threadStore.latestThread(SURFACE, groupId);
    if (existing) await threadStore.deleteThread(SURFACE, groupId, existing.threadId);
  } catch {
    // ignore
  }
}
