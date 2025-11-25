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
      // Update existing message
      messages[existingIndex] = message;
    } else {
      // Add new message
      messages.push(message);
    }

    // Sort by timestamp to ensure order
    messages.sort((a, b) => {
        const timeA = typeof a.timestamp === 'number' ? a.timestamp : new Date(a.timestamp).getTime();
        const timeB = typeof b.timestamp === 'number' ? b.timestamp : new Date(b.timestamp).getTime();
        return timeA - timeB;
    });

    await AsyncStorage.setItem(key, JSON.stringify(messages));
    console.log('✅ Message saved locally:', message.id);
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
