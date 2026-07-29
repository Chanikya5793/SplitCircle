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
  resolveMeshThreadAudience,
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

  it('repairs a direct-chat cache whose participant arrays are temporarily asymmetric', async () => {
    const directThread: ChatThread = {
      chatId: 'chat-1',
      type: 'direct',
      participantIds: ['u1'],
      participants: [
        { userId: 'u1', displayName: 'One', status: 'offline' },
        { userId: 'u2', displayName: 'Two', status: 'offline' },
      ],
      unreadCount: 0,
    };

    expect(resolveMeshThreadAudience(directThread)).toEqual(['u1', 'u2']);
    const body = await buildMeshMessageBody({
      message,
      thread: directThread,
      originUserId: 'u1',
      originDeviceId: 'device-1',
    });
    expect(body?.audienceUserIds).toEqual(['u1', 'u2']);
    expect(body && isMeshBodyAuthorizedForThread(
      body,
      { ...directThread, participantIds: ['u2'] },
      'u2',
      body.createdAt,
    )).toBe(true);
  });

  it('refuses a malformed direct-chat cache instead of broadening its audience', () => {
    expect(resolveMeshThreadAudience({
      ...thread,
      type: 'direct',
      participantIds: ['u1', 'u2', 'u3'],
    })).toBeNull();
    expect(resolveMeshThreadAudience({
      ...thread,
      type: 'direct',
      participantIds: ['u1'],
      participants: [],
    })).toBeNull();
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

  it('signs attachment metadata but keeps its decryption key inside Signal fields', async () => {
    const manifest = {
      v: 1 as const,
      transferId: 'transfer-1',
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      fileSize: 42,
      chunkSize: 1024 * 1024,
      chunkCount: 1,
      chunkHashes: ['a'.repeat(64)],
      encryptedChunkSizes: [58],
    };
    const body = await buildMeshMessageBody({
      message: { ...message, type: 'image' },
      thread,
      originUserId: 'u1',
      originDeviceId: 'device-1',
      attachment: manifest,
      attachmentSecret: {
        transferId: 'transfer-1',
        keyBase64: 'private-key',
        nonceSeedBase64: 'private-nonce',
      },
    });

    expect(body?.attachment).toEqual(manifest);
    expect(JSON.stringify(body)).not.toContain('private-key');
    expect(vi.mocked(encryptMessageForRecipient)).toHaveBeenCalledWith(
      'u2',
      expect.objectContaining({
        nearbyAttachment: expect.objectContaining({ keyBase64: 'private-key' }),
      }),
      'device-1',
      'cache-only',
      'available-devices',
    );
  });

  it('rejects malformed or oversized attachment manifests before authorization', async () => {
    const body = await buildMeshMessageBody({
      message,
      thread,
      originUserId: 'u1',
      originDeviceId: 'device-1',
    });
    expect(body).not.toBeNull();
    if (!body) return;
    const malformed = {
      ...body,
      attachment: {
        v: 1,
        transferId: 'transfer-1',
        fileName: 'bad.bin',
        mimeType: 'application/octet-stream',
        fileSize: 101 * 1024 * 1024,
        chunkSize: 1024 * 1024,
        chunkCount: 1,
        chunkHashes: ['not-a-hash'],
        encryptedChunkSizes: [16],
      },
    };
    const raw = JSON.stringify({
      v: 1,
      bodyBase64: globalThis.btoa(unescape(encodeURIComponent(JSON.stringify(malformed)))),
      signatureBase64: 'signature',
    });
    expect(parseSignedMeshEnvelope(raw)).toBeNull();
  });

  it('rejects attachment MIME types outside the shared cloud/nearby policy', async () => {
    const body = await buildMeshMessageBody({
      message,
      thread,
      originUserId: 'u1',
      originDeviceId: 'device-1',
    });
    expect(body).not.toBeNull();
    if (!body) return;
    const unsupported = {
      ...body,
      attachment: {
        v: 1,
        transferId: 'transfer-1',
        fileName: 'page.html',
        mimeType: 'text/html',
        fileSize: 42,
        chunkSize: 1024 * 1024,
        chunkCount: 1,
        chunkHashes: ['a'.repeat(64)],
        encryptedChunkSizes: [58],
      },
    };
    const raw = JSON.stringify({
      v: 1,
      bodyBase64: globalThis.btoa(unescape(encodeURIComponent(JSON.stringify(unsupported)))),
      signatureBase64: 'signature',
    });
    expect(parseSignedMeshEnvelope(raw)).toBeNull();
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
