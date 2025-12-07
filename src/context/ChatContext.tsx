import { db } from '@/firebase';
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
    copyToLocalStorage,
    initMediaDirectory,
    uploadMedia,
} from '../services/mediaService';
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
 * Includes cycle detection to prevent stack overflow from circular references
 */
const removeUndefined = <T extends Record<string, unknown>>(obj: T, seen = new Set<object>()): Partial<T> => {
  const result: Partial<T> = {};
  // Add the current object to the seen set to detect cycles
  seen.add(obj as object);
  for (const key of Object.keys(obj) as (keyof T)[]) {
    const value = obj[key];
    if (value !== undefined) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        // If we've already seen this object, skip to avoid cycles
        if (seen.has(value as object)) {
          continue;
        }
        result[key] = removeUndefined(value as Record<string, unknown>, seen) as T[keyof T];
      } else {
        result[key] = value;
      }
    }
  }
  // Remove the current object from the seen set before returning
  seen.delete(obj as object);
  return result;
};

export const ChatProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { user } = useAuth();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [loading, setLoading] = useState(true);

  // Initialize SQLite database and media storage on mount
  useEffect(() => {
    const initDB = async () => {
      try {
        await initMessageDB();
        await initMediaDirectory();
        console.log('✅ Message and media storage initialized');
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

      const msgId = uuid();
      const now = Date.now();
      
      // 1. Prepare initial message object
      let localMediaPath = mediaUri;
      
      // If media, try to copy to local storage immediately for stable path
      if (mediaUri && type !== 'text') {
        try {
          const fileName = mediaMetadata?.fileName || `${type}_${msgId}`;
          // We don't await this long, just enough to get the path if possible
          localMediaPath = await copyToLocalStorage(mediaUri, chatId, msgId, fileName);
        } catch (e) {
          console.warn('Failed to copy media locally, using original URI', e);
        }
      }

      const message: ChatMessage = {
        id: msgId,
        messageId: msgId,
        chatId,
        senderId: user.userId,
        type,
        content,
        // Store local path for sender
        ...(localMediaPath ? { localMediaPath, mediaDownloaded: true } : {}),
        ...(mediaMetadata ? { mediaMetadata } : {}),
        ...(replyTo ? { replyTo } : {}),
        status: 'sending', // Optimistic status
        createdAt: now,
        timestamp: now,
        isFromMe: true,
        deliveredTo: [],
        readBy: [user.userId],
      };

      // 2. Save optimistic message locally
      await saveMessageLocally(message);
      
      // 3. Start background upload process (IIFE pattern for non-blocking operation)
      // Note: This IIFE runs asynchronously without blocking the caller.
      // Errors are caught and the message status is updated to 'failed' in local storage.
      // The UI will reflect the failure state through the message status.
      (async () => {
        try {
            let mediaUrl: string | undefined;
            let permanentLocalPath: string | undefined;

            if (mediaUri && type !== 'text') {
                const fileName = mediaMetadata?.fileName || `${type}_${msgId}`;
                const mimeType = mediaMetadata?.mimeType || 'application/octet-stream';
                
                console.log('📤 Uploading media to Firebase Storage...');
                
                // Upload to Firebase Storage
                // Note: uploadMedia will check if file is already at destination (which we did above)
                const uploadResult = await uploadMedia(
                  localMediaPath || mediaUri, // Use the local path if we have it
                  chatId,
                  msgId,
                  fileName,
                  mimeType,
                  (progress) => {
                    console.log(`📤 Upload progress: ${progress.toFixed(1)}%`);
                  }
                );
                
                mediaUrl = uploadResult.downloadUrl;
                permanentLocalPath = uploadResult.localPath;
                
                console.log('✅ Media uploaded successfully:', mediaUrl);
                
                // Update message with permanent path and URL
                message.mediaUrl = mediaUrl;
                message.localMediaPath = permanentLocalPath;
                message.mediaDownloaded = true;
            }
            
            message.status = 'sent';
            
            // Update local storage with success
            await saveMessageLocally(message);
            
            // Queue message for each recipient (Realtime Database)
            const thread = threads.find(t => t.chatId === chatId);
            const participants = thread?.participants || [];
            const isGroupChat = thread?.type === 'group';
            const recipientIds = participants
              .map(p => p.userId)
              .filter(id => id !== user.userId);
            
            for (const recipientId of recipientIds) {
              await queueMessage(recipientId, message, isGroupChat);
            }
            
            console.log(`✅ ${type} message sent and queued`);
            
            // Update the chat thread's lastMessage
            const threadMessage = { ...message };
            delete (threadMessage as { localMediaPath?: string }).localMediaPath;
            const cleanMessage = removeUndefined({ ...threadMessage, createdAt: serverTimestamp() });
            await updateDoc(doc(db, 'chats', chatId), {
              lastMessage: cleanMessage,
              groupId: groupId ?? null,
              updatedAt: Date.now(),
            });
            
        } catch (error) {
            console.error("Send failed", error);
            message.status = 'failed';
            await saveMessageLocally(message);
        }
      })();
    },
    [user, threads],
  );

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
