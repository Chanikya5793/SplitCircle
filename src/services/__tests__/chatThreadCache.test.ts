import { beforeEach, describe, expect, it } from 'vitest';

import { __clearAsyncStorageStore } from './mocks/async-storage';
import type { ChatThread } from '@/models';
import {
  clearCachedChatThreads,
  loadCachedChatThreads,
  persistChatThreads,
} from '../chatThreadCache';

const thread: ChatThread = {
  chatId: 'group-chat-1',
  groupId: 'group-1',
  type: 'group',
  participantIds: ['u1', 'u2'],
  participants: [],
  unreadCount: 0,
  updatedAt: 123,
};

describe('chat thread cold-boot cache', () => {
  beforeEach(() => {
    __clearAsyncStorageStore();
  });

  it('restores thread metadata without consulting Firestore', async () => {
    await persistChatThreads('u1', [thread]);
    expect(await loadCachedChatThreads('u1')).toEqual([thread]);
  });

  it('isolates accounts and clears only the signed-out account', async () => {
    await persistChatThreads('u1', [thread]);
    await persistChatThreads('u2', [{ ...thread, chatId: 'other' }]);

    await clearCachedChatThreads('u1');

    expect(await loadCachedChatThreads('u1')).toBeNull();
    expect(await loadCachedChatThreads('u2')).toHaveLength(1);
  });
});
