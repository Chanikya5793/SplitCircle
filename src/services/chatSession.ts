/**
 * chatSession.ts — per-group persistence of the AI chat so the conversation
 * (messages + slot-filling / proposal context) survives navigating away and app
 * restarts. This is what gives the assistant real "session persistence": you can
 * leave mid-flow ("How much was it?") and come back to the same thread.
 *
 * Stored in AsyncStorage, keyed by group. Best-effort — never throws into the UI.
 */

import type { ConversationState } from '@/services/assistantService';
import { getItem, removeItem, setItem } from '@/utils/storage';

const key = (groupId: string) => `chat_session_v1_${groupId}`;
/** Cap stored history so the cache can't grow unbounded. */
const MAX_MESSAGES = 60;

export interface PersistedChat<M> {
  messages: M[];
  state: ConversationState;
  updatedAt: number;
}

export async function loadChatSession<M>(groupId: string): Promise<PersistedChat<M> | null> {
  if (!groupId) return null;
  try {
    const cached = await getItem<PersistedChat<M>>(key(groupId));
    if (cached && Array.isArray(cached.messages)) {
      return { messages: cached.messages, state: cached.state ?? {}, updatedAt: cached.updatedAt ?? 0 };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveChatSession<M>(groupId: string, messages: M[], state: ConversationState): Promise<void> {
  if (!groupId) return;
  try {
    const trimmed = messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages;
    await setItem(key(groupId), { messages: trimmed, state, updatedAt: Date.now() } satisfies PersistedChat<M>);
  } catch {
    // Non-blocking.
  }
}

export async function clearChatSession(groupId: string): Promise<void> {
  if (!groupId) return;
  try {
    await removeItem(key(groupId));
  } catch {
    // ignore
  }
}
