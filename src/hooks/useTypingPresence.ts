import { useCallback, useEffect, useRef, useState } from 'react';

const TYPING_STALE_MS = 6_000;
const TYPING_PING_THROTTLE_MS = 2_500;

interface UseTypingPresenceOptions {
  chatId: string;
  userId?: string;
  participantMap: Map<string, string>;
  setTyping: (chatId: string, isTyping: boolean) => Promise<void>;
}

export const useTypingPresence = ({ chatId, userId, participantMap, setTyping }: UseTypingPresenceOptions) => {
  const lastTypingPingRef = useRef(0);
  const typingClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [typingNames, setTypingNames] = useState<string[]>([]);

  const maybePingTyping = useCallback(async () => {
    const now = Date.now();
    if (now - lastTypingPingRef.current < TYPING_PING_THROTTLE_MS) return;
    lastTypingPingRef.current = now;
    try {
      await setTyping(chatId, true);
    } catch {
      // Best-effort
    }
    if (typingClearTimerRef.current) clearTimeout(typingClearTimerRef.current);
    typingClearTimerRef.current = setTimeout(() => {
      void setTyping(chatId, false);
      lastTypingPingRef.current = 0;
    }, TYPING_STALE_MS);
  }, [setTyping, chatId]);

  // Subscribe to RTDB typing state
  useEffect(() => {
    const { getDatabase, ref, onValue } = require('firebase/database');
    const rtdb = getDatabase();
    const typingRef = ref(rtdb, `typing/${chatId}`);
    const unsubscribe = onValue(typingRef, (snapshot: { val: () => Record<string, number> | null }) => {
      const data = snapshot.val();
      if (!data) { setTypingNames([]); return; }
      const now = Date.now();
      const names = Object.entries(data)
        .filter(([uid, ts]) => uid !== userId && now - (ts ?? 0) < TYPING_STALE_MS)
        .map(([uid]) => participantMap.get(uid) ?? 'Someone');
      setTypingNames(names);
    }, () => { setTypingNames([]); });
    return () => unsubscribe();
  }, [chatId, userId, participantMap]);

  // onDisconnect cleanup + unmount cleanup
  useEffect(() => {
    const { getDatabase, ref, onDisconnect } = require('firebase/database');
    const rtdb = getDatabase();
    if (userId) {
      const typingRef = ref(rtdb, `typing/${chatId}/${userId}`);
      onDisconnect(typingRef).remove();
    }
    return () => {
      if (typingClearTimerRef.current) clearTimeout(typingClearTimerRef.current);
      void setTyping(chatId, false);
    };
  }, [setTyping, chatId, userId]);

  return { maybePingTyping, typingNames };
};
