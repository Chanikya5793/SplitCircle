import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../modules/splitcircle-crypto', () => ({
  isCryptoAvailable: () => false,
  signWithIdentity: vi.fn(),
  verifyWithIdentity: vi.fn(),
}));

vi.mock('../signalCryptoService', () => ({
  getCachedPeerIdentityKey: vi.fn(),
  getPersistedSignalDeviceId: async () => 7,
}));

vi.mock('../messageEnvelope', () => ({
  encryptMessageForRecipient: vi.fn(async () => ({
    senderSignalDeviceId: 7,
    envelopes: { 'device-2': { t: 3, b: 'ciphertext' } },
  })),
  decryptMessageEnvelope: vi.fn(),
}));

import type { ChatMessage, ChatThread } from '@/models';
import { encryptMessageForRecipient } from '../messageEnvelope';
import {
  buildMeshMessageBody,
  isMeshBodyAuthorizedForThread,
  parseSignedMeshEnvelope,
  utf8ByteLength,
} from '../meshMessageProtocol';

const message: ChatMessage = {
  id: 'm1',
  messageId: 'm1',
  chatId: 'chat-1',
  senderId: 'u1',
  type: 'text',
  content: 'offline hello',
  status: 'sending',
  createdAt: 1_000,
  timestamp: 1_000,
  deliveredTo: [],
  readBy: [],
  localMediaPath: 'file:///private/sender-only.jpg',
  isFromMe: true,
};

const thread: ChatThread = {
  chatId: 'chat-1',
  groupId: 'g1',
  type: 'group',
  participantIds: ['u3', 'u1', 'u2'],
  participants: [],
  unreadCount: 0,
};

describe('nearby message protocol', () => {
  it('targets every group member and strips sender-only data and plaintext', async () => {
    const body = await buildMeshMessageBody({
      message,
      thread,
      originUserId: 'u1',
      originDeviceId: 'device-1',
    });

    expect(body?.audienceUserIds).toEqual(['u1', 'u2', 'u3']);
    expect(body?.message.localMediaPath).toBeUndefined();
    expect(body?.message.isFromMe).toBeUndefined();
    expect(body?.message.content).toBe('');
    expect(body?.encryptedForDevices['device-2']).toEqual({ t: 3, b: 'ciphertext' });
    expect(vi.mocked(encryptMessageForRecipient)).toHaveBeenCalledWith(
      'u2',
      expect.objectContaining({ content: 'offline hello' }),
      'device-1',
      'cache-only',
      'available-devices',
    );
    expect(vi.mocked(encryptMessageForRecipient)).toHaveBeenCalledWith(
      'u3',
      expect.objectContaining({ content: 'offline hello' }),
      'device-1',
      'cache-only',
      'available-devices',
    );
  });

  it('rejects a truncated audience, non-member sender, or wrong recipient', async () => {
    const body = await buildMeshMessageBody({
      message,
      thread,
      originUserId: 'u1',
      originDeviceId: 'device-1',
    });
    expect(body).not.toBeNull();
    if (!body) return;
    const now = body.createdAt;

    expect(isMeshBodyAuthorizedForThread(body, thread, 'u2', now)).toBe(true);
    expect(isMeshBodyAuthorizedForThread(
      { ...body, audienceUserIds: ['u1', 'u2'] },
      thread,
      'u2',
      now,
    )).toBe(false);
    expect(isMeshBodyAuthorizedForThread(
      { ...body, originUserId: 'intruder', message: { ...body.message, senderId: 'intruder' } },
      thread,
      'u2',
      now,
    )).toBe(false);
    expect(isMeshBodyAuthorizedForThread(body, thread, 'not-a-member', now)).toBe(false);
  });

  it('parses only the versioned signed outer envelope', async () => {
    const body = await buildMeshMessageBody({
      message,
      thread,
      originUserId: 'u1',
      originDeviceId: 'device-1',
    });
    expect(body).not.toBeNull();
    if (!body) return;
    const bodyBase64 = globalThis.btoa(unescape(encodeURIComponent(JSON.stringify(body))));

    expect(parseSignedMeshEnvelope(JSON.stringify({
      v: 1,
      bodyBase64,
      signatureBase64: 'signature',
    }))?.body.message.id).toBe('m1');
    expect(parseSignedMeshEnvelope(JSON.stringify({
      v: 2,
      bodyBase64,
      signatureBase64: 'signature',
    }))).toBeNull();
  });

  it('parses on Hermes without TextEncoder and counts UTF-8 correctly', async () => {
    const body = await buildMeshMessageBody({
      message,
      thread,
      originUserId: 'u1',
      originDeviceId: 'device-1',
    });
    expect(body).not.toBeNull();
    if (!body) return;
    const raw = JSON.stringify({
      v: 1,
      bodyBase64: globalThis.btoa(unescape(encodeURIComponent(JSON.stringify(body)))),
      signatureBase64: 'signature',
    });

    vi.stubGlobal('TextEncoder', undefined);
    expect(() => parseSignedMeshEnvelope(raw)).not.toThrow();
    expect(parseSignedMeshEnvelope(raw)?.body.message.id).toBe('m1');
    vi.unstubAllGlobals();

    expect(utf8ByteLength('plain')).toBe(5);
    expect(utf8ByteLength('₹')).toBe(3);
    expect(utf8ByteLength('📡')).toBe(4);
    expect(utf8ByteLength('\ud800')).toBe(3);
  });
});
