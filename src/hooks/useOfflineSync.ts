import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

interface OfflineSyncOptions {
  onReconnect?: () => Promise<void> | void;
}

export const useOfflineSync = ({ onReconnect }: OfflineSyncOptions = {}) => {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      // On web, `isInternetReachable` stays `null` while the reachability
      // probe is pending — only treat an explicit `false` as offline there.
      // Native platforms keep the original stricter check unchanged.
      const nextOnlineState =
        Platform.OS === 'web'
          ? Boolean(state.isConnected) && state.isInternetReachable !== false
          : Boolean(state.isConnected && state.isInternetReachable);
      setIsOnline(nextOnlineState);
      if (nextOnlineState && onReconnect) {
        onReconnect();
      }
    });

    return () => unsubscribe();
  }, [onReconnect]);

  return { isOnline };
};
