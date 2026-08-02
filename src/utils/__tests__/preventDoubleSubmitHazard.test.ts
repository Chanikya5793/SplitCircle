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

  it('WEDGES A KEY FOREVER when a task never settles', async () => {
    // The map entry is released only in the task promise's `.finally()`, so a
    // task that never resolves never releases it. Nothing times it out, and
    // unmounting the component does not clear it — the map is module-global.
    //
    // `AttachmentMenu` used the constant key 'chat-attachment-selection', so
    // one hung picker would have killed attachment sending in EVERY chat for
    // the rest of the app's life, silently: subsequent taps get a promise that
    // never settles, so even a caller that awaits and catches sees nothing.
    // Not hypothetical — expo-image-picker hangs materialising a large iCloud
    // video (CLAUDE.md), which is the exact shape of a task that never settles.
    const run = makeGuardedRunner();
    const ran: string[] = [];

    void run('stuck-key', () => new Promise<void>(() => { /* never settles */ }));
    // Give the first call a turn, so it is genuinely in flight.
    await Promise.resolve();

    let secondSettled = false;
    void run('stuck-key', async () => { ran.push('second'); }).then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ran).toEqual([]);
    // The worst part: the caller cannot even detect it.
    expect(secondSettled).toBe(false);
  });

  it('is safe for the same key once the first call has settled', async () => {
    // The guard is not wrong in general — this is the case it exists for, and
    // the reason the fix is "do not key an action the user repeats" rather than
    // "delete the hook".
    const run = makeGuardedRunner();
    const ran: string[] = [];
    await run('form-submit', async () => { ran.push('first'); });
    await run('form-submit', async () => { ran.push('second'); });
    expect(ran).toEqual(['first', 'second']);
  });
});
