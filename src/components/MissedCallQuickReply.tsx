import { useAuth } from '@/context/AuthContext';
import { useChat } from '@/context/ChatContext';
import {
  MISSED_CALL_REPLY_ACTION_ID,
  MESSAGE_REPLY_ACTION_ID,
  MESSAGE_MARK_READ_ACTION_ID,
  NOTIFICATION_CHANNELS,
  scheduleLocalNotification,
  type NotificationData,
} from '@/utils/notifications';
import { saveChatDraft } from '@/utils/chatDrafts';
import { isChatIdLocked } from '@/utils/lockedChatRegistry';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

// Handles notification quick-reply actions from the background — the closest
// iOS allows to a lock-screen "Message" button for third-party apps (that
// button is reserved for SMS on phone-number handles). Two push sources feed
// this bridge:
//   • missed-call pushes: pull the "Missed call" notification down, type, send
//   • message pushes: a "Reply" text field + a "Mark as read" action
// Both deliver the action WITHOUT the app coming to the foreground.
//
// Lives OUTSIDE NotificationContext on purpose: acting needs useChat(), and
// NotificationProvider mounts above ChatProvider. Mounted under ChatProvider
// in App.tsx; renders nothing.

const HANDLED_IDS_KEY = 'missedCallQuickReply.handledIds';
const MAX_HANDLED_IDS = 30;
// If the target chat thread hasn't shown up yet (Firestore subscription
// hiccup, thread pagination), park the action and keep retrying until the
// deadline instead of dropping it on the first miss.
const THREAD_WAIT_MS = 30_000;
const RETRY_INTERVAL_MS = 3_000;

type PendingAction =
  | {
      kind: 'reply';
      responseId: string;
      chatId: string;
      groupId?: string;
      text: string;
      // Absolute epoch-ms deadline for the thread to appear before giving up.
      deadline: number;
    }
  | {
      kind: 'markRead';
      responseId: string;
      chatId: string;
      deadline: number;
    };

const notifyReplyFailed = async (reply: {
  chatId: string;
  groupId?: string;
  text: string;
}): Promise<void> => {
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

const notifyLockedReply = async (reply: {
  chatId: string;
  groupId?: string;
  text: string;
}): Promise<void> => {
  // Locked chats fail closed: we NEVER send from the notification (the chat
  // sits behind a Face ID gate). Save the draft so the text isn't lost, then
  // tell the user to open + unlock the app to send it.
  await saveChatDraft(reply.chatId, reply.text);
  try {
    await scheduleLocalNotification(
      'Unlock the app to reply',
      'This chat is locked. Open ManaSplit and unlock it to send your reply.',
      {
        type: 'reply_failed',
        chatId: reply.chatId,
        groupId: reply.groupId,
        text: reply.text,
      },
      NOTIFICATION_CHANNELS.GENERAL,
    );
  } catch (error) {
    console.warn('MissedCallQuickReply: failed to notify about locked reply', error);
  }
};

const extractAction = (
  response: Notifications.NotificationResponse,
): PendingAction | null => {
  const actionId = response.actionIdentifier;
  const data = response.notification.request.content.data as
    | NotificationData
    | undefined;
  if (!data?.chatId) {
    return null;
  }
  const responseId = response.notification.request.identifier;

  // Reply text field — missed-call and message categories share the flow.
  if (
    actionId === MISSED_CALL_REPLY_ACTION_ID ||
    actionId === MESSAGE_REPLY_ACTION_ID
  ) {
    // Guard the payload type so each action only consumes its own push shape
    // (missed_call reply vs message reply).
    const expectedType =
      actionId === MISSED_CALL_REPLY_ACTION_ID ? 'missed_call' : 'message';
    if (data.type !== expectedType) {
      return null;
    }
    const userText = (response as { userText?: unknown }).userText;
    const text = typeof userText === 'string' ? userText.trim() : '';
    if (!text) {
      return null;
    }
    return {
      kind: 'reply',
      responseId,
      chatId: data.chatId,
      groupId: data.groupId,
      text,
      deadline: Date.now() + THREAD_WAIT_MS,
    };
  }

  // "Mark as read" plain action — message pushes only.
  if (actionId === MESSAGE_MARK_READ_ACTION_ID && data.type === 'message') {
    return {
      kind: 'markRead',
      responseId,
      chatId: data.chatId,
      deadline: Date.now() + THREAD_WAIT_MS,
    };
  }

  return null;
};

export const MissedCallQuickReply = () => {
  const { threads, loading, sendMessage, markChatAsRead } = useChat();
  const { user } = useAuth();
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  // Bumped by a timer to re-run the processing effect while an action is
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

    const enqueue = (action: PendingAction | null) => {
      if (!action) {
        return;
      }
      setPendingActions((current) =>
        current.some((item) => item.responseId === action.responseId)
          ? current
          : [...current, action],
      );
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        enqueue(extractAction(response));
      },
    );

    // Cold start: an action submitted while the app process was dead is only
    // recoverable via the last-response API on the next launch. The
    // AsyncStorage handled-ids ledger below prevents re-acting on it on every
    // subsequent launch.
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) {
          enqueue(extractAction(response));
        }
      })
      .catch(() => {
        // Not available on all platforms — quick reply just won't replay.
      });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!user || pendingActions.length === 0 || processingRef.current) {
      return;
    }
    // Threads come from the Firestore subscription — wait for the initial
    // load so sendMessage queues the reply to real recipients (it reads the
    // thread's participant list) instead of silently sending to nobody.
    if (loading) {
      return;
    }

    const next = pendingActions[0];
    const thread = threads.find((item) => item.chatId === next.chatId);

    processingRef.current = true;
    void (async () => {
      // When true the action stays queued and a timer re-triggers this effect.
      let park = false;
      let markedHandled = false;
      try {
        const raw = await AsyncStorage.getItem(HANDLED_IDS_KEY);
        const handled: string[] = raw ? (JSON.parse(raw) as string[]) : [];
        if (!handled.includes(next.responseId)) {
          if (!thread && Date.now() < next.deadline) {
            // Thread list loaded but doesn't contain the target chat yet
            // (subscription hiccup, pagination). Don't mark handled — park
            // the action and retry until the deadline.
            park = true;
          } else {
            // Mark handled BEFORE acting (at-most-once): a duplicated chat
            // message / read receipt is worse than a lost quick action.
            const markHandled = async () => {
              await AsyncStorage.setItem(
                HANDLED_IDS_KEY,
                JSON.stringify(
                  [...handled, next.responseId].slice(-MAX_HANDLED_IDS),
                ),
              );
              markedHandled = true;
            };

            if (next.kind === 'reply' && isChatIdLocked(next.chatId)) {
              // Fail closed: never send into a locked chat from the tray. (The
              // server also withholds the reply category from locked
              // recipients — this is client-side defense-in-depth.) Consume the
              // ledger so it can't retry.
              await markHandled();
              await notifyLockedReply(next);
            } else if (next.kind === 'reply') {
              await markHandled();
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
            } else {
              // Mark-as-read: marking read exposes no content, so it runs for
              // locked chats too.
              await markHandled();
              if (thread) {
                await markChatAsRead(next.chatId);
              } else {
                console.warn(
                  'MissedCallQuickReply: thread never appeared, giving up on mark-as-read',
                  next.chatId,
                );
              }
            }
          }
        }
      } catch (error) {
        console.warn('MissedCallQuickReply: failed to process action', error);
        if (markedHandled && next.kind === 'reply') {
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
          setPendingActions((current) =>
            current.filter((item) => item.responseId !== next.responseId),
          );
        }
        processingRef.current = false;
      }
    })();
  }, [pendingActions, threads, loading, user, sendMessage, markChatAsRead, retryTick]);

  return null;
};
