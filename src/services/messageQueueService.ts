// Firebase Realtime Database Message Queue Service
// WhatsApp-style temporary message storage
// Messages are cached in Firebase until delivered, then deleted
// Local storage is the primary message store (SQLite)

import { getDatabase, onValue, ref, remove, set, get } from 'firebase/database';
import { ChatMessage } from '../models';

// Get Realtime Database instance
const rtdb = getDatabase();

// Type for receipt data structure
interface ReceiptData {
  delivered?: boolean;
  deliveredAt?: number;
  read?: boolean;
  readAt?: number;
  recipientId: string;
}

// Type for group receipt structure (per-user receipts)
interface GroupReceiptData {
  [recipientId: string]: ReceiptData;
}

/**
 * Send a message to recipient's queue in Realtime Database
 * Message will be temporarily stored until delivered
 */
export const queueMessage = async (
  recipientId: string,
  message: ChatMessage
): Promise<void> => {
  try {
    const messageQueueRef = ref(rtdb, `messageQueue/${recipientId}/${message.id}`);
    
    await set(messageQueueRef, {
      senderId: message.senderId,
      chatId: message.chatId,
      content: message.content,
      type: message.type,
      timestamp: message.timestamp,
      mediaUrl: message.mediaUrl || null,
    });
    
    console.log('✅ Message queued for:', recipientId);
  } catch (error) {
    console.error('❌ Error queuing message:', error);
    throw error;
  }
};

/**
 * Listen for incoming messages in current user's queue
 * When a message arrives, save it locally and delete from queue
 */
export const listenForMessages = (
  userId: string,
  onMessageReceived: (message: ChatMessage) => Promise<void>
): (() => void) => {
  const queueRef = ref(rtdb, `messageQueue/${userId}`);
  
  const unsubscribe = onValue(queueRef, async (snapshot) => {
    if (snapshot.exists()) {
      const messages = snapshot.val();
      
      // Process each message
      for (const messageId in messages) {
        const messageData = messages[messageId];
        
        const message: ChatMessage = {
          id: messageId,
          messageId: messageId,
          chatId: messageData.chatId,
          senderId: messageData.senderId,
          content: messageData.content,
          type: messageData.type,
          timestamp: messageData.timestamp,
          createdAt: messageData.timestamp,
          mediaUrl: messageData.mediaUrl,
          status: 'delivered',
          isFromMe: false,
          deliveredTo: [],
          readBy: []
        };
        
        try {
          // Save message locally
          await onMessageReceived(message);
          
          // Send delivery receipt
          await sendDeliveryReceipt(messageData.chatId, messageId, userId);
          
          // Delete from queue after successful delivery
          await remove(ref(rtdb, `messageQueue/${userId}/${messageId}`));
          
          console.log('✅ Message delivered and removed from queue:', messageId);
        } catch (error) {
          console.error('❌ Error processing message:', error);
        }
      }
    }
  });
  
  return unsubscribe;
};

/**
 * Send delivery receipt to sender (supports both 1:1 and group chats)
 * For group chats, stores per-user receipt under the messageId
 */
export const sendDeliveryReceipt = async (
  chatId: string,
  messageId: string,
  recipientId: string,
  isGroupChat: boolean = false
): Promise<void> => {
  try {
    // For group chats, store receipt per user
    const receiptPath = isGroupChat
      ? `receipts/${chatId}/${messageId}/${recipientId}`
      : `receipts/${chatId}/${messageId}`;
    
    const receiptRef = ref(rtdb, receiptPath);
    
    await set(receiptRef, {
      delivered: true,
      deliveredAt: Date.now(),
      recipientId,
    });
    
    console.log('✅ Delivery receipt sent for:', messageId);
  } catch (error) {
    console.error('❌ Error sending delivery receipt:', error);
  }
};

/**
 * Send read receipt (supports both 1:1 and group chats)
 */
export const sendReadReceipt = async (
  chatId: string,
  messageId: string,
  recipientId: string,
  isGroupChat: boolean = false
): Promise<void> => {
  try {
    // For group chats, store receipt per user
    const receiptPath = isGroupChat
      ? `receipts/${chatId}/${messageId}/${recipientId}`
      : `receipts/${chatId}/${messageId}`;
    
    const receiptRef = ref(rtdb, receiptPath);
    
    await set(receiptRef, {
      delivered: true,
      deliveredAt: Date.now(),
      read: true,
      readAt: Date.now(),
      recipientId,
    });
    
    console.log('✅ Read receipt sent for:', messageId);
  } catch (error) {
    console.error('❌ Error sending read receipt:', error);
  }
};

/**
 * Send read receipts for multiple messages at once
 */
export const sendBulkReadReceipts = async (
  chatId: string,
  messageIds: string[],
  recipientId: string,
  isGroupChat: boolean = false
): Promise<void> => {
  try {
    const promises = messageIds.map(messageId => 
      sendReadReceipt(chatId, messageId, recipientId, isGroupChat)
    );
    await Promise.all(promises);
    console.log(`✅ Bulk read receipts sent for ${messageIds.length} messages`);
  } catch (error) {
    console.error('❌ Error sending bulk read receipts:', error);
  }
};

/**
 * Listen for delivery and read receipts (enhanced for group chats)
 * For group chats, aggregates per-user receipts
 */
export const listenForReceipts = (
  chatId: string,
  onReceiptReceived: (
    messageId: string,
    status: 'delivered' | 'read',
    recipientId?: string,
    allDelivered?: string[],
    allRead?: string[]
  ) => void,
  isGroupChat: boolean = false
): (() => void) => {
  const receiptsRef = ref(rtdb, `receipts/${chatId}`);
  
  const unsubscribe = onValue(receiptsRef, (snapshot) => {
    if (snapshot.exists()) {
      const receipts = snapshot.val();
      
      for (const messageId in receipts) {
        const messageReceipts = receipts[messageId];
        
        if (isGroupChat) {
          // Group chat: messageReceipts is an object with recipientId keys
          const allDelivered: string[] = [];
          const allRead: string[] = [];
          
          for (const recipientId in messageReceipts) {
            const receipt = messageReceipts[recipientId] as ReceiptData;
            if (receipt.delivered) allDelivered.push(recipientId);
            if (receipt.read) allRead.push(recipientId);
          }
          
          // Determine overall status for this message
          const hasRead = allRead.length > 0;
          const hasDelivered = allDelivered.length > 0;
          
          if (hasRead) {
            onReceiptReceived(messageId, 'read', undefined, allDelivered, allRead);
          } else if (hasDelivered) {
            onReceiptReceived(messageId, 'delivered', undefined, allDelivered, allRead);
          }
        } else {
          // 1:1 chat: messageReceipts is a single receipt object
          const receipt = messageReceipts as ReceiptData;
          
          if (receipt.read) {
            onReceiptReceived(messageId, 'read', receipt.recipientId);
          } else if (receipt.delivered) {
            onReceiptReceived(messageId, 'delivered', receipt.recipientId);
          }
        }
      }
    }
  });
  
  return unsubscribe;
};

/**
 * Get current receipt status for a message (one-time fetch)
 */
export const getReceiptStatus = async (
  chatId: string,
  messageId: string,
  isGroupChat: boolean = false
): Promise<{ deliveredTo: string[]; readBy: string[] }> => {
  try {
    const receiptRef = ref(rtdb, `receipts/${chatId}/${messageId}`);
    const snapshot = await get(receiptRef);
    
    if (!snapshot.exists()) {
      return { deliveredTo: [], readBy: [] };
    }
    
    const receipts = snapshot.val();
    
    if (isGroupChat) {
      const deliveredTo: string[] = [];
      const readBy: string[] = [];
      
      for (const recipientId in receipts) {
        const receipt = receipts[recipientId] as ReceiptData;
        if (receipt.delivered) deliveredTo.push(recipientId);
        if (receipt.read) readBy.push(recipientId);
      }
      
      return { deliveredTo, readBy };
    } else {
      const receipt = receipts as ReceiptData;
      return {
        deliveredTo: receipt.delivered ? [receipt.recipientId] : [],
        readBy: receipt.read ? [receipt.recipientId] : [],
      };
    }
  } catch (error) {
    console.error('❌ Error getting receipt status:', error);
    return { deliveredTo: [], readBy: [] };
  }
};