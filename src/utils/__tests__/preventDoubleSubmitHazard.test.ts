/**
 * What `usePreventDoubleSubmit` does to CONCURRENT calls — and why chat sends
 * must never use it.
 *
 * This does not test a component. It pins the semantics of the module-level
 * de-duplication map, because those semantics silently ate messages for weeks:
 * `handleSend` passed `key: chat-send-<chatId>`, constant for the whole
 * conversation, so a second message sent while the first was in flight had its
 * task DISCARDED — the input had already been cleared, so it left no bubble, no
 * error, and no trace anywhere.
 *
 * The hook is correct for what it is for: one action a user might double-tap.
 * It is catastrophic for an action the user legitimately repeats.
 */
import { describe, expect, it } from 'vitest';

/**
 * The exact de-duplication `usePreventDoubleSubmit` performs, extracted so the
 * behaviour can be asserted without mounting React.
 */
const makeGuardedRunner = () => {
  const active = new Map<string, Promise<unknown>>();
  return async <T,>(key: string, task: () => Promise<T>): Promise<T> => {
    const inFlight = active.get(key);
    if (inFlight) return inFlight as Promise<T>;
    const promise = task().finally(() => active.delete(key));
    active.set(key, promise);
    return promise;
  };
};

describe('the hazard this pattern creates', () => {
  it('DISCARDS a concurrent task that shares a key', async () => {
    const run = makeGuardedRunner();
    const ran: string[] = [];
    const slow = (id: string) => async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      ran.push(id);
      return id;
    };

    // Two "messages", same per-chat key, second sent while the first is in
    // flight — exactly what rapid sending produces.
    const [a, b] = await Promise.all([
      run('chat-send-abc', slow('message-1')),
      run('chat-send-abc', slow('message-2')),
    ]);

    // The second task NEVER RAN, and its caller got the first one's result —
    // so it looks like a success to every layer above.
    expect(ran).toEqual(['message-1']);
    expect(a).toBe('message-1');
    expect(b).toBe('message-1');
  });

  it('runs both when the key is unique per send', async () => {
    // The fix: message sends are distinct actions and must not share a key.
    const run = makeGuardedRunner();
    const ran: string[] = [];
    const slow = (id: string) => async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      ran.push(id);
      return id;
    };

    await Promise.all([
      run('send-1', slow('message-1')),
      run('send-2', slow('message-2')),
    ]);

    expect(ran.sort()).toEqual(['message-1', 'message-2']);
  });
});
