import { db, storage } from '@/firebase';
import type { ChatMessage, ChatParticipant, ChatThread, MessageType } from '@/models';
import {
    addDoc,
    collection,
    doc,
    limit,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    setDoc,
    updateDoc,
    where,
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { useAuth } from './AuthContext';

interface SendMessagePayload {
  chatId: string;
  content: string;
  type?: MessageType;
  mediaUri?: string;
  groupId?: string;
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
    const messagesRef = collection(db, 'chats', chatId, 'messages');
    const q = query(messagesRef, orderBy('createdAt', 'desc'), limit(100));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map((docSnap) => {
        const data = docSnap.data() as ChatMessage;
        return { ...data, createdAt: normalizeTimestamp(data.createdAt) } satisfies ChatMessage;
      });
      onData(items);
    });
    return unsubscribe;
  }, []);

  const sendMessage = useCallback(
    async ({ chatId, content, type = 'text', mediaUri, groupId }: SendMessagePayload) => {
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

      const message: ChatMessage = {
        messageId: uuid(),
        chatId,
        senderId: user.userId,
        type,
        content,
      ...(mediaUrl ? { mediaUrl } : {}),
        status: 'sent',
        createdAt: Date.now(),
        deliveredTo: [],
        readBy: [user.userId],
      };

      await addDoc(collection(db, 'chats', chatId, 'messages'), {
        ...message,
        createdAt: serverTimestamp(),
      });

      await updateDoc(doc(db, 'chats', chatId), {
        lastMessage: { ...message, createdAt: serverTimestamp() },
        groupId: groupId ?? null,
        updatedAt: Date.now(),
      });
    },
    [user],
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
