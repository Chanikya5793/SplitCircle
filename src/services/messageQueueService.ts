// Firebase Realtime Database Message Queue Service
// WhatsApp-style temporary message storage
// Messages are cached in Firebase until delivered, then deleted
// Local storage is the primary message store (SQLite)

import { get, getDatabase, onValue, ref, remove, set } from 'firebase/database';
import { ChatMessage } from '../models';
import { downloadMedia } from './mediaService';

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

const isReceiptData = (value: unknown): value is ReceiptData => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const data = value as Partial<ReceiptData>;
  return typeof data.recipientId === 'string';
};

/**
 * Normalize receipts to per-recipient map format.
 * Supports:
 * - Legacy direct-chat shape: { delivered, deliveredAt, recipientId, ... }
 * - Current unified shape: { recipientIdA: { ... }, recipientIdB: { ... } }
 */
const normalizeReceiptMap = (messageReceipts: unknown): GroupReceiptData => {
  if (isReceiptData(messageReceipts)) {
    return { [messageReceipts.recipientId]: messageReceipts };
  }

  if (!messageReceipts || typeof messageReceipts !== 'object') {
    return {};
  }

  const mapped: GroupReceiptData = {};
  for (const [recipientId, receiptValue] of Object.entries(messageReceipts as Record<string, unknown>)) {
    if (isReceiptData(receiptValue)) {
      mapped[recipientId] = receiptValue;
    }
  }
  return mapped;
};

/**
 * Send a message to recipient's queue in Realtime Database
 * Message will be temporarily stored until delivered
 */
export const queueMessage = async (
  recipientId: string,
  message: ChatMessage,
  isGroupChat: boolean = false
): Promise<void> => {
  try {
    const messageQueueRef = ref(rtdb, `messageQueue/${recipientId}/${message.id}`);
    
    // Build the message data, only including replyTo if it exists
    const messageData: Record<string, unknown> = {
      senderId: message.senderId,
      chatId: message.chatId,
      content: message.content,
      type: message.type,
      timestamp: message.timestamp,
      mediaUrl: message.mediaUrl || null,
      thumbnailUrl: message.thumbnailUrl || null,
      isGroupChat,
    };
    
    // Include mediaMetadata if it exists (for documents, audio, video, images)
    if (message.mediaMetadata) {
      messageData.mediaMetadata = {
        ...(message.mediaMetadata.fileName && { fileName: message.mediaMetadata.fileName }),
        ...(message.mediaMetadata.fileSize && { fileSize: message.mediaMetadata.fileSize }),
        ...(message.mediaMetadata.mimeType && { mimeType: message.mediaMetadata.mimeType }),
        ...(message.mediaMetadata.width && { width: message.mediaMetadata.width }),
        ...(message.mediaMetadata.height && { height: message.mediaMetadata.height }),
        ...(message.mediaMetadata.duration && { duration: message.mediaMetadata.duration }),
        ...(message.mediaMetadata.aspectRatio && { aspectRatio: message.mediaMetadata.aspectRatio }),
      };
      console.log('📎 Queuing message with mediaMetadata:', message.mediaMetadata.fileName || message.type);
    }
    
    // Only add replyTo if it exists and has valid data
    if (message.replyTo && message.replyTo.messageId) {
      messageData.replyTo = {
        messageId: message.replyTo.messageId,
        senderId: message.replyTo.senderId,
        senderName: message.replyTo.senderName,
        content: message.replyTo.content,
      };
      console.log('📎 Queuing message with replyTo:', message.replyTo.messageId);
    }

    // Add location data if it exists
    if (message.location) {
      messageData.location = {
        latitude: message.location.latitude,
        longitude: message.location.longitude,
        address: message.location.address,
      };
      console.log('📍 Queuing message with location');
    }
    
    await set(messageQueueRef, messageData);
    
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
        
        // Properly extract replyTo if it exists and has valid data
        let replyTo: ChatMessage['replyTo'] | undefined;
        if (messageData.replyTo && messageData.replyTo.messageId) {
          replyTo = {
            messageId: messageData.replyTo.messageId,
            senderId: messageData.replyTo.senderId,
            senderName: messageData.replyTo.senderName,
            content: messageData.replyTo.content,
          };
          console.log('📎 Received message with replyTo:', replyTo.messageId);
        }
        
        // Extract mediaMetadata if it exists
        let mediaMetadata: ChatMessage['mediaMetadata'] | undefined;
        if (messageData.mediaMetadata) {
          mediaMetadata = {
            ...(messageData.mediaMetadata.fileName && { fileName: messageData.mediaMetadata.fileName }),
            ...(messageData.mediaMetadata.fileSize && { fileSize: messageData.mediaMetadata.fileSize }),
            ...(messageData.mediaMetadata.mimeType && { mimeType: messageData.mediaMetadata.mimeType }),
            ...(messageData.mediaMetadata.width && { width: messageData.mediaMetadata.width }),
            ...(messageData.mediaMetadata.height && { height: messageData.mediaMetadata.height }),
            ...(messageData.mediaMetadata.duration && { duration: messageData.mediaMetadata.duration }),
            ...(messageData.mediaMetadata.aspectRatio && { aspectRatio: messageData.mediaMetadata.aspectRatio }),
          };
          console.log('📎 Received message with mediaMetadata:', mediaMetadata?.fileName || messageData.type);
        }
        
        // Download media if this message has media attached
        let localMediaPath: string | undefined;
        let mediaDownloaded = false;
        const hasMedia = messageData.type !== 'text' && messageData.type !== 'system' && messageData.type !== 'location';
        const mediaUrl = messageData.mediaUrl as string | undefined;
        
        if (hasMedia && mediaUrl) {
          try {
            // Determine filename
            const fileName = mediaMetadata?.fileName || `${messageId}.${messageData.type === 'image' ? 'jpg' : 'dat'}`;

            // Download media from Firebase Storage URL
            const result = await downloadMedia(mediaUrl, messageData.chatId, messageId, fileName);
            if (result && result.localPath) {
              localMediaPath = result.localPath;
              mediaDownloaded = true;
              console.log('📥 Media downloaded and saved:', localMediaPath);
            }
          } catch (error) {
            console.error('❌ Error downloading media:', error);
            // Continue processing message even if media download fails
          }
        }
        
        const message: ChatMessage = {
          id: messageId,
          messageId: messageId,
          chatId: messageData.chatId,
          senderId: messageData.senderId,
          content: messageData.content,
          type: messageData.type,
          timestamp: messageData.timestamp,
          createdAt: messageData.timestamp,
          mediaUrl: mediaUrl,
          // Use local path if download succeeded
          ...(localMediaPath ? { localMediaPath, mediaDownloaded } : {}),
          mediaMetadata,
          replyTo,
          location: messageData.location,
          status: 'delivered',
          isFromMe: false,
          deliveredTo: [],
          readBy: []
        };
        
        try {
          // Save message locally
          await onMessageReceived(message);
          
          // Send delivery receipt (use isGroupChat flag from message)
          const isGroupChat = messageData.isGroupChat || false;
          await sendDeliveryReceipt(messageData.chatId, messageId, userId, isGroupChat);
          
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
  _isGroupChat: boolean = false
): Promise<void> => {
  try {
    // Unified path for both direct and group chats.
    // Keeping per-recipient keys avoids rules/data-model divergence.
    const receiptPath = `receipts/${chatId}/${messageId}/${recipientId}`;
    
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
  _isGroupChat: boolean = false
): Promise<void> => {
  try {
    // Unified path for both direct and group chats.
    const receiptPath = `receipts/${chatId}/${messageId}/${recipientId}`;
    
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
        const receiptMap = normalizeReceiptMap(messageReceipts);
        const allDelivered = Object.entries(receiptMap)
          .filter(([, receipt]) => receipt.delivered)
          .map(([recipientId]) => recipientId);
        const allRead = Object.entries(receiptMap)
          .filter(([, receipt]) => receipt.read)
          .map(([recipientId]) => recipientId);
        
        if (isGroupChat) {
          // Determine overall status for this message
          const hasRead = allRead.length > 0;
          const hasDelivered = allDelivered.length > 0;
          
          if (hasRead) {
            onReceiptReceived(messageId, 'read', undefined, allDelivered, allRead);
          } else if (hasDelivered) {
            onReceiptReceived(messageId, 'delivered', undefined, allDelivered, allRead);
          }
        } else {
          // 1:1 chat: support both legacy flat and nested-per-recipient formats.
          const firstReadRecipientId = allRead[0];
          const firstDeliveredRecipientId = allDelivered[0];

          if (firstReadRecipientId) {
            onReceiptReceived(messageId, 'read', firstReadRecipientId);
          } else if (firstDeliveredRecipientId) {
            onReceiptReceived(messageId, 'delivered', firstDeliveredRecipientId);
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
    
    const receiptMap = normalizeReceiptMap(snapshot.val());
    const deliveredTo = Object.entries(receiptMap)
      .filter(([, receipt]) => receipt.delivered)
      .map(([recipientId]) => recipientId);
    const readBy = Object.entries(receiptMap)
      .filter(([, receipt]) => receipt.read)
      .map(([recipientId]) => recipientId);

    if (!isGroupChat && deliveredTo.length > 1) {
      // Defensive: direct chats should have at most one peer receipt.
      return {
        deliveredTo: deliveredTo.slice(0, 1),
        readBy: readBy.slice(0, 1),
      };
    }

    return { deliveredTo, readBy };
  } catch (error) {
    console.error('❌ Error getting receipt status:', error);
    return { deliveredTo: [], readBy: [] };
  }
};
