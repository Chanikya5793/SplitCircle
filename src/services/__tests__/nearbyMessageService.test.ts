import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
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
const queue = vi.hoisted(() => ({
  loadMeshMessageQueue: vi.fn(async () => [] as unknown[]),
  updateMeshMessage: vi.fn(async () => undefined),
}));

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: vi.fn(() => native),
}));
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
vi.mock('../meshMessageQueue', () => queue);
vi.mock('../localMessageStorage', () => ({
  updateMessageStatus: vi.fn(async () => undefined),
}));
vi.mock('../meshMessageProtocol', () => ({
  parseSignedMeshEnvelope: vi.fn(() => null),
}));

import {
  __resetTransportPreferences,
  setNearbyEnabled,
  setTransportEnabled,
} from '../mesh/transportPreferences';
import {
  broadcastQueuedNearbyMessages,
  getNearbyMessagingSnapshot,
  setNearbyTrustedPeers,
  startNearbyMessaging,
} from '../nearbyMessageService';

describe('nearby message service trust handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queue.loadMeshMessageQueue.mockResolvedValue([]);
  });

  it('preserves the cached identity allowlist while resetting carrier state', async () => {
    setNearbyTrustedPeers([{
      deviceId: 'friend-phone',
      userId: 'friend',
      label: 'Asha',
      relationship: 'direct',
      sharedChatCount: 1,
    }]);

    const stop = await startNearbyMessaging('me', 'Me', vi.fn());

    expect(native.updateTrustedPeers).toHaveBeenCalledWith(['friend-phone']);
    expect(native.start).toHaveBeenCalledWith(
      'me',
      'this-installation',
      ['friend-phone'],
    );
    expect(getNearbyMessagingSnapshot().trustedPeers['friend-phone']?.label).toBe('Asha');

    stop();
  });

  it('hands an envelope only to its encrypted recipient installations', async () => {
    queue.loadMeshMessageQueue.mockResolvedValueOnce([{
      id: 'me:message-1',
      message: {
        id: 'message-1',
        chatId: 'direct-chat',
      },
      chatType: 'direct',
      participantIds: ['me', 'friend'],
      recipientDeviceIds: ['friend-phone'],
      originUserId: 'me',
      originOwned: false,
      cloudRelay: false,
      wireEnvelope: 'signed-wire-envelope',
      createdAt: 1,
    }]);

    native.send.mockResolvedValueOnce(1);
    expect(await broadcastQueuedNearbyMessages()).toBe(1);
    expect(native.send).toHaveBeenCalledWith(
      'signed-wire-envelope',
      ['friend-phone'],
    );
  });
});

/**
 * The Settings toggles must stop the RADIO, not merely bias routing (doc 35,
 * high #1).
 *
 * `isTransportEnabled` was consulted in exactly one place — the switch's
 * `available()` gate, which only picks a carrier for a NEW outbound send.
 * Nothing started or stopped a transport, so "Nearby messaging: Off" left every
 * radio advertising, scanning, accepting inbound frames and relaying other
 * people's traffic. The UI said one thing and the hardware did another, and no
 * existing test could tell the difference because they all assert on sends.
 */
describe('transport preferences drive the transport lifecycle', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    queue.loadMeshMessageQueue.mockResolvedValue([]);
    // Both halves: the in-memory snapshot AND the persisted copy that
    // `startNearbyMessaging` reads back through `loadTransportPreferences`.
    __resetTransportPreferences();
    await AsyncStorage.clear();
  });

  it('stops a running transport when nearby is switched off', async () => {
    const stop = await startNearbyMessaging('me', 'Me', vi.fn());
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.stop).not.toHaveBeenCalled();

    await setNearbyEnabled(false);

    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(getNearbyMessagingSnapshot().status).toBe('unavailable');
    stop();
  });

  it('brings the radio back when it is switched on again, without an app restart', async () => {
    const stop = await startNearbyMessaging('me', 'Me', vi.fn());
    await setNearbyEnabled(false);
    native.start.mockClear();

    await setNearbyEnabled(true);
    // start() is fired without awaiting the listener, so let it settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(native.start).toHaveBeenCalledTimes(1);
    stop();
  });

  it('honours a per-transport toggle, not just the master switch', async () => {
    const stop = await startNearbyMessaging('me', 'Me', vi.fn());

    await setTransportEnabled('mpc', false);

    expect(native.stop).toHaveBeenCalledTimes(1);
    stop();
  });

  it('never starts a transport the user had already disabled', async () => {
    await setNearbyEnabled(false);
    const stop = await startNearbyMessaging('me', 'Me', vi.fn());

    // Started-then-stopped would still have advertised, however briefly.
    expect(native.start).not.toHaveBeenCalled();
    expect(getNearbyMessagingSnapshot().status).toBe('unavailable');
    stop();
  });

  it('keeps the paired-peer list across an off/on cycle', async () => {
    setNearbyTrustedPeers([{
      deviceId: 'friend-phone',
      userId: 'friend',
      label: 'Asha',
      relationship: 'direct',
      sharedChatCount: 1,
    }]);
    const stop = await startNearbyMessaging('me', 'Me', vi.fn());

    await setNearbyEnabled(false);
    await setNearbyEnabled(true);
    await Promise.resolve();

    // A full snapshot rebuild would zero this, and nothing re-populates it
    // until the next pairing event — the peers would simply vanish.
    expect(getNearbyMessagingSnapshot().trustedPeers['friend-phone']?.label).toBe('Asha');
    stop();
  });
});

// The "a transport's peers reach the snapshot" case deliberately lives in
// nearbyTransportVisibility.test.ts, not here. In this file only MPC is
// registered, and MPC's neighbour changes ALSO flow through
// `applyNearbyMeshState`, which sets `connectedDeviceIds` — so a test written
// here passes whether or not the publication exists, which is worse than no
// test. That file enables the BLE flag so a transport MPC cannot cover for is
// doing the reporting; both of its cases were confirmed to fail without the fix.
