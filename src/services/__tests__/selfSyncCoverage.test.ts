/**
 * Self-sync (doc 31 §3.3) delivery coverage — regression guard for the
 * "my own messages never reach my other devices" outage (ai_layer/docs/32 §10).
 *
 * `queueMessageToOwnDevices` mirrors a just-sent message to the sender's OWN
 * other devices. It used to call `encryptMessageForRecipient` with the DEFAULT
 * coverage policy (`'all-devices'`), which THROWS `EncryptionRequiredError`
 * when even one device cannot be encrypted for — and its own catch swallows
 * that. So a single sibling device with an unestablishable Signal session
 * (`ensureSessionWithDevice` returns false silently on any prekey-claim
 * failure) stopped the mirror reaching EVERY other device, healthy ones
 * included, with no user-visible signal at all.
 *
 * Strict coverage is correct for a REAL recipient — it exists to stop a
 * downgrade-to-plaintext attack. Self-sync never falls back to plaintext, so
 * there is no downgrade to defend against and reaching the reachable devices
 * strictly beats reaching none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const envelope = vi.hoisted(() => ({
  encryptMessageForRecipient: vi.fn(),
  decryptMessageEnvelope: vi.fn(),
  consumeLastDecryptError: vi.fn(() => null),
}));

const rtdbMock = vi.hoisted(() => ({
  set: vi.fn(async () => undefined),
  ref: vi.fn((_db: unknown, path: string) => ({ path })),
}));

vi.mock('firebase/database', () => ({
  getDatabase: () => ({}),
  ref: rtdbMock.ref,
  set: rtdbMock.set,
  get: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  onChildAdded: vi.fn(),
  onChildChanged: vi.fn(),
  onValue: vi.fn(),
}));

vi.mock('@/services/messageEnvelope', () => ({
  encryptMessageForRecipient: envelope.encryptMessageForRecipient,
  decryptMessageEnvelope: envelope.decryptMessageEnvelope,
  consumeLastDecryptError: envelope.consumeLastDecryptError,
}));

vi.mock('@/services/notificationService', () => ({
  getOrCreateInstallationId: vi.fn(async () => 'this-device'),
}));

vi.mock('@/services/mediaService', () => ({ downloadMedia: vi.fn() }));

import { queueMessageToOwnDevices } from '../messageQueueService';
import type { ChatMessage } from '@/models';

const message = {
  id: 'msg-1',
  messageId: 'msg-1',
  requestId: 'req-1',
  chatId: 'chat-1',
  senderId: 'me',
  content: 'hello from my phone',
  type: 'text',
  timestamp: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  status: 'sent',
} as unknown as ChatMessage;

describe('self-sync device coverage', () => {
  beforeEach(() => {
    envelope.encryptMessageForRecipient.mockReset();
    rtdbMock.set.mockClear();
    rtdbMock.ref.mockClear();
  });

  it('asks for best-effort coverage, never all-or-nothing, when mirroring to our own devices', async () => {
    envelope.encryptMessageForRecipient.mockResolvedValue({
      envelopes: { 'sibling-a': { t: 3, b: 'ct' } },
      senderSignalDeviceId: 2,
    });

    await queueMessageToOwnDevices('me', message, false);

    // Positional: (recipientId, fields, excludeDeviceId, networkPolicy, coveragePolicy)
    const call = envelope.encryptMessageForRecipient.mock.calls[0];
    expect(call[2]).toBe('this-device');   // never encrypt to ourselves
    expect(call[4]).toBe('available-devices');
  });

  it('still mirrors to the reachable device when a sibling cannot be encrypted for', async () => {
    // Two siblings exist; only one produced an envelope. Under the old
    // 'all-devices' policy this call threw and nothing was written at all.
    envelope.encryptMessageForRecipient.mockResolvedValue({
      envelopes: { 'healthy-sibling': { t: 3, b: 'ct' } },
      senderSignalDeviceId: 2,
    });

    await queueMessageToOwnDevices('me', message, false);

    expect(rtdbMock.set).toHaveBeenCalledTimes(1);
    const [, payload] = rtdbMock.set.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(payload.originDeviceId).toBe('this-device');
    expect(Object.keys(payload.envelopes as object)).toEqual(['healthy-sibling']);
    // Content must travel encrypted-only: the plaintext is blanked and lives
    // solely in the per-device envelopes.
    expect(payload.content).toBe('');
    expect(payload.encrypted).toBe(true);
  });

  it('writes nothing when this is genuinely the only device', async () => {
    // Zero other devices is not a failure — encryptMessageForRecipient
    // returns null and there is simply nobody to mirror to.
    envelope.encryptMessageForRecipient.mockResolvedValue(null);

    await queueMessageToOwnDevices('me', message, false);

    expect(rtdbMock.set).not.toHaveBeenCalled();
  });

  it('never lets a self-sync failure escape into the send path', async () => {
    // The send already succeeded to its real recipients; a mirror failure must
    // not turn that into a failed message.
    envelope.encryptMessageForRecipient.mockRejectedValue(new Error('boom'));

    await expect(queueMessageToOwnDevices('me', message, false)).resolves.toBeUndefined();
    expect(rtdbMock.set).not.toHaveBeenCalled();
  });
});
