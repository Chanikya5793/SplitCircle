/**
 * archiveService.ts — per-user archiving of groups and chats.
 *
 * Archive state lives on `users/{userId}` (self-writable, no rules
 * restriction) rather than on the group/chat docs, whose updates are
 * key-restricted by firestore.rules. This keeps archiving client-only (no
 * rules deploy) and syncs it across the user's devices via the existing
 * AuthContext user-doc snapshot.
 *
 * Semantics:
 * - Groups: plain id list; archived until explicitly unarchived.
 * - Chats: chatId → archivedAt (ms). A chat auto-unarchives when a message
 *   newer than archivedAt arrives (WhatsApp behavior) — derived in the UI via
 *   `isChatArchived`, with lazy write-back cleanup when the user opens it.
 */

import { arrayRemove, arrayUnion, deleteField, doc, updateDoc } from 'firebase/firestore';
import { db } from '@/firebase';
import type { ChatThread } from '@/models';

export async function archiveGroup(userId: string, groupId: string): Promise<void> {
  await updateDoc(doc(db, 'users', userId), {
    archivedGroupIds: arrayUnion(groupId),
    updatedAt: Date.now(),
  });
}

export async function unarchiveGroup(userId: string, groupId: string): Promise<void> {
  await updateDoc(doc(db, 'users', userId), {
    archivedGroupIds: arrayRemove(groupId),
    updatedAt: Date.now(),
  });
}

export async function archiveChat(userId: string, chatId: string): Promise<void> {
  await updateDoc(doc(db, 'users', userId), {
    [`archivedChats.${chatId}`]: Date.now(),
    updatedAt: Date.now(),
  });
}

export async function unarchiveChat(userId: string, chatId: string): Promise<void> {
  await updateDoc(doc(db, 'users', userId), {
    [`archivedChats.${chatId}`]: deleteField(),
    updatedAt: Date.now(),
  });
}

/**
 * Whether a thread should currently render as archived. A message newer than
 * the archive timestamp un-archives the chat (so a chat you archived doesn't
 * swallow new activity silently).
 */
export function isChatArchived(
  archivedChats: Record<string, number> | undefined,
  thread: ChatThread,
): boolean {
  const archivedAt = archivedChats?.[thread.chatId];
  if (!archivedAt) return false;
  // Normal sends persist only `createdAt` on the thread's lastMessage;
  // `timestamp` appears on a few system-message writers. Prefer createdAt
  // (already normalized to a number by the thread subscription).
  const raw = thread.lastMessage?.createdAt ?? thread.lastMessage?.timestamp;
  const lastAt = raw instanceof Date ? raw.getTime() : (raw ?? 0);
  return lastAt <= archivedAt;
}
