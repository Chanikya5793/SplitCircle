import { beforeEach, describe, expect, it } from 'vitest';
import {
  __asyncStorageStore,
  __clearAsyncStorageStore,
} from './mocks/async-storage';
import {
  forgetPairedNearbyPeer,
  loadPairedNearbyPeers,
  rememberPairedNearbyPeer,
} from '../nearbyPairingTrustService';

describe('nearby pairing trust persistence', () => {
  beforeEach(() => __clearAsyncStorageStore());

  it('persists a verified peer for offline reboot and supports forgetting it', async () => {
    await rememberPairedNearbyPeer('me', {
      deviceId: 'friend-phone',
      userId: 'friend',
      label: 'Asha',
      signalDeviceId: 7,
      identityKey: 'public-key',
    }, 1_000);

    expect(await loadPairedNearbyPeers('me', 2_000)).toEqual([
      expect.objectContaining({
        deviceId: 'friend-phone',
        userId: 'friend',
        label: 'Asha',
      }),
    ]);

    await forgetPairedNearbyPeer('me', 'friend-phone');
    expect(await loadPairedNearbyPeers('me', 2_000)).toEqual([]);
  });

  it('prunes expired trust instead of silently making it permanent', async () => {
    __asyncStorageStore.set('splitcircle.nearby.pairedPeers.v1.me', JSON.stringify([{
      deviceId: 'old-phone',
      userId: 'old-friend',
      label: 'Old',
      signalDeviceId: 2,
      identityKey: 'old-key',
      pairedAt: 1,
      expiresAt: 99,
    }]));

    expect(await loadPairedNearbyPeers('me', 100)).toEqual([]);
  });
});
