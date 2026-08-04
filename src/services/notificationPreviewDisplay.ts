/**
 * Turns a sealed notification preview into what the user actually sees
 * (ai_layer/docs/36 §3.2).
 *
 * The server now sends message pushes with GENERIC visible copy ("ManaSplit /
 * New message") plus an opaque `data.preview` blob. It cannot do better,
 * because it cannot read the message — which is the whole point.
 *
 * This module is the device half: open the blob, and replace the generic
 * notification with the real one. On Android that means dismissing the
 * delivered notification and presenting a local one in its place, which works
 * because the app is woken for every message push. On iOS the same job belongs
 * to a Notification Service Extension, which rewrites the body BEFORE display
 * and so has no flicker — that target does not exist yet (doc 36 §4).
 *
 * EVERY FAILURE PATH KEEPS THE GENERIC NOTIFICATION. A preview that cannot be
 * opened, is malformed, or belongs to another device leaves what the server
 * sent untouched. Showing less is fine; showing something wrong, or nothing at
 * all, is not.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { getOrCreateInstallationId } from '@/services/notificationService';
import {
  openPreviewForThisDevice,
  previewToNotificationCopy,
} from '@/services/notificationPreview';

/** Shape of the data payload `sendMessagePushes` puts on a message push. */
interface MessagePushData {
  type?: unknown;
  chatId?: unknown;
  messageId?: unknown;
  preview?: unknown;
}

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : '';

// Push transport is at-least-once. Claim synchronously, before decryption, so
// concurrent FCM/Expo callbacks cannot each post the same local alert.
const recentlyClaimedMessageIds = new Map<string, number>();
const MESSAGE_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_MESSAGE_IDS = 512;

/** Returns true only for the first delivery of a message during the window. */
export const claimMessageNotification = (messageId: string): boolean => {
  if (!messageId) return true; // Legacy payloads cannot be reliably deduped.

  const now = Date.now();
  for (const [id, claimedAt] of recentlyClaimedMessageIds) {
    if (now - claimedAt > MESSAGE_DEDUPE_WINDOW_MS) {
      recentlyClaimedMessageIds.delete(id);
    }
  }
  if (recentlyClaimedMessageIds.has(messageId)) return false;

  recentlyClaimedMessageIds.set(messageId, now);
  while (recentlyClaimedMessageIds.size > MAX_TRACKED_MESSAGE_IDS) {
    const oldest = recentlyClaimedMessageIds.keys().next().value;
    if (!oldest) break;
    recentlyClaimedMessageIds.delete(oldest);
  }
  return true;
};

/**
 * Reads the fields this module needs, or null when the payload is not a
 * message push carrying a preview.
 *
 * Exported for tests: this is pure, while everything below touches the
 * notifications API.
 */
export const parseMessagePushData = (
  raw: unknown,
): { chatId: string; messageId: string; preview: string } | null => {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as MessagePushData;
  if (asString(data.type) !== 'message') return null;

  const chatId = asString(data.chatId);
  const preview = asString(data.preview);
  // No preview is the ordinary case for an old sender, or a device the sender
  // had no cached identity key for. Not an error — the generic copy stands.
  if (!chatId || !preview) return null;

  return { chatId, messageId: asString(data.messageId), preview };
};

/**
 * Opens the preview for this device and returns the copy to display.
 *
 * Split from the presentation below so the decision — including every reason
 * to give up — is testable without mounting the notifications API.
 */
export const resolvePreviewCopy = async (
  raw: unknown,
): Promise<{ title: string; subtitle?: string; body: string } | null> => {
  const parsed = parseMessagePushData(raw);
  if (!parsed) return null;

  try {
    const deviceId = await getOrCreateInstallationId();
    if (!deviceId) return null;

    const preview = await openPreviewForThisDevice(parsed.preview, {
      chatId: parsed.chatId,
      deviceId,
    });
    if (!preview) return null;

    return previewToNotificationCopy(preview);
  } catch (error) {
    // console.error, not warn: a Release bundle drops warn (CLAUDE.md), and a
    // silently preview-less app is precisely the degradation nobody reports.
    console.error('⚠️ Could not open notification preview', error);
    return null;
  }
};

/**
 * Replaces a delivered generic notification with its decrypted contents.
 *
 * ANDROID ONLY, deliberately. iOS presents the notification before the app
 * gets a chance to run, so dismissing and re-presenting there would flash the
 * generic copy and then show a second banner — worse than leaving it alone.
 * iOS gets this properly via the Notification Service Extension in doc 36 §4.
 *
 * Returns whether it replaced anything, so callers can log coverage.
 */
export const applyDecryptedPreview = async (
  raw: unknown,
  presentedIdentifier?: string,
): Promise<boolean> => {
  if (Platform.OS !== 'android') return false;

  // The foreground listener receives every notification category. Only message
  // pushes use the data-only/decrypt-and-present path; never turn an expense,
  // call, or revoke into a bogus "New message" local notification.
  if (!raw || typeof raw !== 'object' || (raw as MessagePushData).type !== 'message') {
    return false;
  }

  // Return handled for a duplicate so the background fallback cannot turn it
  // into a second generic local notification.
  if (!claimMessageNotification(asString((raw as MessagePushData).messageId))) {
    return true;
  }

  const copy = await resolvePreviewCopy(raw);
  // A visible remote notification already supplied the privacy-safe fallback.
  // Do not schedule a second local "New message" when preview opening fails:
  // Android retains every scheduled notification and eventually suppresses an
  // app that has accumulated too many. A local notification is only useful
  // when we actually improved the copy.
  if (!copy) return false;
  const notificationCopy = copy;

  try {
    // Dismiss FIRST: presenting before dismissing leaves both on screen for a
    // moment, and on a lock screen that is two rows for one message.
    if (presentedIdentifier) {
      await Notifications.dismissNotificationAsync(presentedIdentifier);
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: notificationCopy.title,
        ...(notificationCopy.subtitle ? { subtitle: notificationCopy.subtitle } : {}),
        body: notificationCopy.body,
        // The original data, so tapping still deep-links into the chat.
        data: (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>,
      },
      // Immediately, using the channel that carries the message alert policy.
      trigger: { channelId: 'messages' },
    });
    return true;
  } catch (error) {
    console.error('⚠️ Could not replace notification with decrypted preview', error);
    return false;
  }
};
