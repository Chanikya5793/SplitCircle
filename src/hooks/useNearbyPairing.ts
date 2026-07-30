import { useSyncExternalStore } from 'react';
import {
  getNearbyPairingSnapshot,
  subscribeToNearbyPairing,
} from '@/services/nearbyPairingService';

export const useNearbyPairing = () => useSyncExternalStore(
  subscribeToNearbyPairing,
  getNearbyPairingSnapshot,
  getNearbyPairingSnapshot,
);
