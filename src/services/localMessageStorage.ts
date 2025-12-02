import AsyncStorage from '@react-native-async-storage/async-storage';
import { ChatMessage } from '../models';

const MESSAGES_KEY_PREFIX = 'chat_messages_';

// Initialize the storage (No-op for AsyncStorage but kept for API compatibility)
export const initMessageDB = async (): Promise<void> => {
  console.log('✅ Message storage initialized (AsyncStorage)');
};

// Save a message to local storage
export const saveMessageLocally = async (message: ChatMessage): Promise<void> => {
  try {
    const key = `${MESSAGES_KEY_PREFIX}${message.chatId}`;
    const existingData = await AsyncStorage.getItem(key);
    let messages: ChatMessage[] = existingData ? JSON.parse(existingData) : [];

    // Check if message already exists
    const existingIndex = messages.findIndex(m => m.id === message.id);
    
    if (existingIndex >= 0) {
      // Merge with existing message to preserve fields like replyTo
      // that might not be included in status updates
      const existingMessage = messages[existingIndex];
      messages[existingIndex] = {
        ...existingMessage,  // Keep existing data (especially replyTo)
        ...message,          // Overlay new data
        // Explicitly preserve replyTo - use new value if provided, otherwise keep existing
        replyTo: message.replyTo || existingMessage.replyTo,
      };
      console.log('✅ Message updated locally:', message.id, message.replyTo ? '(with replyTo)' : '');
    } else {
      // Add new message
      messages.push(message);
      console.log('✅ New message saved locally:', message.id, message.replyTo ? '(with replyTo)' : '');
    }

    // Sort by timestamp to ensure order
    messages.sort((a, b) => {
        const timeA = typeof a.timestamp === 'number' ? a.timestamp : new Date(a.timestamp).getTime();
        const timeB = typeof b.timestamp === 'number' ? b.timestamp : new Date(b.timestamp).getTime();
        return timeA - timeB;
    });

    await AsyncStorage.setItem(key, JSON.stringify(messages));
  } catch (error) {
    console.error('❌ Error saving message locally:', error);
    throw error;
  }
};

// Get all messages for a chat
export const getChatMessages = async (chatId: string): Promise<ChatMessage[]> => {
  try {
    const key = `${MESSAGES_KEY_PREFIX}${chatId}`;
    const data = await AsyncStorage.getItem(key);
    
    if (!data) return [];
    
    const messages: ChatMessage[] = JSON.parse(data);
    return messages;
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
  readBy?: string[]
): Promise<void> => {
  try {
    const key = `${MESSAGES_KEY_PREFIX}${chatId}`;
    const data = await AsyncStorage.getItem(key);
    
    if (!data) return;
    
    const messages: ChatMessage[] = JSON.parse(data);
    const messageIndex = messages.findIndex(m => m.id === messageId || m.messageId === messageId);
    
    if (messageIndex >= 0) {
      messages[messageIndex] = {
        ...messages[messageIndex],
        status,
        ...(deliveredTo !== undefined ? { deliveredTo } : {}),
        ...(readBy !== undefined ? { readBy } : {}),
      };
      
      await AsyncStorage.setItem(key, JSON.stringify(messages));
      console.log(`✅ Message ${messageId} status updated to ${status}`);
    }
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
    const key = `${MESSAGES_KEY_PREFIX}${chatId}`;
    const data = await AsyncStorage.getItem(key);
    
    if (!data) return;
    
    const messages: ChatMessage[] = JSON.parse(data);
    let updated = false;
    
    for (const messageId of messageIds) {
      const messageIndex = messages.findIndex(m => m.id === messageId || m.messageId === messageId);
      
      if (messageIndex >= 0) {
        const message = messages[messageIndex];
        const deliveredTo = message.deliveredTo || [];
        
        if (!deliveredTo.includes(deliveredByUserId)) {
          deliveredTo.push(deliveredByUserId);
          messages[messageIndex] = {
            ...message,
            deliveredTo,
            status: message.status === 'sent' ? 'delivered' : message.status,
          };
          updated = true;
        }
      }
    }
    
    if (updated) {
      await AsyncStorage.setItem(key, JSON.stringify(messages));
      console.log(`✅ Marked ${messageIds.length} messages as delivered by ${deliveredByUserId}`);
    }
  } catch (error) {
    console.error('❌ Error marking messages delivered:', error);
  }
};

// Mark multiple messages as read by a specific user
export const markMessagesRead = async (
  chatId: string,
  messageIds: string[],
  readByUserId: string
): Promise<void> => {
  try {
    const key = `${MESSAGES_KEY_PREFIX}${chatId}`;
    const data = await AsyncStorage.getItem(key);
    
    if (!data) return;
    
    const messages: ChatMessage[] = JSON.parse(data);
    let updated = false;
    
    for (const messageId of messageIds) {
      const messageIndex = messages.findIndex(m => m.id === messageId || m.messageId === messageId);
      
      if (messageIndex >= 0) {
        const message = messages[messageIndex];
        const readBy = message.readBy || [];
        const deliveredTo = message.deliveredTo || [];
        
        // If someone read it, they also delivered it
        if (!deliveredTo.includes(readByUserId)) {
          deliveredTo.push(readByUserId);
        }
        
        if (!readBy.includes(readByUserId)) {
          readBy.push(readByUserId);
          messages[messageIndex] = {
            ...message,
            deliveredTo,
            readBy,
            status: 'read',
          };
          updated = true;
        }
      }
    }
    
    if (updated) {
      await AsyncStorage.setItem(key, JSON.stringify(messages));
      console.log(`✅ Marked ${messageIds.length} messages as read by ${readByUserId}`);
    }
  } catch (error) {
    console.error('❌ Error marking messages read:', error);
  }
};

// Get unread messages from a specific sender (for triggering read receipts)
export const getUnreadMessagesFromSender = async (
  chatId: string,
  senderId: string,
  currentUserId: string
): Promise<ChatMessage[]> => {
  try {
    const messages = await getChatMessages(chatId);
    
    return messages.filter(msg => 
      msg.senderId === senderId && 
      msg.senderId !== currentUserId &&
      (!msg.readBy || !msg.readBy.includes(currentUserId))
    );
  } catch (error) {
    console.error('❌ Error getting unread messages:', error);
    return [];
  }
};
