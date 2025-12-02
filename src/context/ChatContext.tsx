import { db, storage } from '@/firebase';
import type { ChatMessage, ChatParticipant, ChatThread, MessageType } from '@/models';
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
import { getChatMessages, initMessageDB, saveMessageLocally } from '../services/localMessageStorage';
import { listenForMessages, queueMessage } from '../services/messageQueueService';
import { useAuth } from './AuthContext';

interface SendMessagePayload {
  chatId: string;
  content: string;
  type?: MessageType;
  mediaUri?: string;
  groupId?: string;
  replyTo?: {
    messageId: string;
    senderId: string;
    senderName: string;
    content: string;
  };
}

interface ChatContextValue {
  threads: ChatThread[];
  loading: boolean;
  sendMessage: (payload: SendMessagePayload) => Promise<void>;
  subscribeToMessages: (chatId: string, onData: (messages: ChatMessage[]) => void) => () => void;
  ensureGroupThread: (groupId: string, participants: ChatParticipant[]) => Promise<string>;
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
    
    // 3. Poll local storage as a backup (in case we missed something or for other updates)
    const interval = setInterval(loadLocalMessages, 3000);

    return () => {
      clearInterval(interval);
      unsubscribeQueue();
    };
  }, [user]);

  const sendMessage = useCallback(
    async ({ chatId, content, type = 'text', mediaUri, groupId, replyTo }: SendMessagePayload) => {
      if (!user) {
        throw new Error('Missing user for chat send');
      }

      let mediaUrl: string | undefined;
      if (mediaUri) {
        const response = await fetch(mediaUri);
        const blob = await response.blob();
        const fileRef = ref(storage, `chats/${chatId}/${uuid()}`);
        await uploadBytes(fileRef, blob);
        mediaUrl = await getDownloadURL(fileRef);
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
    const participants = threads.find(t => t.chatId === chatId)?.participants || [];
    const recipientIds = participants
      .map(p => p.userId)
      .filter(id => id !== user.userId);
    
    // Queue message for each recipient
    for (const recipientId of recipientIds) {
      await queueMessage(recipientId, message);
    }
    
    console.log('✅ Message saved locally and queued (WhatsApp style)');
    
      // Update the chat thread's lastMessage (metadata only, not the full history)
      await updateDoc(doc(db, 'chats', chatId), {
        lastMessage: { ...message, createdAt: serverTimestamp() },
        groupId: groupId ?? null,
        updatedAt: Date.now(),
      });
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

  const value = useMemo(
    () => ({ threads, loading, sendMessage, subscribeToMessages, ensureGroupThread }),
    [ensureGroupThread, loading, sendMessage, subscribeToMessages, threads],
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
