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
