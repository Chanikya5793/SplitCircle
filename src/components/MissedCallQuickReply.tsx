import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import {
  MISSED_CALL_REPLY_ACTION_ID,
  type NotificationData,
} from '@/utils/notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

// Handles the missed-call notification quick-reply action (the closest iOS
// allows to a lock-screen "Message" button for third-party call handles):
// the user pulls the "Missed call" notification down, types a message, and
// this bridge sends it into the chat with the caller — ideally without the
// app ever coming to the foreground.
//
// Lives OUTSIDE NotificationContext on purpose: sending needs useChat(), and
// NotificationProvider mounts above ChatProvider. Mounted under ChatProvider
// in App.tsx; renders nothing.

const HANDLED_IDS_KEY = 'missedCallQuickReply.handledIds';
const MAX_HANDLED_IDS = 30;

interface PendingReply {
  responseId: string;
  chatId: string;
  groupId?: string;
  text: string;
}

const extractReply = (
  response: Notifications.NotificationResponse,
): PendingReply | null => {
  if (response.actionIdentifier !== MISSED_CALL_REPLY_ACTION_ID) {
    return null;
  }
  const data = response.notification.request.content.data as
    | NotificationData
    | undefined;
  if (data?.type !== 'missed_call' || !data.chatId) {
    return null;
  }
  const userText = (response as { userText?: unknown }).userText;
  const text = typeof userText === 'string' ? userText.trim() : '';
  if (!text) {
    return null;
  }
  return {
    responseId: response.notification.request.identifier,
    chatId: data.chatId,
    groupId: data.groupId,
    text,
  };
};

export const MissedCallQuickReply = () => {
  const { threads, loading, sendMessage } = useChat();
  const { user } = useAuth();
  const [pendingReplies, setPendingReplies] = useState<PendingReply[]>([]);
  const processingRef = useRef(false);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    const enqueue = (reply: PendingReply | null) => {
      if (!reply) {
        return;
      }
      setPendingReplies((current) =>
        current.some((item) => item.responseId === reply.responseId)
          ? current
          : [...current, reply],
      );
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        enqueue(extractReply(response));
      },
    );

    // Cold start: a reply submitted while the app process was dead is only
    // recoverable via the last-response API on the next launch. The
    // AsyncStorage handled-ids ledger below prevents re-sending it on every
    // subsequent launch.
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) {
          enqueue(extractReply(response));
        }
      })
      .catch(() => {
        // Not available on all platforms — quick reply just won't replay.
      });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!user || pendingReplies.length === 0 || processingRef.current) {
      return;
    }
    // Threads come from the Firestore subscription — wait for the initial
    // load so sendMessage queues the reply to real recipients (it reads the
    // thread's participant list) instead of silently sending to nobody.
    if (loading) {
      return;
    }

    const next = pendingReplies[0];
    const thread = threads.find((item) => item.chatId === next.chatId);

    processingRef.current = true;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(HANDLED_IDS_KEY);
        const handled: string[] = raw ? (JSON.parse(raw) as string[]) : [];
        if (!handled.includes(next.responseId)) {
          // Mark handled BEFORE sending (at-most-once): a duplicated chat
          // message is worse than a lost quick reply.
          await AsyncStorage.setItem(
            HANDLED_IDS_KEY,
            JSON.stringify(
              [...handled, next.responseId].slice(-MAX_HANDLED_IDS),
            ),
          );
          if (thread) {
            await sendMessage({
              chatId: next.chatId,
              content: next.text,
              type: 'text',
              groupId: next.groupId,
            });
          } else {
            console.warn(
              'MissedCallQuickReply: no thread for chat, dropping reply',
              next.chatId,
            );
          }
        }
      } catch (error) {
        console.warn('MissedCallQuickReply: failed to send reply', error);
      } finally {
        setPendingReplies((current) =>
          current.filter((item) => item.responseId !== next.responseId),
        );
        processingRef.current = false;
      }
    })();
  }, [pendingReplies, threads, loading, user, sendMessage]);

  return null;
};
