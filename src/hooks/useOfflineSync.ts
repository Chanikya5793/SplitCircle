import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

interface OfflineSyncOptions {
  onReconnect?: () => Promise<void> | void;
}

export const useOfflineSync = ({ onReconnect }: OfflineSyncOptions = {}) => {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const nextOnlineState = Boolean(state.isConnected && state.isInternetReachable);
      setIsOnline(nextOnlineState);
      if (nextOnlineState && onReconnect) {
        onReconnect();
      }
    });

    return () => unsubscribe();
  }, [onReconnect]);

  return { isOnline };
};
