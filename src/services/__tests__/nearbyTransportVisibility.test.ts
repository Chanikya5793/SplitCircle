/**
 * A non-MPC transport's peers must reach the user-visible snapshot.
 *
 * This needs its own file because it needs the BLE flag ON at module load, and
 * `nearbyMessageService` reads `EXPO_PUBLIC_ENABLE_BLE_MESH` once at import.
 *
 * Why it cannot live in `nearbyMessageService.test.ts`: there, only the MPC
 * transport is registered, and MPC's neighbour changes ALSO flow through
 * `applyNearbyMeshState`, which sets `connectedDeviceIds` — so a test driving
 * MPC passes whether or not the new publication exists. The bug was specifically
 * that a transport with no native state event (every transport except MPC, and
 * therefore EVERY transport on Android) could not affect the snapshot at all.
 * Isolating it requires a transport that MPC's path cannot cover for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Before the service module is imported and reads it.
vi.hoisted(() => {
  process.env.EXPO_PUBLIC_ENABLE_BLE_MESH = '1';
});

const mpcNative = vi.hoisted(() => ({
  addListener: vi.fn(() => ({ remove: vi.fn() })),
  connectedPeerCount: vi.fn(() => 0),
  probePeer: vi.fn(() => false),
  restartDiscovery: vi.fn(),
  send: vi.fn(async () => 0),
  sendPreparedAttachment: vi.fn(async () => 0),
  start: vi.fn(async () => true),
  stop: vi.fn(),
  updateTrustedPeers: vi.fn(),
}));

/** Captures the peers callback so the test can drive it like a real radio. */
const ble = vi.hoisted(() => {
  const listeners: ((peers: { deviceId: string }[]) => void)[] = [];
  return {
    listeners,
    module: {
      isAvailable: () => true,
      requestPermissions: async () => true,
      start: vi.fn(async () => true),
      stop: vi.fn(),
      updateTrust: vi.fn(),
      connectedPeers: vi.fn(() => [] as { deviceId: string }[]),
      sendChunk: vi.fn(async () => true),
      addChunkListener: vi.fn(() => () => undefined),
      addPeersChangedListener: vi.fn((cb: (peers: { deviceId: string }[]) => void) => {
        listeners.push(cb);
        return () => undefined;
      }),
    },
  };
});

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: vi.fn(() => mpcNative),
}));
vi.mock('../../../modules/splitcircle-ble', () => ({ nativeBle: ble.module }));
vi.mock('../pairingService', () => ({
  getCurrentDeviceId: vi.fn(async () => 'this-installation'),
}));
vi.mock('../nearbyPairingService', () => ({
  cancelNearbyPairing: vi.fn(),
  configureNearbyPairing: vi.fn(),
  handleNearbyPairingEnvelope: vi.fn(() => false),
  handleNearbyPairingMeshState: vi.fn(),
}));
vi.mock('../nearbyAttachmentService', () => ({
  announceIncomingNearbyAttachmentProgress: vi.fn(async () => undefined),
}));
vi.mock('../meshMessageQueue', () => ({
  loadMeshMessageQueue: vi.fn(async () => []),
  updateMeshMessage: vi.fn(async () => undefined),
}));
vi.mock('../localMessageStorage', () => ({
  updateMessageStatus: vi.fn(async () => undefined),
}));
vi.mock('../meshMessageProtocol', () => ({ parseSignedMeshEnvelope: vi.fn(() => null) }));

import {
  getNearbyMessagingSnapshot,
  startNearbyMessaging,
} from '../nearbyMessageService';
import {
  getNearbyStatusPresentation,
  liveTransports,
  reachableNodeIds,
} from '../nearbyMessagingState';

// FILE level, not inside one describe. Scoped to a single block, the reset did
// not apply to later blocks and their mock call counts inherited every earlier
// test's — which looks exactly like the code under test starting a radio twice.
beforeEach(() => {
  ble.listeners.length = 0;
  vi.clearAllMocks();
  ble.module.start.mockResolvedValue(true);
});

describe('a BLE peer is visible without any MPC event', () => {

  it('reaches the snapshot, the status and the route name', async () => {
    const stop = await startNearbyMessaging('me', 'Me', vi.fn());
    expect(ble.listeners.length).toBeGreaterThan(0);

    // MPC has emitted nothing and never will on Android — this is the whole
    // point. Only the BLE radio reports.
    ble.module.connectedPeers.mockReturnValue([{ deviceId: 'pixel-7' }]);
    ble.listeners.forEach((cb) => cb([{ deviceId: 'pixel-7' }]));

    const snapshot = getNearbyMessagingSnapshot();
    expect(reachableNodeIds(snapshot)).toContain('pixel-7');
    expect(liveTransports(snapshot)).toContain('ble');

    const presentation = getNearbyStatusPresentation(snapshot);
    expect(presentation.tone).toBe('success');
    // Named route, not a bare "connected" the user cannot act on.
    expect(presentation.detail).toContain('Bluetooth');

    stop();
  });

  it('clears the peer when the radio reports it gone', async () => {
    const stop = await startNearbyMessaging('me', 'Me', vi.fn());
    ble.module.connectedPeers.mockReturnValue([{ deviceId: 'pixel-7' }]);
    ble.listeners.forEach((cb) => cb([{ deviceId: 'pixel-7' }]));
    expect(reachableNodeIds(getNearbyMessagingSnapshot())).toContain('pixel-7');

    ble.module.connectedPeers.mockReturnValue([]);
    ble.listeners.forEach((cb) => cb([]));
    expect(reachableNodeIds(getNearbyMessagingSnapshot())).not.toContain('pixel-7');

    stop();
  });
});

/**
 * A transport that could not start must be re-attempted.
 *
 * Every reason a radio declines is temporary and user-controlled: Bluetooth
 * off, no Wi-Fi yet, an Android grant not given, an iOS prompt not yet
 * answered. Nothing retried, so the state at the instant of launch decided the
 * whole session — turning Bluetooth on five seconds after opening the app left
 * nearby dark until a full restart.
 *
 * On iOS this is also what makes the permission prompts reachable at all: the
 * prompt appears when the native manager is constructed inside `start()`, so a
 * start that never happens is a prompt that never appears.
 */
describe('transport start retry', () => {
  it('re-attempts a transport that declined, and reports it once it succeeds', async () => {
    vi.useFakeTimers();
    try {
      // Radio off at launch.
      ble.module.start.mockResolvedValueOnce(false);
      const stop = await startNearbyMessaging('me', 'Me', vi.fn());
      expect(ble.module.start).toHaveBeenCalledTimes(1);

      // User switches Bluetooth on; the next attempt succeeds.
      ble.module.start.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(16_000);

      expect(ble.module.start.mock.calls.length).toBeGreaterThan(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retrying once the transport is running', async () => {
    vi.useFakeTimers();
    try {
      const stop = await startNearbyMessaging('me', 'Me', vi.fn());
      const afterStart = ble.module.start.mock.calls.length;

      // Already running: the tick must not restart a healthy radio, which
      // would drop every live peer every 15 seconds.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ble.module.start.mock.calls.length).toBe(afterStart);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not keep retrying after teardown', async () => {
    vi.useFakeTimers();
    try {
      ble.module.start.mockResolvedValue(false);
      const stop = await startNearbyMessaging('me', 'Me', vi.fn());
      stop();
      const afterStop = ble.module.start.mock.calls.length;

      await vi.advanceTimersByTimeAsync(120_000);
      expect(ble.module.start.mock.calls.length).toBe(afterStop);
    } finally {
      vi.useRealTimers();
    }
  });
});
