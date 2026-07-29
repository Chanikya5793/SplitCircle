import { useSyncExternalStore } from 'react';
import {
  getNearbyMessagingSnapshot,
  subscribeToNearbyMessaging,
} from '@/services/nearbyMessageService';
import { getNearbyStatusPresentation } from '@/services/nearbyMessagingState';

export const useNearbyMessaging = () => {
  const snapshot = useSyncExternalStore(
    subscribeToNearbyMessaging,
    getNearbyMessagingSnapshot,
    getNearbyMessagingSnapshot,
  );

  return {
    snapshot,
    presentation: getNearbyStatusPresentation(snapshot),
  };
};
