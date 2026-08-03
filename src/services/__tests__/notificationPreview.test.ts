/**
 * The encrypted-notification-preview format (doc 36 §3.2).
 *
 * Covers everything that does NOT need a device: the copy rules, the size
 * discipline that keeps a sealed blob inside APNs' 4KB payload, the
 * associated-data binding, and the validation of a decoded body.
 *
 * The seal/open round trip needs native libsignal and belongs to device
 * verification. What is testable here is the part most likely to be got wrong
 * silently: a preview that is too long fails at the APNs boundary as a dropped
 * notification, with no error anywhere in our own stack.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../modules/splitcircle-crypto', () => ({
  sealToIdentity: vi.fn(async () => 'sealed'),
  openWithIdentity: vi.fn(async () => ''),
}));

import {
  MAX_PREVIEW_CHARS,
  parseNotificationPreview,
  previewAssociatedData,
  previewForType,
  previewToNotificationCopy,
} from '../notificationPreview';

describe('previewForType', () => {
  it('never derives text from a media message', () => {
    // Media carries no plaintext preview at all, so there is nothing to leak
    // and nothing to protect — these must be constants, not content.
    for (const [type, expected] of [
      ['image', 'sent a photo'],
      ['video', 'sent a video'],
      ['audio', 'sent an audio message'],
      ['file', 'shared a file'],
      ['location', 'shared a location'],
    ] as const) {
      expect(previewForType(type, 'SECRET CAPTION')).toBe(expected);
      expect(previewForType(type, 'SECRET CAPTION')).not.toContain('SECRET');
    }
  });

  it('uses the text of a text message', () => {
    expect(previewForType('text', 'see you at 6')).toBe('see you at 6');
  });

  it('falls back for an empty text message rather than showing a blank body', () => {
    // An empty notification body renders as a blank row in the tray.
    expect(previewForType('text', '   ')).toBe('sent a message');
  });

  it('TRUNCATES to the payload budget, with an ellipsis', () => {
    // The cap is not cosmetic: HPKE overhead plus base64 inflation on an
    // unbounded message would exceed APNs' 4KB and the push is DROPPED — no
    // notification at all, and no error on our side.
    const long = 'x'.repeat(500);
    const preview = previewForType('text', long);
    expect(preview.length).toBe(MAX_PREVIEW_CHARS);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('leaves a message exactly at the cap alone', () => {
    const exact = 'y'.repeat(MAX_PREVIEW_CHARS);
    expect(previewForType('text', exact)).toBe(exact);
  });

  it('trims surrounding whitespace so it does not eat the budget', () => {
    expect(previewForType('text', '   hi   ')).toBe('hi');
  });
});

describe('previewAssociatedData', () => {
  it('binds a preview to BOTH the chat and the device', () => {
    // Without this, a blob lifted from one chat's push replays into another's
    // slot and opens successfully — a real preview under the wrong
    // conversation.
    const a = previewAssociatedData('chat-1', 'device-1');
    expect(a).not.toBe(previewAssociatedData('chat-2', 'device-1'));
    expect(a).not.toBe(previewAssociatedData('chat-1', 'device-2'));
  });

  it('is stable for the same pair, or nothing would ever open', () => {
    expect(previewAssociatedData('c', 'd')).toBe(previewAssociatedData('c', 'd'));
  });
});

describe('parseNotificationPreview', () => {
  it('accepts a well-formed direct-chat preview', () => {
    expect(parseNotificationPreview({ senderName: 'Rose', body: 'hi' }))
      .toEqual({ senderName: 'Rose', body: 'hi' });
  });

  it('keeps a group name when present', () => {
    expect(parseNotificationPreview({ senderName: 'Rose', body: 'hi', groupName: 'Trip' }))
      .toEqual({ senderName: 'Rose', body: 'hi', groupName: 'Trip' });
  });

  it('rejects anything missing a name or body', () => {
    // "It decrypted" is not "it is well-formed". A malformed body reaching the
    // notification API throws inside a HEADLESS handler, where nothing reports
    // it — so it has to be rejected here, in favour of generic copy.
    for (const bad of [
      null, undefined, 'string', 42, [],
      {}, { senderName: 'Rose' }, { body: 'hi' },
      { senderName: '', body: 'hi' }, { senderName: 'Rose', body: '  ' },
      { senderName: 7, body: 'hi' }, { senderName: 'Rose', body: 7 },
    ]) {
      expect(parseNotificationPreview(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('drops an empty group name rather than rendering a blank title', () => {
    const parsed = parseNotificationPreview({ senderName: 'Rose', body: 'hi', groupName: '  ' });
    expect(parsed).not.toBeNull();
    expect('groupName' in (parsed as object)).toBe(false);
  });
});

describe('previewToNotificationCopy', () => {
  it('matches the server copy for a direct chat', () => {
    expect(previewToNotificationCopy({ senderName: 'Rose', body: 'hi' }))
      .toEqual({ title: 'Rose', body: 'hi' });
  });

  it('matches the server copy for a group', () => {
    // Group name as title, sender as subtitle — identical to what
    // buildMessageNotificationCopy already produces, so encrypting the preview
    // changes nothing a user can see.
    expect(previewToNotificationCopy({ senderName: 'Rose', body: 'hi', groupName: 'Trip' }))
      .toEqual({ title: 'Trip', subtitle: 'Rose', body: 'hi' });
  });
});
