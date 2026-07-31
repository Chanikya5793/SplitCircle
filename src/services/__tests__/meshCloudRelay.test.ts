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
  participantIds: chatType === 'group' ? ['u1', 'u2', 'u3'] : ['u1', 'u2'],
  originUserId: 'u1',
  originOwned: true,
  // Every origin-owned offline operation is queued for cloud relay now,
  // regardless of chat type (doc 32 §5a).
  cloudRelay: true,
  nearbyAttachment: {
    transferId: 'm1',
    chunkCount: 1,
    localPath: 'file:///photo.jpg',
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
  },
  createdAt: 1,
});

/**
 * Minimal text operation, for ordering/retry tests that don't need media.
 * `id` is the QUEUE id (`{userId}:{messageId}`); the message id is the part
 * after the colon — these are deliberately different values so a test cannot
 * pass by confusing the two.
 */
const textOp = (
  id: string,
  chatId: string,
  over: Partial<MeshMessageOperation> = {},
): MeshMessageOperation => ({
  id,
  message: {
    id: id.split(':')[1],
    messageId: id.split(':')[1],
    chatId,
    senderId: 'u1',
    type: 'text',
    content: 'hi',
    status: 'sent',
    createdAt: 1,
    timestamp: 1,
    deliveredTo: [],
    readBy: [],
  } as MeshMessageOperation['message'],
  chatType: 'direct',
  participantIds: ['u1', 'u2'],
  originUserId: 'u1',
  originOwned: true,
  cloudRelay: true,
  createdAt: 1,
  ...over,
});

describe('mesh cloud relay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upload.mockResolvedValue({
      downloadUrl: 'https://storage/photo.jpg',
      localPath: 'file:///permanent/photo.jpg',
    });
  });

  it('relays a direct message, labelled as a direct chat (doc 32 §5a)', async () => {
    // Previously direct chats were skipped outright, which left an offline DM
    // with only the mesh route and silently dropped it at the 7-day TTL if the
    // phones never met again.
    mocks.loadQueue.mockResolvedValue([operation('direct')]);
    await flushMeshCloudRelay('u1');

    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.queueMessage).toHaveBeenCalledTimes(1);
    // isGroupChat MUST be false here — it used to be a hardcoded `true`, which
    // would mislabel a DM and change receipt/notification handling.
    expect(mocks.queueMessage).toHaveBeenCalledWith('u2', expect.anything(), false);
    expect(mocks.queueOwn).toHaveBeenCalledWith('u1', expect.anything(), false);
    expect(mocks.remove).toHaveBeenCalledWith('u1:m1');
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

  it('skips an operation that is not flagged for cloud relay', async () => {
    mocks.loadQueue.mockResolvedValue([textOp('u1:m1', 'chat-1', { cloudRelay: false })]);
    await flushMeshCloudRelay('u1');
    expect(mocks.queueMessage).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('never relays an operation this device did not originate', async () => {
    // A relay cannot impersonate the origin — this, not chat type, is the
    // guard that enforces it.
    mocks.loadQueue.mockResolvedValue([textOp('u9:m1', 'chat-1', { originOwned: false })]);
    await flushMeshCloudRelay('u1');
    expect(mocks.queueMessage).not.toHaveBeenCalled();
  });

  describe('failure isolation and retry (doc 32 §5b)', () => {
    it('one stuck conversation does not starve a different conversation', async () => {
      // THE regression this section exists for: a single global FIFO `break`
      // meant a failure on the first queued operation blocked every other
      // chat's backlog indefinitely, on this and every later flush.
      mocks.queueMessage.mockImplementation(async (recipientId: string) => {
        if (recipientId === 'blocked') throw new Error('transient');
      });
      mocks.loadQueue.mockResolvedValue([
        textOp('u1:a1', 'chat-A', { participantIds: ['u1', 'blocked'] }),
        textOp('u1:b1', 'chat-B'),
      ]);

      await flushMeshCloudRelay('u1');

      // chat-B still drained despite chat-A failing first.
      expect(mocks.remove).toHaveBeenCalledWith('u1:b1');
      expect(mocks.remove).not.toHaveBeenCalledWith('u1:a1');
    });

    it('stops at the first failure WITHIN a conversation so it cannot reorder', async () => {
      mocks.queueMessage.mockImplementation(async (_r: string, message: { id: string }) => {
        if (message.id === 'a1') throw new Error('transient');
      });
      mocks.loadQueue.mockResolvedValue([
        textOp('u1:a1', 'chat-A'),
        textOp('u1:a2', 'chat-A'),
      ]);

      await flushMeshCloudRelay('u1');

      expect(mocks.remove).not.toHaveBeenCalledWith('u1:a2');
    });

    it('records an attempt and a backoff deadline on failure', async () => {
      mocks.queueMessage.mockRejectedValue(new Error('transient'));
      mocks.loadQueue.mockResolvedValue([textOp('u1:a1', 'chat-A')]);

      await flushMeshCloudRelay('u1');

      expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
        id: 'u1:a1',
        cloudRelayAttempts: 1,
        cloudRelayNextAttemptAt: expect.any(Number),
      }));
    });

    it('does not retry while still inside the backoff window', async () => {
      mocks.loadQueue.mockResolvedValue([
        textOp('u1:a1', 'chat-A', {
          cloudRelayAttempts: 2,
          cloudRelayNextAttemptAt: Date.now() + 60_000,
        }),
      ]);

      await flushMeshCloudRelay('u1');

      expect(mocks.queueMessage).not.toHaveBeenCalled();
    });

    it('retries again once the backoff window has elapsed', async () => {
      mocks.loadQueue.mockResolvedValue([
        textOp('u1:a1', 'chat-A', {
          cloudRelayAttempts: 2,
          cloudRelayNextAttemptAt: Date.now() - 1,
        }),
      ]);

      await flushMeshCloudRelay('u1');

      expect(mocks.queueMessage).toHaveBeenCalled();
    });

    it('gives up loudly after the attempt cap instead of dying at the TTL', async () => {
      // The old code retried forever until the 7-day TTL silently discarded
      // the message and the user was never told.
      mocks.queueMessage.mockRejectedValue(new Error('permanent'));
      mocks.loadQueue.mockResolvedValue([
        textOp('u1:a1', 'chat-A', { cloudRelayAttempts: 5 }),
      ]);

      await flushMeshCloudRelay('u1');

      expect(mocks.updateStatus).toHaveBeenCalledWith('chat-A', 'a1', 'failed');
      // Retired from the relay path only; a nearby envelope stays broadcastable
      // and this operation no longer blocks the rest of the conversation.
      expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
        id: 'u1:a1',
        cloudRelay: false,
      }));
    });
  });
});
