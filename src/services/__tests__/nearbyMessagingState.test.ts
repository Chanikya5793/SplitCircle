import { describe, expect, it } from 'vitest';
import {
  applyNearbyMeshState,
  createNearbyMessagingSnapshot,
  getNearbyPeerPresentations,
  getNearbyStatusPresentation,
} from '../nearbyMessagingState';

describe('nearby messaging state', () => {
  it('distinguishes a missing native transport from an idle available transport', () => {
    expect(createNearbyMessagingSnapshot(false, 10).status).toBe('unavailable');
    expect(createNearbyMessagingSnapshot(true, 10).status).toBe('idle');
  });

  it('normalizes connected devices and never understates the connected count', () => {
    const next = applyNearbyMeshState(
      createNearbyMessagingSnapshot(true, 1),
      {
        status: 'connected',
        connectedPeerCount: 1,
        discoveredPeerCount: 0,
        connectingPeerCount: -2,
        discoveredDeviceIds: ['device-c', 'device-a'],
        connectingDeviceIds: ['device-c', 'device-a'],
        connectedDeviceIds: ['device-b', 'device-a', 'device-b'],
        probingDeviceIds: ['device-a', 'not-connected'],
        peerLatencyMs: {
          'device-a': 17.9,
          'device-b': -1,
          'not-connected': 42,
        },
      },
      20,
    );

    expect(next).toMatchObject({
      status: 'connected',
      connectedPeerCount: 2,
      discoveredPeerCount: 3,
      connectingPeerCount: 1,
      discoveredDeviceIds: ['device-c', 'device-a', 'device-b'],
      connectingDeviceIds: ['device-c'],
      connectedDeviceIds: ['device-b', 'device-a'],
      probingDeviceIds: ['device-a'],
      peerLatencyMs: { 'device-a': 17 },
      lastChangedAt: 20,
    });
  });

  it('builds privacy-safe peer cards with connection precedence and link latency', () => {
    const snapshot = {
      ...createNearbyMessagingSnapshot(true, 1),
      status: 'connected' as const,
      discoveredPeerCount: 2,
      connectingPeerCount: 1,
      connectedPeerCount: 1,
      discoveredDeviceIds: ['private-device-b', 'private-device-a'],
      connectingDeviceIds: ['private-device-b'],
      connectedDeviceIds: ['private-device-a'],
      probingDeviceIds: ['private-device-a'],
      peerLatencyMs: { 'private-device-a': 24 },
    };

    const peers = getNearbyPeerPresentations(snapshot);

    expect(peers).toEqual([
      expect.objectContaining({
        deviceId: 'private-device-a',
        label: 'Nearby iPhone 1',
        status: 'connected',
        detail: 'Secure direct link · 24 ms',
        isProbing: true,
      }),
      expect.objectContaining({
        deviceId: 'private-device-b',
        label: 'Nearby iPhone 2',
        status: 'connecting',
        isProbing: false,
      }),
    ]);
    expect(JSON.stringify(peers.map(({ label, detail }) => ({ label, detail }))))
      .not.toContain('private-device');
  });

  it('uses truthful copy for searching, connecting, connected, and error states', () => {
    const base = createNearbyMessagingSnapshot(true, 1);
    const searching = getNearbyStatusPresentation({
      ...base,
      status: 'searching',
      discoveredPeerCount: 0,
    });
    const connecting = getNearbyStatusPresentation({
      ...base,
      status: 'connecting',
      connectingPeerCount: 1,
    });
    const connected = getNearbyStatusPresentation({
      ...base,
      status: 'connected',
      connectedPeerCount: 1,
      connectedDeviceIds: ['device-a'],
    });
    const failed = getNearbyStatusPresentation({
      ...base,
      status: 'error',
      errorMessage: 'NSNetServicesErrorDomain -72008',
    });

    expect(searching.label).toBe('Nearby · Searching for phones');
    expect(searching.detail).toContain('No hotspot or internet is needed');
    expect(connecting.detail).toContain('1 phone found');
    expect(connected.label).toBe('Nearby · 1 phone connected');
    expect(failed.label).toBe('Nearby needs attention');
    expect(failed.detail).not.toContain('NSNetServicesErrorDomain');
    expect(failed.detail).not.toContain('hotspot');
  });
});
