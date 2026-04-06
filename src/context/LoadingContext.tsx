import { LoadingOverlay } from '@/components/LoadingOverlay';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

type LoadingEntry = {
  token: string;
  message?: string;
};

type KeyedLoadingEntry = {
  count: number;
  message?: string;
};

interface LoadingContextValue {
  visible: boolean;
  message?: string;
  beginLoading: (message?: string) => string;
  endLoading: (token: string) => void;
  beginKeyedLoading: (key: string, message?: string) => void;
  endKeyedLoading: (key: string) => void;
  setKeyedLoadingMessage: (key: string, message?: string) => void;
  isKeyedLoading: (key: string) => boolean;
  getKeyedLoadingMessage: (key: string) => string | undefined;
}

const LoadingContext = createContext<LoadingContextValue | undefined>(undefined);

export const LoadingProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [entries, setEntries] = useState<LoadingEntry[]>([]);
  const [keyedEntries, setKeyedEntries] = useState<Record<string, KeyedLoadingEntry>>({});
  const nextTokenRef = useRef(0);

  const beginLoading = useCallback((message?: string) => {
    const token = `loading-${nextTokenRef.current++}`;
    setEntries((current) => [...current, { token, message }]);
    return token;
  }, []);

  const endLoading = useCallback((token: string) => {
    setEntries((current) => current.filter((entry) => entry.token !== token));
  }, []);

  const beginKeyedLoading = useCallback((key: string, message?: string) => {
    setKeyedEntries((current) => {
      const existing = current[key];
      return {
        ...current,
        [key]: {
          count: (existing?.count ?? 0) + 1,
          message: message ?? existing?.message,
        },
      };
    });
  }, []);

  const endKeyedLoading = useCallback((key: string) => {
    setKeyedEntries((current) => {
      const existing = current[key];
      if (!existing) {
        return current;
      }

      if (existing.count <= 1) {
        const next = { ...current };
        delete next[key];
        return next;
      }

      return {
        ...current,
        [key]: {
          ...existing,
          count: existing.count - 1,
        },
      };
    });
  }, []);

  const setKeyedLoadingMessage = useCallback((key: string, message?: string) => {
    setKeyedEntries((current) => {
      const existing = current[key];
      if (!existing) {
        return current;
      }

      return {
        ...current,
        [key]: {
          ...existing,
          message,
        },
      };
    });
  }, []);

  const isKeyedLoading = useCallback((key: string) => Boolean(keyedEntries[key]), [keyedEntries]);
  const getKeyedLoadingMessage = useCallback((key: string) => keyedEntries[key]?.message, [keyedEntries]);

  const currentEntry = entries[entries.length - 1];

  const value = useMemo<LoadingContextValue>(
    () => ({
      visible: entries.length > 0,
      message: currentEntry?.message,
      beginLoading,
      endLoading,
      beginKeyedLoading,
      endKeyedLoading,
      setKeyedLoadingMessage,
      isKeyedLoading,
      getKeyedLoadingMessage,
    }),
    [
      beginKeyedLoading,
      beginLoading,
      currentEntry?.message,
      endKeyedLoading,
      endLoading,
      entries.length,
      getKeyedLoadingMessage,
      isKeyedLoading,
      setKeyedLoadingMessage,
    ],
  );

  return (
    <LoadingContext.Provider value={value}>
      {children}
      <LoadingOverlay visible={value.visible} message={value.message} />
    </LoadingContext.Provider>
  );
};

export const useLoading = () => {
  const context = useContext(LoadingContext);
  if (!context) {
    throw new Error('useLoading must be used within LoadingProvider');
  }
  return context;
};

export const useLoadingState = (key: string) => {
  const {
    beginKeyedLoading,
    endKeyedLoading,
    getKeyedLoadingMessage,
    isKeyedLoading,
    setKeyedLoadingMessage,
  } = useLoading();

  return {
    loading: isKeyedLoading(key),
    message: getKeyedLoadingMessage(key),
    start: useCallback((message?: string) => beginKeyedLoading(key, message), [beginKeyedLoading, key]),
    stop: useCallback(() => endKeyedLoading(key), [endKeyedLoading, key]),
    setMessage: useCallback((message?: string) => setKeyedLoadingMessage(key, message), [key, setKeyedLoadingMessage]),
  };
};
