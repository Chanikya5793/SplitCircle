import { LoadingOverlay } from '@/components/LoadingOverlay';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

type LoadingEntry = {
  token: string;
  message?: string;
};

interface LoadingContextValue {
  visible: boolean;
  message?: string;
  beginLoading: (message?: string) => string;
  endLoading: (token: string) => void;
}

const LoadingContext = createContext<LoadingContextValue | undefined>(undefined);

export const LoadingProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [entries, setEntries] = useState<LoadingEntry[]>([]);
  const nextTokenRef = useRef(0);

  const beginLoading = useCallback((message?: string) => {
    const token = `loading-${nextTokenRef.current++}`;
    setEntries((current) => [...current, { token, message }]);
    return token;
  }, []);

  const endLoading = useCallback((token: string) => {
    setEntries((current) => current.filter((entry) => entry.token !== token));
  }, []);

  const currentEntry = entries[entries.length - 1];

  const value = useMemo<LoadingContextValue>(
    () => ({
      visible: entries.length > 0,
      message: currentEntry?.message,
      beginLoading,
      endLoading,
    }),
    [beginLoading, currentEntry?.message, endLoading, entries.length],
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
