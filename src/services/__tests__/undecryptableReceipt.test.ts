/**
 * Decrypt-failure signalling (ai_layer/docs/32 §5c, Scenario C).
 *
 * A message can arrive, prove authentic, and still be unopenable — a dead
 * Signal ratchet, or an HPKE fallback whose identity key was never seeded.
 * Before this the receiver dropped it (mesh) or rendered a placeholder
 * (online), and in BOTH cases the sender was told nothing: its status had
 * already flipped to 'sent' off a transport acknowledgement, which only ever
 * meant "bytes reached the other radio", never "the other phone could read
 * this". These tests pin the negative receipt that closes that gap.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectLogged } from '@/testing/expectLogged';

const rtdbMock = vi.hoisted(() => ({
  update: vi.fn(async () => undefined),
  ref: vi.fn((_db: unknown, path: string) => ({ path })),
  onChildAdded: vi.fn(),
  onChildChanged: vi.fn(),
}));

vi.mock('firebase/database', () => ({
  getDatabase: () => ({}),
  ref: rtdbMock.ref,
  update: rtdbMock.update,
  set: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  onChildAdded: rtdbMock.onChildAdded,
  onChildChanged: rtdbMock.onChildChanged,
  onValue: vi.fn(),
}));
vi.mock('@/services/messageEnvelope', () => ({
  encryptMessageForRecipient: vi.fn(),
  decryptMessageEnvelope: vi.fn(),
  consumeLastDecryptError: vi.fn(() => null),
}));
vi.mock('@/services/notificationService', () => ({
  getOrCreateInstallationId: vi.fn(async () => 'this-device'),
}));
vi.mock('@/services/signalCryptoService', () => ({
  // messageQueueService now reads this to stamp WHICH device failed to decrypt
  // (doc 32 §5c self-heal). Mocked because the real module pulls in native
  // crypto, which these suites neither have nor need.
  getCachedSignalDeviceId: () => 7,
}));
vi.mock('@/services/notificationPreview', () => ({
  // Pulls in native libsignal transitively; this suite must run without a
  // device (CLAUDE.md's "Cannot read properties of undefined (reading
  // 'EventEmitter')" hazard). Previews are best-effort on the send path, so a
  // stub changes nothing these tests assert.
  previewForType: (_type: string, content: string) => content,
  sealPreviewForDevice: vi.fn(async () => null),
}));
vi.mock('@/services/mediaService', () => ({ downloadMedia: vi.fn() }));

import { listenForReceipts, sendUndecryptableReceipt } from '../messageQueueService';

/** Drives the receipt listener with a raw RTDB node for one message. */
const emitReceiptNode = (
  messageId: string,
  value: Record<string, unknown>,
  isGroupChat = false,
) => {
  const seen: { messageId: string; status: string; recipientId?: string }[] = [];
  listenForReceipts(
    'chat-1',
    (id, status, recipientId) => { seen.push({ messageId: id, status, recipientId }); },
    isGroupChat,
  );
  const handler = rtdbMock.onChildAdded.mock.calls.at(-1)?.[1] as (s: unknown) => void;
  handler({ key: messageId, val: () => value });
  return seen;
};

describe('undecryptable receipts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes a negative receipt keyed by the reporting recipient', async () => {
    await sendUndecryptableReceipt('chat-1', 'm1', 'u2');

    expect(rtdbMock.ref).toHaveBeenCalledWith({}, 'receipts/chat-1/m1/u2');
    expect(rtdbMock.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ undecryptable: true, recipientId: 'u2' }),
    );
  });

  it('never rejects, so a reporting failure cannot break message processing', async () => {
    rtdbMock.update.mockRejectedValueOnce(new Error('offline'));
    // Captured AND asserted: swallowing is right (a failed receipt must not
    // break message processing) but the sender never learns their session is
    // dead if this is silent, so the log is the only trace it happened.
    await expectLogged('Error sending undecryptable receipt', () =>
      expect(sendUndecryptableReceipt('chat-1', 'm1', 'u2')).resolves.toBeUndefined());
  });

  it('surfaces an undecryptable-only receipt to the sender', () => {
    const seen = emitReceiptNode('m1', {
      u2: { recipientId: 'u2', undecryptable: true, undecryptableAt: 1 },
    });

    expect(seen).toEqual([{ messageId: 'm1', status: 'undecryptable', recipientId: 'u2' }]);
  });

  it('lets a real delivery outrank it, so one stale device cannot fail a group message', () => {
    // The weakest signal by design: if anyone actually received the message,
    // the sender must not be told it failed.
    const seen = emitReceiptNode('m1', {
      u2: { recipientId: 'u2', undecryptable: true, undecryptableAt: 1 },
      u3: { recipientId: 'u3', delivered: true, deliveredAt: 2 },
    }, true);

    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe('delivered');
  });

  it('lets a read outrank it too', () => {
    const seen = emitReceiptNode('m1', {
      u2: { recipientId: 'u2', undecryptable: true, undecryptableAt: 1 },
      u3: { recipientId: 'u3', delivered: true, deliveredAt: 2, read: true, readAt: 3 },
    }, true);

    expect(seen[0].status).toBe('read');
  });

  it('reports nothing for an empty receipt node', () => {
    expect(emitReceiptNode('m1', {})).toEqual([]);
  });
});

describe('self-sync must report a decrypt failure too', () => {
  it('writes an undecryptable receipt keyed by our own id', async () => {
    // The permanent one-way break: our own other device proves a message
    // authentic, cannot open it, and previously had no way to say so — so the
    // sending device never learned its session was dead and never rebuilt it.
    // Every later self-sync message failed identically, forever.
    await sendUndecryptableReceipt('chat-1', 'm1', 'me', 4);

    expect(rtdbMock.ref).toHaveBeenCalledWith({}, 'receipts/chat-1/m1/me');
    expect(rtdbMock.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        undecryptable: true,
        recipientId: 'me',
        // The sender needs the exact device, or it would reset healthy
        // ratchets on its other phones too.
        undecryptableDeviceId: 4,
      }),
    );
  });
});
