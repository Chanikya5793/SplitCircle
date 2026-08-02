/**
 * The REAL `usePreventDoubleSubmit`, mounted (doc 35).
 *
 * `src/utils/__tests__/preventDoubleSubmitHazard.test.ts` pins the semantics of
 * the module-global key map, but it does so against a re-implementation of that
 * map — so it cannot see the hook's SECOND swallow path, the per-instance
 * `loadingRef` branch, which drops any concurrent call regardless of key.
 *
 * That gap is not academic. It is precisely what `handleForwardSelect` hit: it
 * salted its key with `Date.now()`, believing a unique key made it safe, and
 * was still silently dropped whenever another send was in flight on the same
 * hook instance. A test that only models the key map would have called that
 * code correct.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/context/LoadingContext', () => ({
  useLoading: () => ({ beginLoading: vi.fn(() => 'token'), endLoading: vi.fn() }),
}));

import { usePreventDoubleSubmit } from '../usePreventDoubleSubmit';

afterEach(cleanup);

/** A task that only completes when its returned `finish` is called. */
const deferred = () => {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => { finish = resolve; });
  return { promise, finish };
};

describe('usePreventDoubleSubmit, as actually implemented', () => {
  it('SWALLOWS a concurrent call even with NO key at all', async () => {
    // The branch the re-implementation in the sibling test file does not model,
    // and the reason "give it a unique key" was never a sufficient fix.
    const { result } = renderHook(() => usePreventDoubleSubmit());
    const ran: string[] = [];
    const first = deferred();

    let secondResult: unknown;
    await act(async () => {
      void result.current.run(async () => { ran.push('first'); await first.promise; });
      // Let the first call take the loading flag before the second arrives.
      await Promise.resolve();
      void result.current.run(async () => { ran.push('second'); }).then((value) => {
        secondResult = value;
      });
      first.finish();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ran).toEqual(['first']);
    // And the caller of the dropped task sees a resolved promise, so it has no
    // way to know its work never happened.
    expect(secondResult).toBeUndefined();
  });

  it('SWALLOWS a concurrent call whose key differs, because of that same branch', async () => {
    // handleForwardSelect's exact shape: distinct keys, still dropped.
    const { result } = renderHook(() => usePreventDoubleSubmit());
    const ran: string[] = [];
    const first = deferred();

    await act(async () => {
      void result.current.run(
        async () => { ran.push('forward-1'); await first.promise; },
        { key: 'forward-1' },
      );
      await Promise.resolve();
      void result.current.run(async () => { ran.push('forward-2'); }, { key: 'forward-2' });
      first.finish();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ran).toEqual(['forward-1']);
  });

  it('runs a SEQUENTIAL repeat, which is the double-tap case it exists for', async () => {
    const { result } = renderHook(() => usePreventDoubleSubmit());
    const ran: string[] = [];

    await act(async () => {
      await result.current.run(async () => { ran.push('first'); }, { key: 'submit' });
      await result.current.run(async () => { ran.push('second'); }, { key: 'submit' });
    });

    expect(ran).toEqual(['first', 'second']);
  });

  it('a rejected task releases the guard rather than wedging the instance', async () => {
    // If a throw left `loadingRef` set, one failed send would disable the
    // control for the rest of its mount — the same permanent-silence class of
    // bug, arriving by a different route.
    const { result } = renderHook(() => usePreventDoubleSubmit());
    const ran: string[] = [];

    await act(async () => {
      await result.current
        .run(async () => { throw new Error('boom'); }, { key: 'k' })
        .catch(() => undefined);
      await result.current.run(async () => { ran.push('after-failure'); }, { key: 'k' });
    });

    expect(ran).toEqual(['after-failure']);
  });
});
