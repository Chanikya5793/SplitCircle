// Firebase Realtime Database Message Queue Service
// WhatsApp-style temporary message storage
// Messages are cached in Firebase until delivered, then deleted
// Local storage is the primary message store (AsyncStorage)

import {
  get,
  getDatabase,
  onChildAdded,
  onChildChanged,
  onValue,
  ref,
  remove,
  set,
  update,
  type DataSnapshot,
} from 'firebase/database';
import type { ChatMessage, MessageType } from '@/models';
import { downloadMedia } from '@/services/mediaService';

// Get Realtime Database instance
const rtdb = getDatabase();

// Type for receipt data structure
export interface ReceiptData {
  delivered?: boolean;
  deliveredAt?: number;
  read?: boolean;
  readAt?: number;
  recipientId: string;
}

interface PersistedReceiptData {
  delivered: boolean;
  deliveredAt: number;
  read?: boolean;
  readAt?: number;
  recipientId: string;
}

// Type for group receipt structure (per-user receipts)
interface GroupReceiptData {
  [recipientId: string]: ReceiptData;
}

interface QueueMessagePayload {
  senderId: string;
  chatId: string;
  content: string;
  type: MessageType;
  timestamp: number;
  mediaUrl?: string | null;
  thumbnailUrl?: string | null;
  isGroupChat?: boolean;
  mediaMetadata?: ChatMessage['mediaMetadata'];
  replyTo?: ChatMessage['replyTo'];
  location?: ChatMessage['location'];
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

const normalizeTimestamp = (value: unknown): number => {
  if (typeof value === 'number') {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const parseQueuePayload = (value: unknown): QueueMessagePayload | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const senderId = typeof payload.senderId === 'string' ? payload.senderId : '';
  const chatId = typeof payload.chatId === 'string' ? payload.chatId : '';
  const content = typeof payload.content === 'string' ? payload.content : '';
  const type = typeof payload.type === 'string' ? payload.type as MessageType : 'text';

  if (!senderId || !chatId || !type) {
    return null;
  }

  return {
    senderId,
    chatId,
    content,
    type,
    timestamp: normalizeTimestamp(payload.timestamp),
    mediaUrl: typeof payload.mediaUrl === 'string' ? payload.mediaUrl : null,
    thumbnailUrl: typeof payload.thumbnailUrl === 'string' ? payload.thumbnailUrl : null,
    isGroupChat: typeof payload.isGroupChat === 'boolean' ? payload.isGroupChat : false,
    mediaMetadata: payload.mediaMetadata as ChatMessage['mediaMetadata'] | undefined,
    replyTo: payload.replyTo as ChatMessage['replyTo'] | undefined,
    location: payload.location as ChatMessage['location'] | undefined,
  };
};

const getReceiptFingerprint = (
  status: 'delivered' | 'read',
  allDelivered: string[],
  allRead: string[]
): string => {
  const deliveredSorted = [...allDelivered].sort();
  const readSorted = [...allRead].sort();
  return `${status}|d:${deliveredSorted.join(',')}|r:${readSorted.join(',')}`;
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

    if (message.replyTo && message.replyTo.messageId) {
      messageData.replyTo = {
        messageId: message.replyTo.messageId,
        senderId: message.replyTo.senderId,
        senderName: message.replyTo.senderName,
        content: message.replyTo.content,
      };
      console.log('📎 Queuing message with replyTo:', message.replyTo.messageId);
    }

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
 * Register the current user as a permitted receipt reader for a chat.
 * This is used by RTDB rules to scope receipt reads.
 */
export const registerReceiptParticipant = async (chatId: string, userId: string): Promise<void> => {
  try {
    await set(ref(rtdb, `receipts/${chatId}/__participants/${userId}`), true);
  } catch (error) {
    console.error('❌ Error registering receipt participant:', error);
    throw error;
  }
};

/**
 * Listen for receipt updates for a single message.
 * This includes per-recipient delivery/read timestamps from RTDB.
 */
export const listenForMessageReceipts = (
  chatId: string,
  messageId: string,
  onReceiptsChanged: (receipts: Record<string, ReceiptData>) => void
): (() => void) => {
  const receiptRef = ref(rtdb, `receipts/${chatId}/${messageId}`);

  const unsubscribe = onValue(
    receiptRef,
    (snapshot) => {
      const normalized = normalizeReceiptMap(snapshot.val());
      onReceiptsChanged(normalized);
    },
    (error) => {
      console.error('❌ Error listening for message receipts:', error);
      onReceiptsChanged({});
    }
  );

  return () => {
    unsubscribe();
  };
};

/**
 * Listen for incoming messages in current user's queue.
 * Uses child listeners so each queue entry is processed once and avoids full path rescans.
 */
export const listenForMessages = (
  userId: string,
  onMessageReceived: (message: ChatMessage) => Promise<void>
): (() => void) => {
  const queueRef = ref(rtdb, `messageQueue/${userId}`);
  const processingMessageIds = new Set<string>();

  const processMessageSnapshot = async (snapshot: DataSnapshot): Promise<void> => {
    const messageId = snapshot.key;
    if (!messageId) {
      return;
    }

    if (processingMessageIds.has(messageId)) {
      return;
    }

    const payload = parseQueuePayload(snapshot.val());
    if (!payload) {
      console.warn('⚠️ Invalid queue message payload, skipping:', messageId);
      return;
    }

    processingMessageIds.add(messageId);

    try {
      let localMediaPath: string | undefined;
      let mediaDownloaded = false;
      const hasMedia = payload.type !== 'text' && payload.type !== 'system' && payload.type !== 'location';

      if (hasMedia && payload.mediaUrl) {
        try {
          const fileName = payload.mediaMetadata?.fileName || `${messageId}.${payload.type === 'image' ? 'jpg' : 'dat'}`;
          const result = await downloadMedia(payload.mediaUrl, payload.chatId, messageId, fileName);
          if (result && result.localPath) {
            localMediaPath = result.localPath;
            mediaDownloaded = true;
            console.log('📥 Media downloaded and saved:', localMediaPath);
          }
        } catch (error) {
          console.error('❌ Error downloading media:', error);
        }
      }

      const message: ChatMessage = {
        id: messageId,
        messageId,
        chatId: payload.chatId,
        senderId: payload.senderId,
        content: payload.content,
        type: payload.type,
        timestamp: payload.timestamp,
        createdAt: payload.timestamp,
        mediaUrl: payload.mediaUrl ?? undefined,
        ...(localMediaPath ? { localMediaPath, mediaDownloaded } : {}),
        mediaMetadata: payload.mediaMetadata,
        replyTo: payload.replyTo,
        location: payload.location,
        status: 'delivered',
        isFromMe: false,
        deliveredTo: [],
        readBy: [],
      };

      await onMessageReceived(message);
      await sendDeliveryReceipt(payload.chatId, messageId, userId, payload.isGroupChat ?? false);
      await remove(ref(rtdb, `messageQueue/${userId}/${messageId}`));
      console.log('✅ Message delivered and removed from queue:', messageId);
    } catch (error) {
      console.error('❌ Error processing message:', error);
    } finally {
      processingMessageIds.delete(messageId);
    }
  };

  const unsubscribeAdded = onChildAdded(queueRef, (snapshot) => {
    void processMessageSnapshot(snapshot);
  });

  const unsubscribeChanged = onChildChanged(queueRef, (snapshot) => {
    void processMessageSnapshot(snapshot);
  });

  return () => {
    unsubscribeAdded();
    unsubscribeChanged();
  };
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
    const receiptRef = ref(rtdb, `receipts/${chatId}/${messageId}/${recipientId}`);
    await update(receiptRef, {
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
  const receiptRef = ref(rtdb, `receipts/${chatId}/${messageId}/${recipientId}`);
  const now = Date.now();

  try {
    const existingSnapshot = await get(receiptRef);
    const existingValue = existingSnapshot.val() as Partial<ReceiptData> | null;
    const deliveredAt = typeof existingValue?.deliveredAt === 'number' ? existingValue.deliveredAt : now;

    // Always write a complete receipt object to satisfy strict RTDB validation.
    await update(receiptRef, {
      delivered: true,
      deliveredAt,
      recipientId,
      read: true,
      readAt: now,
    });
    console.log('✅ Read receipt sent for:', messageId);
  } catch (error) {
    console.error('❌ Error sending read receipt:', error);
  }
};

/**
 * Send read receipts for multiple messages at once using a single multi-path update.
 */
export const sendBulkReadReceipts = async (
  chatId: string,
  messageIds: string[],
  recipientId: string,
  isGroupChat: boolean = false
): Promise<void> => {
  try {
    if (messageIds.length === 0) {
      return;
    }

    const now = Date.now();
    const updates: Record<string, PersistedReceiptData> = {};

    await Promise.all(
      messageIds.map(async (messageId) => {
        const receiptRef = ref(rtdb, `receipts/${chatId}/${messageId}/${recipientId}`);
        const existingSnapshot = await get(receiptRef);
        const existingValue = existingSnapshot.val() as Partial<ReceiptData> | null;
        const deliveredAt = typeof existingValue?.deliveredAt === 'number' ? existingValue.deliveredAt : now;

        updates[`receipts/${chatId}/${messageId}/${recipientId}`] = {
          delivered: true,
          deliveredAt,
          recipientId,
          read: true,
          readAt: now,
        };
      })
    );

    await update(ref(rtdb), updates);
    console.log(`✅ Bulk read receipts sent for ${messageIds.length} messages`);
  } catch (error) {
    console.error('❌ Error sending bulk read receipts:', error);
    if (messageIds.length > 0) {
      await Promise.all(messageIds.map((messageId) => sendReadReceipt(chatId, messageId, recipientId, isGroupChat)));
    }
  }
};

/**
 * Listen for delivery and read receipts.
 * Uses child listeners to process only changed message receipts.
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
  isGroupChat: boolean = false,
  onError?: (error: Error) => void,
): (() => void) => {
  const receiptsRef = ref(rtdb, `receipts/${chatId}`);
  const fingerprints = new Map<string, string>();

  const processReceiptSnapshot = (snapshot: DataSnapshot): void => {
    const messageId = snapshot.key;
    if (!messageId || messageId === '__participants') {
      return;
    }

    const receiptMap = normalizeReceiptMap(snapshot.val());
    const allDelivered = Object.entries(receiptMap)
      .filter(([, receipt]) => receipt.delivered)
      .map(([recipientId]) => recipientId)
      .sort();
    const allRead = Object.entries(receiptMap)
      .filter(([, receipt]) => receipt.read)
      .map(([recipientId]) => recipientId)
      .sort();

    const status: 'delivered' | 'read' | null = allRead.length > 0
      ? 'read'
      : allDelivered.length > 0
        ? 'delivered'
        : null;

    if (!status) {
      fingerprints.delete(messageId);
      return;
    }

    const fingerprint = getReceiptFingerprint(status, allDelivered, allRead);
    if (fingerprints.get(messageId) === fingerprint) {
      return;
    }

    fingerprints.set(messageId, fingerprint);

    if (isGroupChat) {
      onReceiptReceived(messageId, status, undefined, allDelivered, allRead);
      return;
    }

    const recipientId = status === 'read' ? allRead[0] : allDelivered[0];
    if (recipientId) {
      onReceiptReceived(messageId, status, recipientId);
    }
  };

  const unsubscribeAdded = onChildAdded(
    receiptsRef,
    processReceiptSnapshot,
    (error: Error) => {
      console.warn('⚠️ Receipt listener (added) cancelled:', error);
      onError?.(error);
    }
  );
  const unsubscribeChanged = onChildChanged(
    receiptsRef,
    processReceiptSnapshot,
    (error: Error) => {
      console.warn('⚠️ Receipt listener (changed) cancelled:', error);
      onError?.(error);
    }
  );

  return () => {
    unsubscribeAdded();
    unsubscribeChanged();
    fingerprints.clear();
  };
};
