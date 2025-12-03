import { db, storage } from '@/firebase';
import type { ChatMessage, ChatParticipant, ChatThread, MediaMetadata, MessageType } from '@/models';
import {
    collection,
    doc,
    onSnapshot,
    query,
    serverTimestamp,
    setDoc,
    updateDoc,
    where
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import {
    getChatMessages,
    initMessageDB,
    markMessagesDelivered,
    markMessagesRead,
    saveMessageLocally,
    updateMessageStatus
} from '../services/localMessageStorage';
import {
    listenForMessages,
    listenForReceipts,
    queueMessage,
    sendBulkReadReceipts
} from '../services/messageQueueService';
import { useAuth } from './AuthContext';

interface SendMessagePayload {
  chatId: string;
  content: string;
  type?: MessageType;
  mediaUri?: string;
  mediaMetadata?: MediaMetadata;
  groupId?: string;
  replyTo?: {
    messageId: string;
    senderId: string;
    senderName: string;
    content: string;
    type?: MessageType;
  };
}

interface ChatContextValue {
  threads: ChatThread[];
  loading: boolean;
  sendMessage: (payload: SendMessagePayload) => Promise<void>;
  subscribeToMessages: (chatId: string, onData: (messages: ChatMessage[]) => void) => () => void;
  ensureGroupThread: (groupId: string, participants: ChatParticipant[]) => Promise<string>;
  markChatAsRead: (chatId: string) => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

const normalizeTimestamp = (value: unknown): number => {
  if (!value) return Date.now();
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null) {
    const maybeTimestamp = value as { toMillis?: () => number; seconds?: number; nanoseconds?: number };
    if (maybeTimestamp.toMillis) {
      return maybeTimestamp.toMillis();
    }
    if (typeof maybeTimestamp.seconds === 'number') {
      return maybeTimestamp.seconds * 1000;
    }
  }
  return Date.now();
};

/**
 * Remove undefined values from an object (Firebase doesn't accept undefined)
 */
const removeUndefined = <T extends Record<string, unknown>>(obj: T): Partial<T> => {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    const value = obj[key];
    if (value !== undefined) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = removeUndefined(value as Record<string, unknown>) as T[keyof T];
      } else {
        result[key] = value;
      }
    }
  }
  return result;
};

export const ChatProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { user } = useAuth();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [loading, setLoading] = useState(true);

  // Initialize SQLite database on mount
  useEffect(() => {
    const initDB = async () => {
      try {
        await initMessageDB();
        console.log('✅ SQLite database initialized');
      } catch (error) {
        console.error('❌ Failed to initialize database:', error);
      }
    };
    
    initDB();
  }, []);

  useEffect(() => {
    if (!user) {
      setThreads([]);
      setLoading(false);
      return () => undefined;
    }

    const chatsRef = collection(db, 'chats');
    const q = query(chatsRef, where('participantIds', 'array-contains', user.userId));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const payload = snapshot.docs.map((docSnap) => {
        const data = docSnap.data() as ChatThread & { lastMessage?: ChatMessage };
        return {
          ...data,
          participantIds: data.participantIds ?? data.participants.map((participant) => participant.userId),
          lastMessage: data.lastMessage
            ? { ...data.lastMessage, createdAt: normalizeTimestamp(data.lastMessage.createdAt) }
            : undefined,
          updatedAt: data.updatedAt ? normalizeTimestamp(data.updatedAt) : undefined,
        } satisfies ChatThread;
      });
      setThreads(payload);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user?.userId]);

  const subscribeToMessages = useCallback((chatId: string, onData: (messages: ChatMessage[]) => void) => {
    if (!user) return () => {};

    // Find thread to determine if it's a group chat
    const thread = threads.find(t => t.chatId === chatId);
    const isGroupChat = thread?.type === 'group';

    // 1. Load local messages immediately
    const loadLocalMessages = () => {
      getChatMessages(chatId).then((localMessages) => {
        const sorted = localMessages.sort((a, b) => b.createdAt - a.createdAt);
        onData(sorted);
      });
    };

    loadLocalMessages();

    // 2. Listen for incoming messages from Realtime Database queue
    // This ensures we get messages immediately when they arrive
    const unsubscribeQueue = listenForMessages(user.userId, async (message) => {
      // Save locally
      await saveMessageLocally(message);
      
      // If this message belongs to the current chat, update UI immediately
      if (message.chatId === chatId) {
        console.log('📨 New message received via queue, updating UI');
        loadLocalMessages();
      }
    });
    
    // 3. Listen for delivery/read receipts for messages we sent
    const unsubscribeReceipts = listenForReceipts(
      chatId,
      async (messageId, status, recipientId, allDelivered, allRead) => {
        console.log(`📬 Receipt received: ${messageId} -> ${status}`);
        
        if (isGroupChat && allDelivered !== undefined && allRead !== undefined) {
          // Group chat: update with arrays of who delivered/read
          await updateMessageStatus(chatId, messageId, status, allDelivered, allRead);
        } else if (recipientId) {
          // 1:1 chat: mark as delivered/read
          if (status === 'read') {
            await markMessagesRead(chatId, [messageId], recipientId);
          } else if (status === 'delivered') {
            await markMessagesDelivered(chatId, [messageId], recipientId);
          }
        }
        
        // Refresh UI
        loadLocalMessages();
      },
      isGroupChat
    );
    
    // 4. Poll local storage as a backup (in case we missed something or for other updates)
    const interval = setInterval(loadLocalMessages, 3000);

    return () => {
      clearInterval(interval);
      unsubscribeQueue();
      unsubscribeReceipts();
    };
  }, [user, threads]);

  const sendMessage = useCallback(
    async ({ chatId, content, type = 'text', mediaUri, mediaMetadata, groupId, replyTo }: SendMessagePayload) => {
      if (!user) {
        throw new Error('Missing user for chat send');
      }

      let mediaUrl: string | undefined;
      let thumbnailUrl: string | undefined;
      
      if (mediaUri) {
        try {
          // Convert URI to blob - handle both file:// and ph:// URIs
          let blob: Blob;
          
          // For iOS Photos Library assets (ph://) and all other URIs
          // fetch() should work with file:// URIs from expo-image-picker
          const response = await fetch(mediaUri);
          if (!response.ok) {
            throw new Error(`Failed to fetch media: ${response.status}`);
          }
          blob = await response.blob();
          
          // Determine file extension from metadata or type
          const extension = getFileExtension(mediaMetadata?.mimeType, type);
          const fileName = `${uuid()}${extension}`;
          const fileRef = ref(storage, `chats/${chatId}/${fileName}`);
          
          await uploadBytes(fileRef, blob);
          mediaUrl = await getDownloadURL(fileRef);
          
          // For images and videos, we could generate thumbnails here
          // For now, we'll use the same URL for images
          if (type === 'image') {
            thumbnailUrl = mediaUrl;
          }
        } catch (error) {
          console.error('Failed to upload media:', error);
          // Provide more specific error message
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          throw new Error(`Failed to upload media: ${errorMessage}`);
        }
      }

      const msgId = uuid();
      const now = Date.now();
      const message: ChatMessage = {
        id: msgId,
        messageId: msgId,
        chatId,
        senderId: user.userId,
        type,
        content,
        ...(mediaUrl ? { mediaUrl } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        ...(mediaMetadata ? { mediaMetadata } : {}),
        ...(replyTo ? { replyTo } : {}),
        status: 'sent',
        createdAt: now,
        timestamp: now,
        isFromMe: true,
        deliveredTo: [],
        readBy: [user.userId],
      };

    // 1. Save message locally (AsyncStorage)
    await saveMessageLocally(message);
    
    // 2. Queue message for each recipient (Realtime Database)
    // Get recipient IDs from chat participants (exclude sender)
    const thread = threads.find(t => t.chatId === chatId);
    const participants = thread?.participants || [];
    const isGroupChat = thread?.type === 'group';
    const recipientIds = participants
      .map(p => p.userId)
      .filter(id => id !== user.userId);
    
    // Queue message for each recipient
    for (const recipientId of recipientIds) {
      await queueMessage(recipientId, message, isGroupChat);
    }
    
    console.log(`✅ ${type} message saved locally and queued (WhatsApp style)`);
    
      // Update the chat thread's lastMessage (metadata only, not the full history)
      // Clean the message object to remove undefined values (Firebase doesn't accept them)
      const cleanMessage = removeUndefined({ ...message, createdAt: serverTimestamp() });
      await updateDoc(doc(db, 'chats', chatId), {
        lastMessage: cleanMessage,
        groupId: groupId ?? null,
        updatedAt: Date.now(),
      });
    },
    [user, threads],
  );

  // Helper to get file extension from mime type
  const getFileExtension = (mimeType?: string, type?: MessageType): string => {
    if (mimeType) {
      const mimeMap: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'video/mp4': '.mp4',
        'video/quicktime': '.mov',
        'audio/mpeg': '.mp3',
        'audio/mp4': '.m4a',
        'audio/wav': '.wav',
        'application/pdf': '.pdf',
      };
      if (mimeMap[mimeType]) return mimeMap[mimeType];
    }
    
    // Fallback based on type
    switch (type) {
      case 'image': return '.jpg';
      case 'video': return '.mp4';
      case 'audio': return '.mp3';
      case 'file': return '';
      default: return '';
    }
  };

  const ensureGroupThread = useCallback(
    async (groupId: string, participants: ChatParticipant[]) => {
      if (!user) {
        throw new Error('Missing user context');
      }
      const existing = threads.find((thread) => thread.groupId === groupId);
      if (existing) {
        return existing.chatId;
      }
      const chatId = uuid();
      await setDoc(doc(db, 'chats', chatId), {
        chatId,
        type: 'group',
        participantIds: participants.map((participant) => participant.userId),
        participants,
        groupId,
        unreadCount: 0,
        updatedAt: Date.now(),
      } satisfies Partial<ChatThread>);
      return chatId;
    },
    [threads, user],
  );

  /**
   * Mark all unread messages in a chat as read
   * This should be called when the user opens a chat room
   */
  const markChatAsRead = useCallback(
    async (chatId: string) => {
      if (!user) return;
      
      const thread = threads.find(t => t.chatId === chatId);
      if (!thread) return;
      
      const isGroupChat = thread.type === 'group';
      
      // Get all messages in the chat
      const messages = await getChatMessages(chatId);
      
      // Find messages from other users that we haven't read yet
      const unreadMessageIds = messages
        .filter(msg => 
          msg.senderId !== user.userId && 
          (!msg.readBy || !msg.readBy.includes(user.userId))
        )
        .map(msg => msg.id);
      
      if (unreadMessageIds.length === 0) {
        console.log('📖 No unread messages to mark as read');
        return;
      }
      
      console.log(`📖 Marking ${unreadMessageIds.length} messages as read`);
      
      // Update local storage
      await markMessagesRead(chatId, unreadMessageIds, user.userId);
      
      // Send read receipts to Firebase for the sender(s) to receive
      await sendBulkReadReceipts(chatId, unreadMessageIds, user.userId, isGroupChat);
      
      console.log('✅ Read receipts sent');
    },
    [user, threads]
  );

  const value = useMemo(
    () => ({ threads, loading, sendMessage, subscribeToMessages, ensureGroupThread, markChatAsRead }),
    [ensureGroupThread, loading, markChatAsRead, sendMessage, subscribeToMessages, threads],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used inside ChatProvider');
  }
  return context;
};
