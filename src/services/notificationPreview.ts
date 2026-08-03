/**
 * Encrypted notification previews (ai_layer/docs/36 §3.2).
 *
 * A notification's title and body are currently the message plaintext, written
 * to Firestore and relayed through Expo, our Cloud Function and APNs/FCM in the
 * clear. This module replaces that with a blob only the recipient's device can
 * open.
 *
 * TWO DECISIONS WORTH KNOWING BEFORE CHANGING ANYTHING HERE.
 *
 * 1. THE SENDER SEALS, NOT THE SERVER. If the Cloud Function sealed these it
 *    would need the plaintext to do it, and nothing would be gained — the
 *    server would still be reading messages. The whole point is that the server
 *    forwards bytes it cannot interpret.
 *
 * 2. HPKE TO THE DEVICE IDENTITY KEY, NOT THE SIGNAL SESSION. Signal
 *    decryption ADVANCES A RATCHET, and a notification is opened by a different
 *    process than the app (an iOS Notification Service Extension) with no
 *    shared lock. Two processes advancing one ratchet corrupts it, which is
 *    precisely the "arrived but cannot be opened" failure this project has
 *    already chased at length. HPKE (RFC 9180) is stateless: opening the same
 *    blob twice, from two processes, is harmless.
 *
 * Same primitive and the same shape as doc 34's sync batches, deliberately —
 * `sealToIdentity`/`openWithIdentity` are already proven here.
 */
import {
  openWithIdentity,
  sealToIdentity,
} from '../../modules/splitcircle-crypto';

/**
 * `btoa`/`atob`, NOT `Buffer` — React Native has no Buffer without a polyfill
 * and this repo does not ship one. A Buffer version typechecks, passes every
 * unit test under Node, and then throws on device.
 *
 * Defined locally, matching `meshMessageProtocol` and `syncBatchService`
 * verbatim. A third copy is not an oversight: extracting it would mean editing
 * two working, crypto-critical files to remove four lines, and these must all
 * encode the same bytes for the same primitive. The duplication is the cheaper
 * risk.
 */
const encodeUtf8Base64 = (value: string): string =>
  globalThis.btoa(unescape(encodeURIComponent(value)));
const decodeBase64Utf8 = (value: string): string =>
  decodeURIComponent(escape(globalThis.atob(value)));

/**
 * Versioned so a future format change is detectable rather than silently
 * mis-parsed. Bumping this makes older devices fall back to generic copy, which
 * is the safe direction.
 */
export const NOTIFICATION_PREVIEW_HPKE_INFO = 'splitcircle/notification-preview/v1';

/**
 * Hard cap on the preview text.
 *
 * APNs allows a 4KB payload TOTAL, and this blob shares it with the aps
 * dictionary, the chat id and the delivery id. HPKE adds a fixed overhead
 * (encapsulated key + AEAD tag) and base64 inflates by ~33%, so the plaintext
 * budget has to be well under a naive quarter of 4KB. 140 characters is
 * comfortably inside it and is more than any notification actually displays —
 * iOS truncates the body long before this on a lock screen.
 */
export const MAX_PREVIEW_CHARS = 140;

export interface NotificationPreviewBody {
  /** Who sent it, already resolved — the extension cannot look users up. */
  senderName: string;
  /** Group name, absent for a direct chat. */
  groupName?: string;
  /** The line to display. Already truncated and already type-substituted. */
  body: string;
}

/**
 * Binds a sealed preview to the chat and the device it was sealed for.
 *
 * Without this, a blob lifted from one chat's push could be replayed into
 * another's slot and would open successfully — the recipient would see a real
 * preview attributed to the wrong conversation. The same associated-data
 * discipline as `syncBatchService`, and for the same reason.
 */
export const previewAssociatedData = (chatId: string, deviceId: string): string =>
  encodeUtf8Base64(JSON.stringify({ chatId, deviceId }));

/**
 * What the tray should show for a non-text message.
 *
 * Media never carries a plaintext preview at all, so these are constants rather
 * than anything derived from content — there is nothing to protect and nothing
 * to leak.
 */
export const previewForType = (messageType: string, content: string): string => {
  switch (messageType) {
    case 'image': return 'sent a photo';
    case 'video': return 'sent a video';
    case 'audio': return 'sent an audio message';
    case 'file': return 'shared a file';
    case 'location': return 'shared a location';
    default: {
      const trimmed = content.trim();
      if (trimmed.length === 0) return 'sent a message';
      return trimmed.length > MAX_PREVIEW_CHARS
        ? `${trimmed.slice(0, MAX_PREVIEW_CHARS - 1)}…`
        : trimmed;
    }
  }
};

/**
 * Seals one preview for one device.
 *
 * Returns null rather than throwing on ANY failure. A preview is an
 * enhancement: losing it costs a generic notification, while throwing would
 * fail the send itself — and the message matters far more than its preview.
 */
export const sealPreviewForDevice = async (
  preview: NotificationPreviewBody,
  params: { identityKey: string; chatId: string; deviceId: string },
): Promise<string | null> => {
  try {
    return await sealToIdentity(
      encodeUtf8Base64(JSON.stringify(preview)),
      params.identityKey,
      NOTIFICATION_PREVIEW_HPKE_INFO,
      previewAssociatedData(params.chatId, params.deviceId),
    );
  } catch {
    return null;
  }
};

/**
 * Opens a preview addressed to THIS device.
 *
 * Returns null on anything unexpected — a wrong chat, a tampered blob, a future
 * format. The caller shows generic copy, which is the correct failure mode: a
 * notification that says less is fine, one that says something wrong is not.
 */
export const openPreviewForThisDevice = async (
  sealed: string,
  params: { chatId: string; deviceId: string },
): Promise<NotificationPreviewBody | null> => {
  try {
    const plaintext = await openWithIdentity(
      sealed,
      NOTIFICATION_PREVIEW_HPKE_INFO,
      previewAssociatedData(params.chatId, params.deviceId),
    );
    const parsed = JSON.parse(decodeBase64Utf8(plaintext)) as unknown;
    return parseNotificationPreview(parsed);
  } catch {
    return null;
  }
};

/**
 * Validates a decoded preview.
 *
 * Exported and separate from the crypto so the shape contract can be tested
 * without a native module — and because "it decrypted" is not the same as "it
 * is well-formed". A blob that opens but carries a number where a string
 * belongs would otherwise reach the notification API and throw inside a
 * headless handler, where nothing would report it.
 */
export const parseNotificationPreview = (raw: unknown): NotificationPreviewBody | null => {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const senderName = typeof value.senderName === 'string' ? value.senderName.trim() : '';
  const body = typeof value.body === 'string' ? value.body.trim() : '';
  if (senderName.length === 0 || body.length === 0) return null;

  const groupName = typeof value.groupName === 'string' ? value.groupName.trim() : '';
  return {
    senderName,
    body,
    ...(groupName.length > 0 ? { groupName } : {}),
  };
};

/**
 * Turns an opened preview into what the tray shows.
 *
 * Mirrors the server's existing copy exactly — group name as title with the
 * sender as subtitle, sender as title for a direct chat — so switching to
 * encrypted previews changes nothing a user can see except that it now works
 * without anyone in the middle reading it.
 */
export const previewToNotificationCopy = (
  preview: NotificationPreviewBody,
): { title: string; subtitle?: string; body: string } => (
  preview.groupName
    ? { title: preview.groupName, subtitle: preview.senderName, body: preview.body }
    : { title: preview.senderName, body: preview.body }
);
