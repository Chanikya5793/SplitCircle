import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChatMessage } from '@/models';

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

// Get all messages for a chat
export const getChatMessages = async (chatId: string): Promise<ChatMessage[]> => {
  try {
    return await readMessages(chatId);
  } catch (error) {
    console.error('❌ Error getting chat messages:', error);
    return [];
  }
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
