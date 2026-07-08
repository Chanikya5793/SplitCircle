import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import {
  MISSED_CALL_REPLY_ACTION_ID,
  NOTIFICATION_CHANNELS,
  scheduleLocalNotification,
  type NotificationData,
} from '@/utils/notifications';
import { saveChatDraft } from '@/utils/chatDrafts';
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
// If the target chat thread hasn't shown up yet (Firestore subscription
// hiccup, thread pagination), park the reply and keep retrying until the
// deadline instead of dropping it on the first miss.
const THREAD_WAIT_MS = 30_000;
const RETRY_INTERVAL_MS = 3_000;

interface PendingReply {
  responseId: string;
  chatId: string;
  groupId?: string;
  text: string;
  // Absolute epoch-ms deadline for the thread to appear before giving up.
  deadline: number;
}

const notifyReplyFailed = async (reply: PendingReply): Promise<void> => {
  // Persist the text as a per-chat draft FIRST: the notification below is
  // dismissable (and notifications may be disabled entirely), but the draft
  // survives — opening the chat any time later shows the text waiting in the
  // composer. saveChatDraft never throws.
  await saveChatDraft(reply.chatId, reply.text);
  try {
    const { text } = reply;
    const preview = text.length > 60 ? `${text.slice(0, 57)}…` : text;
    // Carry the chat + original text so tapping the notice reopens the chat
    // with the composer prefilled (handled by NotificationNavigator).
    await scheduleLocalNotification(
      "Couldn't send your reply",
      `Your message "${preview}" wasn't sent. Tap to try again.`,
      {
        type: 'reply_failed',
        chatId: reply.chatId,
        groupId: reply.groupId,
        text,
      },
      NOTIFICATION_CHANNELS.GENERAL,
    );
  } catch (error) {
    console.warn('MissedCallQuickReply: failed to notify about lost reply', error);
  }
};

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
    deadline: Date.now() + THREAD_WAIT_MS,
  };
};

export const MissedCallQuickReply = () => {
  const { threads, loading, sendMessage } = useChat();
  const { user } = useAuth();
  const [pendingReplies, setPendingReplies] = useState<PendingReply[]>([]);
  // Bumped by a timer to re-run the processing effect while a reply is
  // parked waiting for its thread to appear.
  const [retryTick, setRetryTick] = useState(0);
  const processingRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

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
      // When true the reply stays queued and a timer re-triggers this effect.
      let park = false;
      let markedHandled = false;
      try {
        const raw = await AsyncStorage.getItem(HANDLED_IDS_KEY);
        const handled: string[] = raw ? (JSON.parse(raw) as string[]) : [];
        if (!handled.includes(next.responseId)) {
          if (!thread && Date.now() < next.deadline) {
            // Thread list loaded but doesn't contain the target chat yet
            // (subscription hiccup, pagination). Don't mark handled — park
            // the reply and retry until the deadline.
            park = true;
          } else {
            // Mark handled BEFORE sending (at-most-once): a duplicated chat
            // message is worse than a lost quick reply.
            await AsyncStorage.setItem(
              HANDLED_IDS_KEY,
              JSON.stringify(
                [...handled, next.responseId].slice(-MAX_HANDLED_IDS),
              ),
            );
            markedHandled = true;
            if (thread) {
              await sendMessage({
                chatId: next.chatId,
                content: next.text,
                type: 'text',
                groupId: next.groupId,
              });
            } else {
              console.warn(
                'MissedCallQuickReply: thread never appeared, giving up on reply',
                next.chatId,
              );
              await notifyReplyFailed(next);
            }
          }
        }
      } catch (error) {
        console.warn('MissedCallQuickReply: failed to send reply', error);
        if (markedHandled) {
          // The reply was consumed (at-most-once) but never reached the
          // chat — tell the user instead of failing silently.
          await notifyReplyFailed(next);
        }
      } finally {
        if (park) {
          if (retryTimerRef.current !== null) {
            clearTimeout(retryTimerRef.current);
          }
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            setRetryTick((tick) => tick + 1);
          }, RETRY_INTERVAL_MS);
        } else {
          setPendingReplies((current) =>
            current.filter((item) => item.responseId !== next.responseId),
          );
        }
        processingRef.current = false;
      }
    })();
  }, [pendingReplies, threads, loading, user, sendMessage, retryTick]);

  return null;
};
