import { useLoading } from '@/context/LoadingContext';
import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';

type MaybePromise<T> = T | Promise<T>;

interface PreventDoubleSubmitOptions {
  key?: string;
  message?: string;
  overlay?: boolean;
}

/**
 * DO NOT USE THIS FOR ANY ACTION A USER LEGITIMATELY REPEATS.
 *
 * A concurrent call with the same key — or ANY concurrent call, via the
 * `loadingRef` branch below — returns the in-flight promise and NEVER RUNS the
 * new task. For "Pay", "Create group", or "Submit", that is exactly right: the
 * second tap is a mistake.
 *
 * For chat messages it is catastrophic. `handleSend` passed
 * `key: chat-send-<chatId>`, constant for the whole conversation, so a second
 * message sent while the first was in flight had its task discarded — and the
 * composer had already cleared the text, so it left no bubble, no error and no
 * trace. Weeks of "messages get lost when I send quickly", on both platforms,
 * online and offline. Message sends now call `sendMessage` directly.
 *
 * The tell: this returns `Promise<T>` on a path where the task never ran, so
 * every caller sees a success it did not get. See
 * `src/utils/__tests__/preventDoubleSubmitHazard.test.ts`.
 */
const activeRequestPromises = new Map<string, Promise<unknown>>();

export const usePreventDoubleSubmit = (defaults?: PreventDoubleSubmitOptions) => {
  const { beginLoading, endLoading } = useLoading();
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const currentPromiseRef = useRef<Promise<unknown> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async <T,>(
      task: (requestId: string) => MaybePromise<T>,
      options?: PreventDoubleSubmitOptions,
    ): Promise<T> => {
      const key = options?.key ?? defaults?.key;

      if (key) {
        const activePromise = activeRequestPromises.get(key);
        if (activePromise) {
          return activePromise as Promise<T>;
        }
      }

      if (loadingRef.current && currentPromiseRef.current) {
        return currentPromiseRef.current as Promise<T>;
      }

      const requestId = uuid();
      const showOverlay = options?.overlay ?? defaults?.overlay ?? false;
      const message = options?.message ?? defaults?.message;

      loadingRef.current = true;
      setLoading(true);

      const overlayToken = showOverlay ? beginLoading(message) : undefined;

      const activePromise = Promise.resolve(task(requestId)).finally(() => {
        if (key) {
          activeRequestPromises.delete(key);
        }

        if (overlayToken) {
          endLoading(overlayToken);
        }

        loadingRef.current = false;
        currentPromiseRef.current = null;

        if (mountedRef.current) {
          setLoading(false);
        }
      });

      currentPromiseRef.current = activePromise;

      if (key) {
        activeRequestPromises.set(key, activePromise);
      }

      return activePromise;
    },
    [beginLoading, defaults?.key, defaults?.message, defaults?.overlay, endLoading],
  );

  return {
    loading,
    run,
  };
};
