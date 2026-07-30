/**
 * Regression coverage for the "tap to remove reaction doesn't work reliably"
 * bug (2026-07-22 investigation). Root cause: applyRemoteMessageState's
 * `reactions` branch had no ordering guard, so a stale server-side
 * messageState doc (queued after a publish failure, or simply slow to
 * update) got replayed on every chat re-subscribe and silently clobbered a
 * newer local reaction toggle back to the old state — the user's removal
 * "never worked," with no error anywhere. toggleMessageReaction now stamps
 * reactionsLocalVersion on every local write, and applyRemoteMessageState
 * refuses to let an older remote write overwrite a newer local one.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { __clearAsyncStorageStore } from './mocks/async-storage';
import type { ChatMessage } from '@/models';
import {
  applyRemoteMessageState,
  getChatMessages,
  saveMessageLocally,
  toggleMessageReaction,
} from '../localMessageStorage';

const CHAT_ID = 'chat-1';
const MESSAGE_ID = 'msg-1';

const baseMessage = (): ChatMessage => ({
  id: MESSAGE_ID,
  messageId: MESSAGE_ID,
  chatId: CHAT_ID,
  senderId: 'user-1',
  type: 'text',
  content: 'hello',
  status: 'sent',
  createdAt: 1_000_000,
  timestamp: 1_000_000,
  deliveredTo: [],
  readBy: [],
});

// A Firestore Timestamp-like object — applyRemoteMessageState only relies on
// `.toMillis()` being present, matching the real SDK's shape.
const timestampAt = (ms: number) => ({ toMillis: () => ms });

describe('reaction removal survives a stale remote replay', () => {
  beforeEach(() => {
    __clearAsyncStorageStore();
  });

  it('does not let an older remote messageState doc undo a newer local removal', async () => {
    await saveMessageLocally(baseMessage());

    // User adds ❤️, then removes it — both local, both bump reactionsLocalVersion.
    await toggleMessageReaction(CHAT_ID, MESSAGE_ID, 'user-1', '❤️');
    const afterRemoval = await toggleMessageReaction(CHAT_ID, MESSAGE_ID, 'user-1', '❤️');
    expect(afterRemoval).toEqual({});

    const removalTime = Date.now();

    // A stale server doc — written BEFORE the removal — arrives late (e.g. a
    // re-subscribe replaying a messageState doc that never got the removal's
    // publish because it failed and queued). It must not resurrect the reaction.
    const changed = await applyRemoteMessageState(CHAT_ID, MESSAGE_ID, {
      reactions: { '❤️': ['user-1'] },
      updatedAt: timestampAt(removalTime - 5_000),
    });

    expect(changed).toBe(false);
    const [stored] = await getChatMessages(CHAT_ID);
    expect(stored.reactions ?? {}).toEqual({});
  });

  it('still applies a genuinely newer remote reaction update (e.g. from another device)', async () => {
    await saveMessageLocally(baseMessage());
    await toggleMessageReaction(CHAT_ID, MESSAGE_ID, 'user-1', '❤️');

    // Another participant reacted afterward — the remote doc is legitimately
    // newer than our last local write and must win.
    const changed = await applyRemoteMessageState(CHAT_ID, MESSAGE_ID, {
      reactions: { '❤️': ['user-1', 'user-2'] },
      updatedAt: timestampAt(Date.now() + 5_000),
    });

    expect(changed).toBe(true);
    const [stored] = await getChatMessages(CHAT_ID);
    expect(stored.reactions).toEqual({ '❤️': ['user-1', 'user-2'] });
  });

  it('applies a remote update with no updatedAt (pending-write echo) since there is nothing to compare against', async () => {
    await saveMessageLocally(baseMessage());

    const changed = await applyRemoteMessageState(CHAT_ID, MESSAGE_ID, {
      reactions: { '👍': ['user-1'] },
      updatedAt: null,
    });

    expect(changed).toBe(true);
    const [stored] = await getChatMessages(CHAT_ID);
    expect(stored.reactions).toEqual({ '👍': ['user-1'] });
  });
});

describe('local media merge preservation', () => {
  beforeEach(() => {
    __clearAsyncStorageStore();
  });

  it('does not erase a valid nearby file when cloud convergence omits local fields', async () => {
    await saveMessageLocally({
      ...baseMessage(),
      type: 'image',
      localMediaPath: 'file:///chat_media/chat-1/msg-1_photo.jpg',
      mediaDownloaded: true,
      mediaUrl: 'https://firebasestorage.googleapis.com/photo',
    });

    await saveMessageLocally({
      ...baseMessage(),
      type: 'image',
      status: 'delivered',
      localMediaPath: undefined,
      mediaDownloaded: undefined,
      mediaUrl: undefined,
    });

    const [stored] = await getChatMessages(CHAT_ID);
    expect(stored).toMatchObject({
      status: 'delivered',
      localMediaPath: 'file:///chat_media/chat-1/msg-1_photo.jpg',
      mediaDownloaded: true,
      mediaUrl: 'https://firebasestorage.googleapis.com/photo',
    });
  });
});
