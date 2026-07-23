/**
 * publishMessageState reaction-removal regression test.
 *
 * Root cause: Firestore's plain `merge: true` performs a RECURSIVE merge on
 * nested map fields (like `reactions`), so it can only add/overwrite keys
 * present in the new value -- it can never remove a key that's simply absent
 * from it. Removing a user's only reaction (next reactions = {}) was a
 * complete server-side no-op, and removing one emoji among several left that
 * emoji's key on the server forever. The fix switches to `mergeFields`, which
 * makes each top-level field in the write a full replace instead of a
 * recursive per-key merge, while leaving sibling fields (deletedForEveryone,
 * editedContent/editedAt) on the doc untouched.
 *
 * This is independent of the earlier `reactionsLocalVersion` ordering guard
 * fix in localMessageStorage.ts -- that guarded against stale queued writes
 * replaying late; this bug is the server's CURRENT (permanently wrong) state
 * being correctly echoed back, so no ordering guard can catch it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/firebase', () => ({ app: {}, db: {} }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({ __kind: 'collection' })),
  doc: vi.fn(() => ({ __kind: 'doc' })),
  onSnapshot: vi.fn(),
  serverTimestamp: vi.fn(() => ({ __kind: 'serverTimestamp' })),
  setDoc: vi.fn().mockResolvedValue(undefined),
}));

import { setDoc } from 'firebase/firestore';
import { publishMessageState } from '../messageStateService';

const setDocMock = vi.mocked(setDoc);

describe('publishMessageState reactions removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses mergeFields (not bare merge:true) when removing the only reaction', async () => {
    await publishMessageState('chat1', 'msg1', { reactions: {} });

    expect(setDocMock).toHaveBeenCalledTimes(1);
    const [, data, options] = setDocMock.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
      { mergeFields?: string[]; merge?: boolean },
    ];

    expect(options).not.toEqual({ merge: true });
    expect(options).toHaveProperty('mergeFields');
    expect(options.mergeFields).toEqual(expect.arrayContaining(['reactions', 'updatedAt']));
    expect(data.reactions).toEqual({});
  });

  it('uses mergeFields when removing one emoji key from a multi-emoji reactions map', async () => {
    await publishMessageState('chat1', 'msg2', { reactions: { '👍': ['userA'] } });

    expect(setDocMock).toHaveBeenCalledTimes(1);
    const [, data, options] = setDocMock.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
      { mergeFields?: string[]; merge?: boolean },
    ];

    expect(options).not.toEqual({ merge: true });
    expect(options.mergeFields).toEqual(expect.arrayContaining(['reactions', 'updatedAt']));
    // The fix doesn't touch the data payload, only the write-options shape.
    expect(data.reactions).toEqual({ '👍': ['userA'] });
  });

  it('still passes only primitive fields unchanged through mergeFields for non-reaction updates', async () => {
    await publishMessageState('chat1', 'msg3', { deletedForEveryone: true });

    const [, data, options] = setDocMock.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
      { mergeFields?: string[]; merge?: boolean },
    ];
    expect(options.mergeFields).toEqual(expect.arrayContaining(['deletedForEveryone', 'updatedAt']));
    expect(data.deletedForEveryone).toBe(true);
  });
});
