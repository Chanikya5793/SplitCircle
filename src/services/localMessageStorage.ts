import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatMessage } from '@/models';
import { invalidateMessageRender } from '@/services/messageRenderCache';

const MESSAGES_KEY_PREFIX = 'chat_messages_';
const messageListeners = new Map<string, Set<() => void>>();
const chatWriteChains = new Map<string, Promise<void>>();

const getChatStorageKey = (chatId: string): string => `${MESSAGES_KEY_PREFIX}${chatId}`;

const sortMessagesByTimestampAsc = (messages: ChatMessage[]): void => {
  messages.sort((a, b) => {
    const timeA = typeof a.timestamp === 'number' ? a.timestamp : new Date(a.timestamp).getTime();
    const timeB = typeof b.timestamp === 'number' ? b.timestamp : new Date(b.timestamp).getTime();
    return timeA - timeB;
  });
};

const mergeUniqueIds = (existing: string[] | undefined, incoming: string[] | undefined): string[] => {
  const merged = new Set<string>(existing ?? []);
  for (const value of incoming ?? []) {
    merged.add(value);
  }
  return Array.from(merged);
};

const deriveStatusFromReceipts = (
  currentStatus: ChatMessage['status'],
  deliveredTo: string[],
  readBy: string[],
  totalRecipients?: number
): ChatMessage['status'] => {
  if (currentStatus === 'failed') {
    return 'failed';
  }

  const hasAnyDelivered = deliveredTo.length > 0;
  const hasAnyRead = readBy.length > 0;
  const hasAllReads = typeof totalRecipients === 'number' && totalRecipients > 0
    ? readBy.length >= totalRecipients
    : hasAnyRead;

  if (hasAllReads) {
    return 'read';
  }

  if (hasAnyDelivered || hasAnyRead) {
    return 'delivered';
  }

  return currentStatus;
};

const withSerializedChatWrite = async (
  chatId: string,
  operation: () => Promise<void>
): Promise<void> => {
  const previousChain = chatWriteChains.get(chatId) ?? Promise.resolve();
  const currentChain = previousChain
    .catch(() => undefined)
    .then(operation);

  chatWriteChains.set(chatId, currentChain);

  try {
    await currentChain;
  } finally {
    if (chatWriteChains.get(chatId) === currentChain) {
      chatWriteChains.delete(chatId);
    }
  }
};

const readMessages = async (chatId: string): Promise<ChatMessage[]> => {
  const data = await AsyncStorage.getItem(getChatStorageKey(chatId));
  if (!data) {
    return [];
  }

  return JSON.parse(data) as ChatMessage[];
};

export const waitForChatWrites = async (chatId: string): Promise<void> => {
  const activeChain = chatWriteChains.get(chatId);
  if (!activeChain) {
    return;
  }

  await activeChain.catch(() => undefined);
};

const notifyMessageListeners = (chatId: string) => {
  const listeners = messageListeners.get(chatId);
  if (!listeners || listeners.size === 0) {
    return;
  }

  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('❌ Error in local message listener:', error);
    }
  });
};

export const subscribeToLocalMessages = (
  chatId: string,
  listener: () => void
): (() => void) => {
  const existing = messageListeners.get(chatId) ?? new Set<() => void>();
  existing.add(listener);
  messageListeners.set(chatId, existing);

  return () => {
    const current = messageListeners.get(chatId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      messageListeners.delete(chatId);
    }
  };
};

// Initialize the storage (No-op for AsyncStorage but kept for API compatibility)
export const initMessageDB = async (): Promise<void> => {
  console.log('✅ Message storage initialized (AsyncStorage)');
};

// Save a message to local storage
export const saveMessageLocally = async (message: ChatMessage): Promise<void> => {
  try {
    await withSerializedChatWrite(message.chatId, async () => {
      const key = getChatStorageKey(message.chatId);
      const messages = await readMessages(message.chatId);

      const existingIndex = messages.findIndex((m) => m.id === message.id || m.messageId === message.messageId);

      if (existingIndex >= 0) {
        const existingMessage = messages[existingIndex];
        messages[existingIndex] = {
          ...existingMessage,
          ...message,
          // A cloud convergence replay may omit device-local fields, and an
          // older relay can explicitly materialize optional remote fields as
          // `undefined`. Neither is authority to erase a working nearby file
          // or URL that this phone already has.
          localMediaPath:
            message.localMediaPath ?? existingMessage.localMediaPath,
          mediaDownloaded:
            message.mediaDownloaded ?? existingMessage.mediaDownloaded,
          mediaUrl:
            message.mediaUrl ?? existingMessage.mediaUrl,
          thumbnailUrl:
            message.thumbnailUrl ?? existingMessage.thumbnailUrl,
          replyTo: message.replyTo || existingMessage.replyTo,
          deliveredTo: mergeUniqueIds(existingMessage.deliveredTo, message.deliveredTo),
          readBy: mergeUniqueIds(existingMessage.readBy, message.readBy),
        };
        console.log('✅ Message updated locally:', message.id, message.replyTo ? '(with replyTo)' : '');
      } else {
        messages.push(message);
        console.log('✅ New message saved locally:', message.id, message.replyTo ? '(with replyTo)' : '');
      }

      sortMessagesByTimestampAsc(messages);
      await AsyncStorage.setItem(key, JSON.stringify(messages));
      notifyMessageListeners(message.chatId);
    });
  } catch (error) {
    console.error('❌ Error saving message locally:', error);
    throw error;
  }
};

/**
 * Remove a message from local storage outright, leaving no tombstone.
 *
 * Distinct from `markMessageDeletedForUser`, which is the user-facing "delete
 * for me" and deliberately leaves a "you deleted this message" placeholder.
 * This is for a message that was never real: an optimistic media bubble whose
 * send the user cancelled before it reached anyone. A tombstone there would be
 * a record of an event that never happened, and the failed-items sheet would
 * invite a retry of something the user just chose to stop.
 *
 * Safe to call for an id that isn't present — a cancel can race a send that
 * already cleaned up after itself.
 */
export const deleteMessageLocally = async (
  chatId: string,
  messageId: string,
): Promise<void> => {
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      const remaining = messages.filter(
        (m) => m.id !== messageId && m.messageId !== messageId,
      );
      if (remaining.length === messages.length) return;
      await AsyncStorage.setItem(key, JSON.stringify(remaining));
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error deleting message locally:', error);
  }
};

// Get all messages for a chat
export const getChatMessages = async (chatId: string): Promise<ChatMessage[]> => {
  try {
    return await readMessages(chatId);
  } catch (error) {
    console.error('❌ Error getting chat messages:', error);
    return [];
  }
};

export interface PaginatedResult {
  messages: ChatMessage[];
  hasMore: boolean;
}

// Get paginated messages for a chat (newest first)
export const getChatMessagesPaginated = async (
  chatId: string,
  options: { limit: number; before?: number },
): Promise<PaginatedResult> => {
  try {
    const all = await readMessages(chatId);
    // Sort newest first
    const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
    let filtered = sorted;
    if (options.before !== undefined) {
      filtered = sorted.filter((m) => m.createdAt < options.before!);
    }
    const messages = filtered.slice(0, options.limit);
    const hasMore = filtered.length > options.limit;
    return { messages, hasMore };
  } catch (error) {
    console.error('❌ Error getting paginated messages:', error);
    return { messages: [], hasMore: false };
  }
};

export interface LocalMessageStats {
  chatId: string;
  count: number;
  /** createdAt (numeric) of the newest message in this chat, or null if empty. */
  latestTimestamp: number | null;
}

const listLocalChatIds = async (): Promise<string[]> => {
  const allKeys = await AsyncStorage.getAllKeys();
  return allKeys
    .filter((key) => key.startsWith(MESSAGES_KEY_PREFIX))
    .map((key) => key.slice(MESSAGES_KEY_PREFIX.length));
};

/**
 * Per-chat message count + latest timestamp, read straight from AsyncStorage.
 * Feeds the CloudKit `BackupManifest` record (doc 31 §3.2) and the
 * device-retirement reconciliation check (doc 31 §3.7) — this is the LOCAL
 * side of that comparison only; the manifest itself is computed at
 * backup-write time (Phase 4), never re-derived from this function later
 * (E2E encryption makes after-the-fact plaintext diffing on the CloudKit
 * side mechanically impossible by design — see doc 31 §3.10 gotcha #2).
 *
 * Pass a chatId for a single chat's stats; omit it for every chat this
 * device currently has local messages for.
 */
export const getLocalMessageStats = async (chatId?: string): Promise<LocalMessageStats[]> => {
  const chatIds = chatId ? [chatId] : await listLocalChatIds();

  return Promise.all(
    chatIds.map(async (id): Promise<LocalMessageStats> => {
      try {
        const messages = await readMessages(id);
        const latestTimestamp = messages.reduce<number | null>((latest, message) => {
          return latest === null || message.createdAt > latest ? message.createdAt : latest;
        }, null);
        return { chatId: id, count: messages.length, latestTimestamp };
      } catch (error) {
        console.error('❌ Error computing local message stats:', error);
        return { chatId: id, count: 0, latestTimestamp: null };
      }
    }),
  );
};

// Update a message's status in local storage
export const updateMessageStatus = async (
  chatId: string,
  messageId: string,
  status: ChatMessage['status'],
  deliveredTo?: string[],
  readBy?: string[],
  totalRecipients?: number
): Promise<void> => {
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      const messageIndex = messages.findIndex((m) => m.id === messageId || m.messageId === messageId);

      if (messageIndex < 0) {
        return;
      }

      const existingMessage = messages[messageIndex];
      const mergedDelivered = mergeUniqueIds(existingMessage.deliveredTo, deliveredTo);
      const mergedRead = mergeUniqueIds(existingMessage.readBy, readBy);
      const nextStatus = deriveStatusFromReceipts(status, mergedDelivered, mergedRead, totalRecipients);

      messages[messageIndex] = {
        ...existingMessage,
        status: nextStatus,
        deliveredTo: mergedDelivered,
        readBy: mergedRead,
      };

      await AsyncStorage.setItem(key, JSON.stringify(messages));
      console.log(`✅ Message ${messageId} status updated to ${nextStatus}`);
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error updating message status:', error);
  }
};

// Mark multiple messages as delivered by a specific user
export const markMessagesDelivered = async (
  chatId: string,
  messageIds: string[],
  deliveredByUserId: string
): Promise<void> => {
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      let updated = false;

      for (const messageId of messageIds) {
        const messageIndex = messages.findIndex((m) => m.id === messageId || m.messageId === messageId);
        if (messageIndex < 0) {
          continue;
        }

        const message = messages[messageIndex];
        const deliveredTo = mergeUniqueIds(message.deliveredTo, [deliveredByUserId]);

        if (deliveredTo.length === (message.deliveredTo?.length ?? 0)) {
          continue;
        }

        messages[messageIndex] = {
          ...message,
          deliveredTo,
          status: message.status === 'sent' || message.status === 'sending'
            ? 'delivered'
            : deriveStatusFromReceipts(message.status, deliveredTo, message.readBy ?? []),
        };
        updated = true;
      }

      if (!updated) {
        return;
      }

      await AsyncStorage.setItem(key, JSON.stringify(messages));
      console.log(`✅ Marked ${messageIds.length} messages as delivered by ${deliveredByUserId}`);
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error marking messages delivered:', error);
  }
};

// Mark multiple messages as read by a specific user
export const markMessagesRead = async (
  chatId: string,
  messageIds: string[],
  readByUserId: string,
  totalRecipients?: number
): Promise<void> => {
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      let updated = false;

      for (const messageId of messageIds) {
        const messageIndex = messages.findIndex((m) => m.id === messageId || m.messageId === messageId);
        if (messageIndex < 0) {
          continue;
        }

        const message = messages[messageIndex];
        const deliveredTo = mergeUniqueIds(message.deliveredTo, [readByUserId]);
        const readBy = mergeUniqueIds(message.readBy, [readByUserId]);

        const deliveredChanged = deliveredTo.length !== (message.deliveredTo?.length ?? 0);
        const readChanged = readBy.length !== (message.readBy?.length ?? 0);

        if (!deliveredChanged && !readChanged) {
          continue;
        }

        messages[messageIndex] = {
          ...message,
          deliveredTo,
          readBy,
          status: deriveStatusFromReceipts(message.status, deliveredTo, readBy, totalRecipients),
        };
        updated = true;
      }

      if (!updated) {
        return;
      }

      await AsyncStorage.setItem(key, JSON.stringify(messages));
      console.log(`✅ Marked ${messageIds.length} messages as read by ${readByUserId}`);
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error marking messages read:', error);
  }
};

// Toggle a single emoji reaction for a user on a message. Slack/Discord-style:
// each user can stack multiple distinct emoji on the same message. Toggling
// only affects the target emoji entry — other reactions by this user are
// untouched. Returns the next reactions map so the caller can broadcast it
// via messageState.
export const toggleMessageReaction = async (
  chatId: string,
  messageId: string,
  userId: string,
  emoji: string
): Promise<import('@/models').ReactionMap | undefined> => {
  let result: import('@/models').ReactionMap | undefined;
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      const idx = messages.findIndex((m) => m.id === messageId || m.messageId === messageId);
      if (idx < 0) return;

      const message = messages[idx];
      const reactions: Record<string, string[]> = { ...(message.reactions ?? {}) };

      const usersForEmoji = new Set(reactions[emoji] ?? []);
      if (usersForEmoji.has(userId)) {
        usersForEmoji.delete(userId);
      } else {
        usersForEmoji.add(userId);
      }
      if (usersForEmoji.size === 0) {
        delete reactions[emoji];
      } else {
        reactions[emoji] = Array.from(usersForEmoji);
      }

      messages[idx] = { ...message, reactions, reactionsLocalVersion: Date.now() };
      result = reactions;
      await AsyncStorage.setItem(key, JSON.stringify(messages));
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error toggling reaction:', error);
  }
  return result;
};

// Strip all of a user's reactions from a message (used by the "Remove all"
// affordance in the reaction details sheet). Returns the next reactions map.
export const removeAllReactionsForUser = async (
  chatId: string,
  messageId: string,
  userId: string
): Promise<import('@/models').ReactionMap | undefined> => {
  let result: import('@/models').ReactionMap | undefined;
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      const idx = messages.findIndex((m) => m.id === messageId || m.messageId === messageId);
      if (idx < 0) return;

      const message = messages[idx];
      const reactions: Record<string, string[]> = { ...(message.reactions ?? {}) };

      let mutated = false;
      for (const emoji of Object.keys(reactions)) {
        const users = reactions[emoji].filter((u) => u !== userId);
        if (users.length !== reactions[emoji].length) mutated = true;
        if (users.length === 0) delete reactions[emoji];
        else reactions[emoji] = users;
      }
      if (!mutated) {
        result = message.reactions;
        return;
      }

      messages[idx] = { ...message, reactions, reactionsLocalVersion: Date.now() };
      result = reactions;
      await AsyncStorage.setItem(key, JSON.stringify(messages));
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error removing all reactions:', error);
  }
  return result;
};

export const toggleMessageStar = async (
  chatId: string,
  messageId: string,
  userId: string
): Promise<void> => {
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      const idx = messages.findIndex((m) => m.id === messageId || m.messageId === messageId);
      if (idx < 0) return;

      const message = messages[idx];
      const starredBy = new Set(message.starredBy ?? []);
      if (starredBy.has(userId)) {
        starredBy.delete(userId);
      } else {
        starredBy.add(userId);
      }

      messages[idx] = { ...message, starredBy: Array.from(starredBy) };
      await AsyncStorage.setItem(key, JSON.stringify(messages));
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error toggling star:', error);
  }
};

export const markMessageDeletedForUser = async (
  chatId: string,
  messageId: string,
  userId: string
): Promise<void> => {
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      const idx = messages.findIndex((m) => m.id === messageId || m.messageId === messageId);
      if (idx < 0) return;

      const message = messages[idx];
      const deletedFor = mergeUniqueIds(message.deletedFor, [userId]);
      messages[idx] = { ...message, deletedFor };

      await AsyncStorage.setItem(key, JSON.stringify(messages));
      // Render cache: drop the entry — the message disappears from the
      // current user's view, freeing the cache slot. (Other users on this
      // device, if there were any, would just regenerate on first view.)
      invalidateMessageRender(chatId, messageId);
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error marking message deleted for user:', error);
  }
};

// Inverse of markMessageDeletedForUser — used by the "Undo" snackbar after a
// delete-for-me. Drops `userId` from `deletedFor` so the bubble reappears.
export const unmarkMessageDeletedForUser = async (
  chatId: string,
  messageId: string,
  userId: string
): Promise<void> => {
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      const idx = messages.findIndex((m) => m.id === messageId || m.messageId === messageId);
      if (idx < 0) return;

      const message = messages[idx];
      if (!message.deletedFor?.includes(userId)) return;
      const deletedFor = message.deletedFor.filter((id) => id !== userId);
      messages[idx] = { ...message, deletedFor };

      await AsyncStorage.setItem(key, JSON.stringify(messages));
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error unmarking message deleted for user:', error);
  }
};

// Merge a remote messageState payload into the locally-cached message.
// Returns true if the local copy was changed (used to skip needless writes).
export const applyRemoteMessageState = async (
  chatId: string,
  messageId: string,
  state: {
    reactions?: import('@/models').ReactionMap;
    deletedForEveryone?: boolean;
    editedContent?: string;
    editedAt?: number;
    /** Firestore Timestamp (or null while a local write is still unacked). */
    updatedAt?: unknown;
  }
): Promise<boolean> => {
  let changed = false;
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      const idx = messages.findIndex((m) => m.id === messageId || m.messageId === messageId);
      if (idx < 0) return;

      const existing = messages[idx];
      const next = { ...existing };

      if (state.reactions) {
        // Replace whole map — sender is the source of truth for their own emoji.
        const beforeHash = JSON.stringify(existing.reactions ?? {});
        const afterHash = JSON.stringify(state.reactions);
        // Ordering guard — without this, a stale server-side messageState doc
        // (e.g. a publish that failed/queued after connectivity hiccups) gets
        // replayed on every re-subscribe (chat reopen, app foreground) and
        // silently clobbers a newer local toggle back to the old reaction set.
        // Only reject when we can prove the remote write is actually older —
        // an unresolved local cache echo (updatedAt still null) is the
        // writer's own latest value, so it always wins.
        const remoteMs =
          state.updatedAt && typeof (state.updatedAt as { toMillis?: () => number }).toMillis === 'function'
            ? (state.updatedAt as { toMillis: () => number }).toMillis()
            : undefined;
        const staleRemote =
          remoteMs !== undefined &&
          existing.reactionsLocalVersion !== undefined &&
          remoteMs < existing.reactionsLocalVersion;
        if (beforeHash !== afterHash && !staleRemote) {
          next.reactions = state.reactions;
          changed = true;
        }
      }

      if (state.deletedForEveryone && !existing.deletedForEveryone) {
        next.deletedForEveryone = true;
        next.content = '';
        changed = true;
      }

      if (
        typeof state.editedContent === 'string' &&
        state.editedContent !== existing.content &&
        (!existing.editedAt || (state.editedAt ?? 0) >= existing.editedAt)
      ) {
        next.content = state.editedContent;
        next.editedAt = state.editedAt ?? Date.now();
        changed = true;
      }

      if (!changed) return;

      messages[idx] = next;
      await AsyncStorage.setItem(key, JSON.stringify(messages));
      // Belt-and-braces invalidation. The cache stamp already includes
      // `editedAt` and `deletedForEveryone`, so a stamp-driven miss is
      // automatic — but explicitly dropping the entry on delete-for-everyone
      // also reclaims the persisted bytes immediately.
      if (state.deletedForEveryone) {
        invalidateMessageRender(chatId, messageId);
      }
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error applying remote message state:', error);
  }
  return changed;
};

export const updateMessageContent = async (
  chatId: string,
  messageId: string,
  content: string,
  editedAt: number = Date.now()
): Promise<void> => {
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      const idx = messages.findIndex((m) => m.id === messageId || m.messageId === messageId);
      if (idx < 0) return;

      messages[idx] = { ...messages[idx], content, editedAt };
      await AsyncStorage.setItem(key, JSON.stringify(messages));
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error updating message content:', error);
  }
};

export const updateMessageUrlPreview = async (
  chatId: string,
  messageId: string,
  urlPreview: import('@/models').UrlPreview
): Promise<void> => {
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      const idx = messages.findIndex((m) => m.id === messageId || m.messageId === messageId);
      if (idx < 0) return;

      // Only update if not already set with the same URL — avoids re-rendering
      // when the same payload is rehydrated from cache.
      const existing = messages[idx].urlPreview;
      if (existing && existing.url === urlPreview.url && existing.failed === urlPreview.failed) {
        return;
      }

      messages[idx] = { ...messages[idx], urlPreview };
      await AsyncStorage.setItem(key, JSON.stringify(messages));
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error updating url preview:', error);
  }
};

// ── Doc 30 §7: backward-compat rewrite of legacy system-message text ──────
//
// Messages written before `systemEventKind`/`relatedUserId` existed have a
// frozen `content` string that may have baked in an empty display name
// (e.g. " left the group", leading space, no name — see doc 30 root cause
// #3). Going forward, MessageBubble prefers a live resolveDisplayName()
// lookup over `content` whenever systemEventKind is present; this is the
// backward half — a one-time, local-only rewrite of the stored string for
// old messages that don't have it.
//
// Scoped deliberately to the SELF-REFERENTIAL templates only (senderId IS
// the user whose name is embedded in the text): member_joined, member_left,
// account_deleted, money_in_chat_updated, group_renamed. member_removed and
// role_changed_admin/role_changed_member are excluded on purpose — for
// those, senderId is the ACTING ADMIN, not the user named in the text, so
// there is no reliable way to recover the right name from senderId alone;
// guessing would be worse than leaving the old line as historical record.
type LegacySystemMessageTemplate = {
  regex: RegExp;
  rebuild: (currentName: string, match: RegExpMatchArray) => string;
};

const LEGACY_SELF_REFERENTIAL_SYSTEM_MESSAGE_TEMPLATES: LegacySystemMessageTemplate[] = [
  // "X joined the group"
  { regex: /^(.+) joined the group$/, rebuild: (name) => `${name} joined the group` },
  // "X left the group"
  { regex: /^(.+) left the group$/, rebuild: (name) => `${name} left the group` },
  // "X's account was deleted"
  { regex: /^(.+)'s account was deleted$/, rebuild: (name) => `${name}'s account was deleted` },
  // "X updated Money in Chat settings"
  { regex: /^(.+) updated Money in Chat settings$/, rebuild: (name) => `${name} updated Money in Chat settings` },
  // "X renamed the group to "..."" — the quoted new group name is captured
  // separately so it survives the rewrite untouched; only the actor's name
  // is swapped.
  {
    regex: /^(.+) renamed the group to "(.+)"$/,
    rebuild: (name, match) => `${name} renamed the group to "${match[2]}"`,
  },
];

// Best-effort rewrite for a single legacy system message. Returns the new
// content string, or `undefined` when nothing should change (no template
// matched, or the caller couldn't resolve a current name for this sender —
// per doc 30, an unresolvable name means "leave it alone", never guess).
const rebuildLegacySystemMessageContent = (
  content: string,
  senderId: string,
  resolveCurrentName: (userId: string) => string | undefined,
): string | undefined => {
  for (const template of LEGACY_SELF_REFERENTIAL_SYSTEM_MESSAGE_TEMPLATES) {
    const match = content.match(template.regex);
    if (!match) continue;

    const currentName = resolveCurrentName(senderId)?.trim();
    if (!currentName) return undefined;

    return template.rebuild(currentName, match);
  }
  return undefined;
};

/**
 * Doc 30 §7 backward migration. Call lazily, once a chat's local history is
 * loaded and a name resolver for its group is available (e.g. from
 * ChatRoomScreen's `memberNames` map — userId → live resolveDisplayName()
 * result over the group's current members + archivedMembers). Rewrites the
 * stored `content` of any locally-saved `type: 'system'` message that:
 *   - has no `systemEventKind` yet (i.e. predates this doc), and
 *   - matches one of the five self-referential legacy templates above.
 *
 * Local-only, no network. Defensive by design: a message that doesn't
 * cleanly match, or whose sender's current name can't be resolved, is left
 * untouched; a single malformed entry is skipped rather than aborting the
 * whole pass. Never throws.
 */
export const migrateLegacySystemMessageNames = async (
  chatId: string,
  resolveCurrentName: (userId: string) => string | undefined,
): Promise<void> => {
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      let mutated = false;

      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        try {
          if (message.type !== 'system' || message.systemEventKind || !message.senderId || !message.content) {
            continue;
          }

          const nextContent = rebuildLegacySystemMessageContent(message.content, message.senderId, resolveCurrentName);
          if (nextContent !== undefined && nextContent !== message.content) {
            messages[i] = { ...message, content: nextContent };
            mutated = true;
          }
        } catch (innerError) {
          // One malformed message must never abort the rest of the pass.
          console.error('⚠️ Skipping one message during legacy system-message name migration:', innerError);
        }
      }

      if (!mutated) {
        return;
      }

      await AsyncStorage.setItem(key, JSON.stringify(messages));
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error migrating legacy system message names:', error);
  }
};

// Update a message's local media path (after downloading media)
export const updateMessageLocalPath = async (
  chatId: string,
  messageId: string,
  localMediaPath: string
): Promise<void> => {
  try {
    await withSerializedChatWrite(chatId, async () => {
      const key = getChatStorageKey(chatId);
      const messages = await readMessages(chatId);
      const messageIndex = messages.findIndex((m) => m.id === messageId || m.messageId === messageId);

      if (messageIndex < 0) {
        return;
      }

      messages[messageIndex] = {
        ...messages[messageIndex],
        localMediaPath,
      };

      await AsyncStorage.setItem(key, JSON.stringify(messages));
      console.log(`✅ Message ${messageId} local path updated to ${localMediaPath}`);
      notifyMessageListeners(chatId);
    });
  } catch (error) {
    console.error('❌ Error updating message local path:', error);
  }
};
