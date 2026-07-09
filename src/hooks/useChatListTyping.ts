import { useEffect, useMemo, useState } from 'react';

// Mirror the room-level typing window so the list and the open room agree on
// when a peer counts as "typing". Pings arrive every ~2.5s (see
// useTypingPresence), comfortably inside this staleness window, so a
// continuously-typing peer never flickers off between pings.
const TYPING_STALE_MS = 6_000;

// Bound the number of live RTDB listeners: only the most-recent visible chats
// get a typing subscription. Detached on unmount / when the set changes.
const MAX_SUBSCRIPTIONS = 30;

/**
 * Subscribes to `typing/{chatId}` for each of the (capped) visible chats and
 * returns a map of chatId -> typing user ids (excluding the current user and
 * stale entries). Callers resolve ids to display names against their own
 * participant data so no user profile data is duplicated here.
 */
export const useChatListTyping = (chatIds: string[], userId?: string): Record<string, string[]> => {
  const [typingMap, setTypingMap] = useState<Record<string, string[]>>({});

  // Cap + stabilize into a primitive key so the subscription effect only
  // re-runs when the actual set of watched chats changes (not on every render).
  const key = useMemo(() => chatIds.slice(0, MAX_SUBSCRIPTIONS).join(','), [chatIds]);

  useEffect(() => {
    const watched = key.length ? key.split(',') : [];
    if (watched.length === 0) {
      setTypingMap((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }

    const { getDatabase, ref, onValue } = require('firebase/database');
    const rtdb = getDatabase();
    const unsubs: Array<() => void> = [];

    for (const chatId of watched) {
      const typingRef = ref(rtdb, `typing/${chatId}`);
      const unsubscribe = onValue(
        typingRef,
        (snapshot: { val: () => Record<string, number> | null }) => {
          const data = snapshot.val();
          const now = Date.now();
          const uids = data
            ? Object.entries(data)
                .filter(([uid, ts]) => uid !== userId && now - (ts ?? 0) < TYPING_STALE_MS)
                .map(([uid]) => uid)
            : [];
          setTypingMap((prev) => {
            const prevUids = prev[chatId] ?? [];
            // Skip state churn when nothing changed for this chat.
            if (prevUids.length === uids.length && prevUids.every((u, i) => u === uids[i])) {
              return prev;
            }
            return { ...prev, [chatId]: uids };
          });
        },
        () => {
          // On subscription error, treat the chat as not-typing rather than crash.
          setTypingMap((prev) => (prev[chatId]?.length ? { ...prev, [chatId]: [] } : prev));
        },
      );
      unsubs.push(() => unsubscribe());
    }

    return () => {
      for (const u of unsubs) u();
    };
  }, [key, userId]);

  return typingMap;
};
