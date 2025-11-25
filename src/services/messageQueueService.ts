// Firebase Realtime Database Message Queue Service
// WhatsApp-style temporary message storage
// Messages are cached in Firebase until delivered, then deleted
// Local storage is the primary message store (SQLite)

import { getDatabase, onValue, ref, remove, set } from 'firebase/database';
import { ChatMessage } from '../models';

// Get Realtime Database instance
const rtdb = getDatabase();

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
 * Send delivery receipt to sender
 */
export const sendDeliveryReceipt = async (
  chatId: string,
  messageId: string,
  recipientId: string
): Promise<void> => {
  try {
    const receiptRef = ref(rtdb, `receipts/${chatId}/${messageId}`);
    
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
 * Send read receipt
 */
export const sendReadReceipt = async (
  chatId: string,
  messageId: string,
  recipientId: string
): Promise<void> => {
  try {
    const receiptRef = ref(rtdb, `receipts/${chatId}/${messageId}`);
    
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
 * Listen for delivery and read receipts
 */
export const listenForReceipts = (
  chatId: string,
  onReceiptReceived: (messageId: string, status: 'delivered' | 'read') => void
): (() => void) => {
  const receiptsRef = ref(rtdb, `receipts/${chatId}`);
  
  const unsubscribe = onValue(receiptsRef, (snapshot) => {
    if (snapshot.exists()) {
      const receipts = snapshot.val();
      
      for (const messageId in receipts) {
        const receipt = receipts[messageId];
        
        if (receipt.read) {
          onReceiptReceived(messageId, 'read');
        } else if (receipt.delivered) {
          onReceiptReceived(messageId, 'delivered');
        }
      }
    }
  });
  
  return unsubscribe;
};