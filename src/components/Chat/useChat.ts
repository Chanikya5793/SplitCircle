import {
    getItem,
    pushToArray,
    setItem,
    updateInArray,
} from '@/utils/storage';
import NetInfo from '@react-native-community/netinfo';
import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';

export type Message = {
  id: string;
  text: string;
  sender: string; // user id
  timestamp: number;
  status: 'pending' | 'sent' | 'delivered' | 'read';
};

type UseChatReturn = {
  messages: Message[];
  sendMessage: (text: string) => Promise<void>;
  loading: boolean;
};

export function useChat(conversationId: string, currentUserId: string): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const storageKey = `chat_${conversationId}`;
  const pendingKey = `chat_pending_${conversationId}`;

  // Load stored messages on mount
  useEffect(() => {
    (async () => {
      setLoading(true);
      const stored = await getItem<Message[]>(storageKey);
      if (stored) setMessages(stored);
      setLoading(false);
    })();
  }, [conversationId]);

  // Helper to persist messages array
  const persistMessages = async (msgs: Message[]) => {
    await setItem(storageKey, msgs);
    setMessages(msgs);
  };

  // Send a message (handles online/offline)
  const sendMessage = useCallback(
    async (text: string) => {
      const newMsg: Message = {
        id: `${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        text,
        sender: currentUserId,
        timestamp: Date.now(),
        status: 'pending',
      };

      // Optimistically add to UI
      const updated = [...messages, newMsg];
      await persistMessages(updated);

      const isConnected = await NetInfo.fetch().then((s) => s.isConnected);
      if (!isConnected) {
        // Queue for later
        await pushToArray(pendingKey, newMsg);
        return;
      }

      try {
        // Replace with your actual server endpoint
        await axios.post('https://your-api.com/chat/send', {
          conversationId,
          message: newMsg,
        });
        // Mark as sent
        await updateInArray<Message>(storageKey, newMsg.id, (m) => ({
          ...m,
          status: 'sent',
        }));
        // Refresh UI
        const refreshed = await getItem<Message[]>(storageKey);
        if (refreshed) setMessages(refreshed);
      } catch (e) {
        // On failure, keep pending and push to queue
        await pushToArray(pendingKey, newMsg);
      }
    },
    [messages, conversationId, currentUserId]
  );

  // Sync pending messages when connectivity changes
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(async (state) => {
      if (state.isConnected) {
        const pending = await getItem<Message[]>(pendingKey);
        if (!pending?.length) return;

        for (const msg of pending) {
          try {
            await axios.post('https://your-api.com/chat/send', {
              conversationId,
              message: msg,
            });
            // Update stored message status
            await updateInArray<Message>(storageKey, msg.id, (m) => ({
              ...m,
              status: 'sent',
            }));
          } catch {
            // keep it pending
          }
        }
        // Clear pending queue
        await setItem(pendingKey, []);
        const refreshed = await getItem<Message[]>(storageKey);
        if (refreshed) setMessages(refreshed);
      }
    });
    return () => unsubscribe();
  }, [conversationId]);

  // Poll for incoming messages (simple interval)
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        // Replace with your actual server endpoint
        const resp = await axios.get('https://your-api.com/chat/receive', {
          params: { conversationId },
        });
        const incoming: Message[] = resp.data.messages;
        if (incoming?.length) {
          // Merge new messages, avoid duplicates
          const existingIds = new Set(messages.map((m) => m.id));
          const newMsgs = incoming.filter((m) => !existingIds.has(m.id));
          if (newMsgs.length) {
            const merged = [...messages, ...newMsgs];
            await persistMessages(merged);
          }
        }
      } catch {
        // ignore fetch errors
      }
    }, 8000); // every 8 seconds
    return () => clearInterval(interval);
  }, [messages, conversationId]);

  return { messages, sendMessage, loading };
}
