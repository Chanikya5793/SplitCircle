import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectLogged } from '@/testing/expectLogged';

// In-memory stand-in for AsyncStorage so the pure-node vitest config never
// loads the real react-native module.
const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

import { clearChatDraft, getChatDraft, saveChatDraft } from '../chatDrafts';

describe('chatDrafts', () => {
  beforeEach(() => {
    store.clear();
  });

  it('round-trips a draft for a chat', async () => {
    await saveChatDraft('chat-1', 'sorry, missed your call!');
    expect(await getChatDraft('chat-1')).toBe('sorry, missed your call!');
  });

  it('keeps drafts isolated per chat', async () => {
    await saveChatDraft('chat-1', 'for chat one');
    await saveChatDraft('chat-2', 'for chat two');
    expect(await getChatDraft('chat-1')).toBe('for chat one');
    expect(await getChatDraft('chat-2')).toBe('for chat two');
  });

  it('overwrites an existing draft', async () => {
    await saveChatDraft('chat-1', 'first');
    await saveChatDraft('chat-1', 'second');
    expect(await getChatDraft('chat-1')).toBe('second');
  });

  it('treats saving empty/whitespace text as clearing the draft', async () => {
    await saveChatDraft('chat-1', 'something');
    await saveChatDraft('chat-1', '   ');
    expect(await getChatDraft('chat-1')).toBeNull();
  });

  it('clearChatDraft removes the stored draft', async () => {
    await saveChatDraft('chat-1', 'something');
    await clearChatDraft('chat-1');
    expect(await getChatDraft('chat-1')).toBeNull();
  });

  it('returns null when no draft exists', async () => {
    expect(await getChatDraft('chat-none')).toBeNull();
  });

  it('ignores empty chat ids', async () => {
    await saveChatDraft('', 'text');
    expect(await getChatDraft('')).toBeNull();
  });

  it('never throws when storage fails', async () => {
    const AsyncStorage = (
      await import('@react-native-async-storage/async-storage')
    ).default;
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('io error'));
    vi.mocked(AsyncStorage.removeItem).mockRejectedValueOnce(new Error('io error'));

    // Captured, not silenced: swallowing a storage failure is correct here (a
    // lost draft must never break the composer) but it must still leave a
    // trace, or "my draft vanished" is undiagnosable. Asserting the log also
    // pins it at console.error — a Release bundle drops console.warn entirely.
    await expectLogged('failed to save draft', () =>
      expect(saveChatDraft('chat-1', 'text')).resolves.toBeUndefined());
    await expectLogged('failed to read draft', () =>
      expect(getChatDraft('chat-1')).resolves.toBeNull());
    await expectLogged('failed to clear draft', () =>
      expect(clearChatDraft('chat-1')).resolves.toBeUndefined());
  });
});
