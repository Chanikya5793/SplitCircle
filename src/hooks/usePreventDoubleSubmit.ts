import { useLoading } from '@/context/LoadingContext';
import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';

type MaybePromise<T> = T | Promise<T>;

interface PreventDoubleSubmitOptions {
  key?: string;
  message?: string;
  overlay?: boolean;
}

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
