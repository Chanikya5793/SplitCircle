/**
 * Deciding whether a push carries a preview worth opening (doc 36 §3.2).
 *
 * The server sends message pushes with GENERIC copy plus an opaque blob. This
 * is the device-side gate that decides whether to replace what was shown.
 *
 * The property that matters is the failure direction: EVERY reason to give up
 * must leave the server's generic notification alone. Replacing it with
 * something wrong, or dismissing it and failing to present a replacement, is
 * far worse than a notification that says less — the second one loses the
 * message entirely.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../modules/splitcircle-crypto', () => ({
  sealToIdentity: vi.fn(async () => 'sealed'),
  openWithIdentity: vi.fn(async () => ''),
}));
vi.mock('@/services/notificationService', () => ({
  getOrCreateInstallationId: vi.fn(async () => 'device-1'),
}));
// expo-notifications pulls in the Expo runtime, which this pure-node suite has
// no business loading — the functions under test here never touch it.
vi.mock('expo-notifications', () => ({
  dismissNotificationAsync: vi.fn(async () => undefined),
  scheduleNotificationAsync: vi.fn(async () => 'id'),
}));

import {
  claimMessageNotification,
  parseMessagePushData,
} from '../notificationPreviewDisplay';

describe('parseMessagePushData', () => {
  const valid = { type: 'message', chatId: 'chat-1', messageId: 'm1', preview: 'blob' };

  it('accepts a message push carrying a preview', () => {
    expect(parseMessagePushData(valid)).toEqual({
      chatId: 'chat-1',
      messageId: 'm1',
      preview: 'blob',
    });
  });

  it('ignores a push with no preview, which is an ordinary case', () => {
    // An older sender, or a device the sender had no cached identity key for.
    // Not an error — the generic copy is correct there.
    expect(parseMessagePushData({ ...valid, preview: undefined })).toBeNull();
    expect(parseMessagePushData({ ...valid, preview: '' })).toBeNull();
  });

  it('ignores non-message pushes', () => {
    // Revoke and expense pushes share this handler and must pass straight
    // through untouched.
    expect(parseMessagePushData({ ...valid, type: 'revoke' })).toBeNull();
    expect(parseMessagePushData({ ...valid, type: 'expense' })).toBeNull();
    expect(parseMessagePushData({ ...valid, type: undefined })).toBeNull();
  });

  it('requires a chatId, since the preview is bound to it', () => {
    // Associated data is {chatId, deviceId}; without the chat id the blob can
    // never open, so there is no point dismissing anything.
    expect(parseMessagePushData({ ...valid, chatId: '' })).toBeNull();
  });

  it('survives a malformed payload without throwing', () => {
    // This runs in a HEADLESS launch, where a throw is invisible and may kill
    // the task before the revoke handling that shares it.
    for (const bad of [null, undefined, 'string', 42, [], {}]) {
      expect(() => parseMessagePushData(bad)).not.toThrow();
      expect(parseMessagePushData(bad)).toBeNull();
    }
  });

  it('tolerates non-string fields rather than trusting the payload', () => {
    expect(parseMessagePushData({ type: 'message', chatId: 7, preview: 'b' })).toBeNull();
    expect(parseMessagePushData({ type: 'message', chatId: 'c', preview: 7 })).toBeNull();
  });

  it('defaults a missing messageId rather than rejecting', () => {
    // messageId is only used for logging; the preview is still openable.
    const parsed = parseMessagePushData({ type: 'message', chatId: 'c', preview: 'b' });
    expect(parsed?.messageId).toBe('');
    expect(parsed?.preview).toBe('b');
  });
});

describe('message notification de-duplication', () => {
  it('claims each message id only once', () => {
    expect(claimMessageNotification('dedupe-test-1')).toBe(true);
    expect(claimMessageNotification('dedupe-test-1')).toBe(false);
    expect(claimMessageNotification('dedupe-test-2')).toBe(true);
  });
});
