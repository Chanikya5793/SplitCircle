import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshMessageOperation } from '../meshMessageQueue';

const mocks = vi.hoisted(() => ({
  loadQueue: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  queueMessage: vi.fn(),
  queueOwn: vi.fn(),
  saveLocal: vi.fn(),
  updateStatus: vi.fn(),
  upload: vi.fn(),
  updateDoc: vi.fn(),
  discard: vi.fn(),
}));

vi.mock('@/firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(() => 'chat-doc'),
  updateDoc: mocks.updateDoc,
}));
vi.mock('../meshMessageQueue', () => ({
  loadMeshMessageQueue: mocks.loadQueue,
  removeMeshMessage: mocks.remove,
  updateMeshMessage: mocks.update,
}));
vi.mock('../messageQueueService', () => ({
  queueMessage: mocks.queueMessage,
  queueMessageToOwnDevices: mocks.queueOwn,
}));
vi.mock('../localMessageStorage', () => ({
  saveMessageLocally: mocks.saveLocal,
  updateMessageStatus: mocks.updateStatus,
}));
vi.mock('../mediaService', () => ({ uploadMedia: mocks.upload }));
vi.mock('../../../modules/splitcircle-mesh', () => ({
  discardNearbyAttachment: mocks.discard,
}));

import { flushMeshCloudRelay } from '../meshCloudRelay';

const operation = (chatType: 'direct' | 'group'): MeshMessageOperation => ({
  id: 'u1:m1',
  message: {
    id: 'm1',
    messageId: 'm1',
    chatId: 'chat-1',
    senderId: 'u1',
    type: 'image',
    content: 'Photo',
    localMediaPath: 'file:///photo.jpg',
    status: 'sending',
    createdAt: 1,
    timestamp: 1,
    deliveredTo: [],
    readBy: [],
  },
  chatType,
  ...(chatType === 'group' ? { groupId: 'g1' } : {}),
  participantIds: ['u1', 'u2', 'u3'],
  originUserId: 'u1',
  originOwned: true,
  cloudRelay: chatType === 'group',
  nearbyAttachment: {
    transferId: 'm1',
    chunkCount: 1,
    localPath: 'file:///photo.jpg',
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
  },
  createdAt: 1,
});

describe('mesh cloud relay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upload.mockResolvedValue({
      downloadUrl: 'https://storage/photo.jpg',
      localPath: 'file:///permanent/photo.jpg',
    });
  });

  it('never uploads or cloud-fans-out a direct nearby message', async () => {
    mocks.loadQueue.mockResolvedValue([operation('direct')]);
    await flushMeshCloudRelay('u1');
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.queueMessage).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('uploads group media once, persists its URL, then fans out and cleans chunks', async () => {
    mocks.loadQueue.mockResolvedValue([operation('group')]);
    await flushMeshCloudRelay('u1');

    expect(mocks.upload).toHaveBeenCalledWith(
      'file:///photo.jpg',
      'chat-1',
      'm1',
      'photo.jpg',
      'image/jpeg',
    );
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        mediaUrl: 'https://storage/photo.jpg',
        status: 'sent',
      }),
    }));
    expect(mocks.queueMessage).toHaveBeenCalledTimes(2);
    expect(mocks.queueMessage).toHaveBeenCalledWith(
      'u2',
      expect.objectContaining({ mediaUrl: 'https://storage/photo.jpg' }),
      true,
    );
    expect(mocks.queueOwn).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ mediaUrl: 'https://storage/photo.jpg' }),
      true,
    );
    expect(mocks.remove).toHaveBeenCalledWith('u1:m1');
    expect(mocks.discard).toHaveBeenCalledWith('m1');
  });
});

