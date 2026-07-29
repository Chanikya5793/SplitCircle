import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/models';

const mocks = vi.hoisted(() => ({
  secure: new Map<string, string>(),
  getChunks: vi.fn(),
  announce: vi.fn(),
  decrypt: vi.fn(),
  discard: vi.fn(),
  saveLocal: vi.fn(),
  getMessages: vi.fn(),
  setProgress: vi.fn(),
  clearProgress: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock',
  setItemAsync: vi.fn(async (key: string, value: string) => {
    mocks.secure.set(key, value);
  }),
  getItemAsync: vi.fn(async (key: string) => mocks.secure.get(key) ?? null),
  deleteItemAsync: vi.fn(async (key: string) => {
    mocks.secure.delete(key);
  }),
}));
vi.mock('../../../modules/splitcircle-mesh', () => ({
  addNearbyAttachmentListener: vi.fn(() => ({ remove: vi.fn() })),
  cancelNearbyAttachment: vi.fn(),
  getReceivedNearbyChunkIndexes: mocks.getChunks,
  announceReceivedNearbyChunks: mocks.announce,
  decryptReceivedNearbyAttachment: mocks.decrypt,
  discardNearbyAttachment: mocks.discard,
}));
vi.mock('../localMessageStorage', () => ({
  deleteMessageLocally: vi.fn(),
  getChatMessages: mocks.getMessages,
  saveMessageLocally: mocks.saveLocal,
  updateMessageStatus: vi.fn(),
}));
vi.mock('../mediaService', () => ({
  getLocalMediaPath: vi.fn(() => 'file:///chat_media/chat-1/m1_photo.jpg'),
}));
vi.mock('../mediaSendProgress', () => ({
  clearSendProgress: mocks.clearProgress,
  setSendFraction: vi.fn(),
  setSendProgress: mocks.setProgress,
}));
vi.mock('../meshMessageQueue', () => ({
  loadMeshMessageQueue: vi.fn(async () => []),
  removeMeshMessage: vi.fn(),
}));

import { registerIncomingNearbyAttachment } from '../nearbyAttachmentService';

const message: ChatMessage = {
  id: 'm1',
  messageId: 'm1',
  chatId: 'chat-1',
  senderId: 'u1',
  type: 'image',
  content: 'Photo',
  status: 'sending',
  createdAt: 1,
  timestamp: 1,
  deliveredTo: ['u2'],
  readBy: [],
};

describe('nearby attachment receive commit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.secure.clear();
    mocks.getChunks.mockResolvedValue([0]);
    mocks.announce.mockResolvedValue(true);
    mocks.decrypt.mockResolvedValue('file:///chat_media/chat-1/m1_photo.jpg');
    mocks.getMessages.mockResolvedValue([message]);
  });

  it('persists the secret, verifies/decrypts complete chunks, then atomically projects the local path', async () => {
    await registerIncomingNearbyAttachment({
      message,
      ownerUserId: 'u2',
      originDeviceId: 'origin-device',
      manifest: {
        v: 1,
        transferId: 'm1',
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        fileSize: 42,
        chunkSize: 1024 * 1024,
        chunkCount: 1,
        chunkHashes: ['a'.repeat(64)],
        encryptedChunkSizes: [58],
      },
      secret: {
        transferId: 'm1',
        keyBase64: 'secret-key',
        nonceSeedBase64: 'secret-seed',
      },
    });

    expect(mocks.announce).toHaveBeenCalledWith('m1', [0], 'origin-device');
    expect(mocks.decrypt).toHaveBeenCalledWith(expect.objectContaining({
      transferId: 'm1',
      keyBase64: 'secret-key',
      nonceSeedBase64: 'secret-seed',
      chunkHashes: ['a'.repeat(64)],
    }));
    expect(mocks.saveLocal).toHaveBeenCalledWith(expect.objectContaining({
      id: 'm1',
      status: 'delivered',
      mediaDownloaded: true,
      localMediaPath: 'file:///chat_media/chat-1/m1_photo.jpg',
    }));
    expect(mocks.clearProgress).toHaveBeenCalledWith('m1');
    expect(mocks.discard).toHaveBeenCalledWith('m1');
    expect([...mocks.secure.keys()]).toEqual([]);
  });
});
