import { describe, expect, it, vi } from 'vitest';

vi.mock('../signalCryptoService', () => ({
  listSignalDevices: vi.fn(),
}));

import type { ChatThread } from '@/models';
import { buildNearbyTrustedPeers } from '../nearbyTrustService';

const participant = (userId: string, displayName: string) => ({
  userId,
  displayName,
  status: 'offline' as const,
});

const thread = (
  chatId: string,
  type: ChatThread['type'],
  people: ReturnType<typeof participant>[],
): ChatThread => ({
  chatId,
  type,
  ...(type === 'group' ? { groupId: `group-${chatId}` } : {}),
  participantIds: people.map(({ userId }) => userId),
  participants: people,
  unreadCount: 0,
});

describe('nearby trust directory', () => {
  it('admits only identity-backed devices from cached conversations', async () => {
    const peers = await buildNearbyTrustedPeers(
      [
        thread('g1', 'group', [
          participant('me', 'Me'),
          participant('friend', 'Asha'),
          participant('legacy', 'Old client'),
        ]),
        thread('d1', 'direct', [
          participant('me', 'Me'),
          participant('friend', 'Asha'),
        ]),
      ],
      'me',
      'this-device',
      vi.fn(async (userId) => userId === 'friend'
        ? [
            {
              deviceId: 'friend-phone',
              signalDeviceId: 7,
              identityKey: 'public-key',
            },
            {
              deviceId: 'unsigned-phone',
              signalDeviceId: 8,
              identityKey: null,
            },
          ]
        : []),
    );

    expect(peers).toEqual([{
      deviceId: 'friend-phone',
      userId: 'friend',
      label: 'Asha',
      relationship: 'direct',
      sharedChatCount: 2,
    }]);
  });

  it('rejects an installation id claimed by two accounts', async () => {
    const peers = await buildNearbyTrustedPeers(
      [
        thread('g1', 'group', [
          participant('me', 'Me'),
          participant('one', 'One'),
          participant('two', 'Two'),
        ]),
      ],
      'me',
      'this-device',
      vi.fn(async (userId) => [{
        deviceId: 'reused-installation',
        signalDeviceId: userId === 'one' ? 1 : 2,
        identityKey: `key-${userId}`,
      }]),
    );

    expect(peers).toEqual([]);
  });

  it('never treats the current account or installation as a nearby contact', async () => {
    const loader = vi.fn(async () => [{
      deviceId: 'this-device',
      signalDeviceId: 1,
      identityKey: 'key',
    }]);
    const peers = await buildNearbyTrustedPeers(
      [thread('g1', 'group', [
        participant('me', 'Me'),
        participant('friend', 'Friend'),
      ])],
      'me',
      'this-device',
      loader,
    );

    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith('friend');
    expect(peers).toEqual([]);
  });

  it('admits a symmetrically paired identity even when no conversation cache exists', async () => {
    const peers = await buildNearbyTrustedPeers(
      [],
      'me',
      'this-device',
      vi.fn(async () => []),
      vi.fn(async () => [{
        deviceId: 'paired-phone',
        userId: 'friend',
        label: 'Asha',
        signalDeviceId: 9,
        identityKey: 'paired-public-key',
        pairedAt: 100,
        expiresAt: 1_000_000,
      }]),
    );

    expect(peers).toEqual([{
      deviceId: 'paired-phone',
      userId: 'friend',
      label: 'Asha',
      relationship: 'paired',
      sharedChatCount: 0,
    }]);
  });
});
