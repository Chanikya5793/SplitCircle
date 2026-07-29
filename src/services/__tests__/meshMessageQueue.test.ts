import { beforeEach, describe, expect, it } from 'vitest';

import { __clearAsyncStorageStore } from './mocks/async-storage';
import type { MeshMessageOperation } from '../meshMessageQueue';
import {
  claimMeshMessageProcessing,
  clearMeshMessageQueue,
  enqueueMeshMessage,
  loadMeshMessageQueue,
  releaseMeshMessageProcessing,
  removeMeshMessage,
  updateMeshMessage,
} from '../meshMessageQueue';

const operation = (id: string): MeshMessageOperation => ({
  id,
  message: {
    id,
    messageId: id,
    requestId: id,
    chatId: 'chat-1',
    senderId: 'u1',
    type: 'text',
    content: 'hello nearby',
    status: 'sending',
    createdAt: Date.now(),
    timestamp: Date.now(),
    deliveredTo: [],
    readBy: [],
  },
  chatType: 'group',
  groupId: 'group-1',
  participantIds: ['u1', 'u2', 'u3'],
  originUserId: 'u1',
  originOwned: true,
  cloudRelay: true,
  wireEnvelope: '{"signed":true}',
  createdAt: Date.now(),
});

describe('nearby message durable queue', () => {
  beforeEach(async () => {
    __clearAsyncStorageStore();
    await clearMeshMessageQueue();
  });

  it('deduplicates gossip by stable origin/message id', async () => {
    expect(await enqueueMeshMessage(operation('u1:m1'))).toBe(true);
    expect(await enqueueMeshMessage(operation('u1:m1'))).toBe(false);
    expect(await loadMeshMessageQueue()).toHaveLength(1);
  });

  it('rejects a persisted replay before stateful decrypt work begins', async () => {
    await enqueueMeshMessage(operation('u1:replayed'));

    expect(await claimMeshMessageProcessing('u1:replayed')).toBe(false);
  });

  it('allows only one concurrent receiver to claim a new envelope', async () => {
    const claims = await Promise.all([
      claimMeshMessageProcessing('u1:racing'),
      claimMeshMessageProcessing('u1:racing'),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    releaseMeshMessageProcessing('u1:racing');
    expect(await claimMeshMessageProcessing('u1:racing')).toBe(true);
    releaseMeshMessageProcessing('u1:racing');
  });

  it('keeps a successfully queued operation deduplicated after its claim is released', async () => {
    expect(await claimMeshMessageProcessing('u1:committed')).toBe(true);
    await enqueueMeshMessage(operation('u1:committed'));
    releaseMeshMessageProcessing('u1:committed');

    expect(await claimMeshMessageProcessing('u1:committed')).toBe(false);
  });

  it('persists broadcast progress without dropping cloud relay work', async () => {
    const pending = operation('u1:m2');
    await enqueueMeshMessage(pending);
    await updateMeshMessage({ ...pending, meshBroadcastAt: 500 });

    expect(await loadMeshMessageQueue()).toEqual([
      { ...pending, meshBroadcastAt: 500 },
    ]);
  });

  it('removes only the cloud-acknowledged operation', async () => {
    await enqueueMeshMessage(operation('first'));
    await enqueueMeshMessage(operation('second'));
    await removeMeshMessage('first');
    expect((await loadMeshMessageQueue()).map((item) => item.id)).toEqual(['second']);
  });
});
