import { describe, expect, it } from 'vitest';
import {
  applyNearbyMeshState,
  createNearbyMessagingSnapshot,
  getNearbyPeerPresentations,
  getNearbyStatusPresentation,
  liveTransports,
  reachableNodeIds,
} from '../nearbyMessagingState';
import type { NearbyMessagingSnapshot } from '../nearbyMessagingState';

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
        ignoredPeerCount: 3,
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
      ignoredPeerCount: 3,
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
      trustedPeers: {
        'private-device-a': {
          deviceId: 'private-device-a',
          userId: 'u1',
          label: 'Asha',
          relationship: 'direct' as const,
          sharedChatCount: 1,
        },
        'private-device-b': {
          deviceId: 'private-device-b',
          userId: 'u2',
          label: 'Ben',
          relationship: 'shared-group' as const,
          sharedChatCount: 2,
        },
      },
    };

    const peers = getNearbyPeerPresentations(snapshot);

    expect(peers).toEqual([
      expect.objectContaining({
        deviceId: 'private-device-a',
        label: 'Asha',
        status: 'connected',
        detail: 'Direct-chat contact · 24 ms',
        isProbing: true,
      }),
      expect.objectContaining({
        deviceId: 'private-device-b',
        label: 'Ben',
        status: 'connecting',
        isProbing: false,
      }),
    ]);
    expect(JSON.stringify(peers.map(({ label, detail }) => ({ label, detail }))))
      .not.toContain('private-device');
  });

  it('never turns an opaque installation id into a visible phone identity', () => {
    const peers = getNearbyPeerPresentations({
      ...createNearbyMessagingSnapshot(true, 1),
      status: 'connected',
      discoveredPeerCount: 1,
      connectedPeerCount: 1,
      discoveredDeviceIds: ['715f845e-private-install-tail'],
      connectedDeviceIds: ['715f845e-private-install-tail'],
    });

    expect(peers).toEqual([
      expect.objectContaining({
        label: 'Recognized ManaSplit contact',
        detail: 'Cached conversation member · private link',
      }),
    ]);
    const visibleCopy = peers.map(({ label, detail, statusLabel }) => ({
      label,
      detail,
      statusLabel,
    }));
    expect(JSON.stringify(visibleCopy)).not.toContain('715f845e');
    expect(JSON.stringify(visibleCopy)).not.toContain('iPhone');
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

    expect(searching.label).toBe('Nearby · Looking for known contacts');
    expect(searching.detail).toContain('Unknown nearby ManaSplit installations are ignored');
    expect(connecting.detail).toContain('1 phone found');
    expect(connected.label).toBe('Nearby · 1 phone connected');
    expect(failed.label).toBe('Nearby needs attention');
    expect(failed.detail).not.toContain('NSNetServicesErrorDomain');
    expect(failed.detail).not.toContain('hotspot');
  });
});

/**
 * The snapshot must see peers reached over ANY transport (doc 35 follow-up).
 *
 * Every count in this snapshot except `transportPeers` is written by
 * `applyNearbyMeshState`, which consumes `addNearbyStateChangedListener` — a
 * MultipeerConnectivity-only native event. On Android MPC never emits, so
 * `connectedPeerCount` stayed 0 no matter how many peers were live over BLE or
 * LAN, and every nearby surface in the app said "Looking for known contacts"
 * while messages were actually flowing. Both phones showing the same frozen
 * status, with no way to distinguish a working mesh from a dead one, is exactly
 * that bug.
 */
describe('reachability across transports', () => {
  const androidShaped = (over: Partial<NearbyMessagingSnapshot> = {}): NearbyMessagingSnapshot => ({
    ...createNearbyMessagingSnapshot(true, 1),
    // MPC contributed nothing, which is the permanent state on Android.
    status: 'searching',
    connectedPeerCount: 0,
    connectedDeviceIds: [],
    ...over,
  });

  it('counts a BLE peer that MPC knows nothing about', () => {
    const snapshot = androidShaped({
      transportPeers: { mpc: [], ble: ['pixel-7'], lan: [] },
    });
    expect(reachableNodeIds(snapshot)).toEqual(['pixel-7']);
    expect(getNearbyStatusPresentation(snapshot).tone).toBe('success');
  });

  it('does NOT double-count one phone reachable over two transports', () => {
    // Counting links rather than nodes would make a two-device test look like
    // a three-device mesh.
    const snapshot = androidShaped({
      transportPeers: { mpc: [], ble: ['pixel-7'], lan: ['pixel-7'] },
    });
    expect(reachableNodeIds(snapshot)).toEqual(['pixel-7']);
  });

  it('names the route, so the user knows which radio is carrying it', () => {
    const ble = androidShaped({ transportPeers: { mpc: [], ble: ['p'], lan: [] } });
    expect(getNearbyStatusPresentation(ble).detail).toContain('Bluetooth');

    const both = androidShaped({ transportPeers: { mpc: [], ble: ['p'], lan: ['p'] } });
    expect(getNearbyStatusPresentation(both).detail).toContain('Wi-Fi');
    expect(getNearbyStatusPresentation(both).detail).toContain('Bluetooth');
  });

  it('still reports searching when no transport has a peer', () => {
    const snapshot = androidShaped();
    expect(reachableNodeIds(snapshot)).toEqual([]);
    expect(getNearbyStatusPresentation(snapshot).tone).not.toBe('success');
  });

  it('survives a snapshot persisted before transportPeers existed', () => {
    // Older stored/replayed shapes have no such field; treating that as a crash
    // would take the whole chat screen down.
    const legacy = { ...androidShaped(), transportPeers: undefined } as unknown as NearbyMessagingSnapshot;
    expect(reachableNodeIds(legacy)).toEqual([]);
    expect(liveTransports(legacy)).toEqual([]);
  });
});
