/**
 * Offline trust directory for nearby transport admission.
 *
 * Multipeer discovery is only a radio capability signal. It must not be
 * treated as proof that the other installation belongs to somebody the user
 * knows. The durable Signal directory already gives us a stronger offline
 * primitive: installation ids previously published by members of locally
 * cached conversations, together with the public identity key used to verify
 * their signed message envelopes.
 *
 * This service reduces that cache to a bounded, collision-safe native
 * allowlist. It never performs a network read.
 */
import type { ChatThread } from '@/models';
import {
  listSignalDevices,
} from '@/services/signalCryptoService';
import type { SignalDeviceDirectoryEntry } from '@/services/signalDeviceDirectory';
import {
  loadPairedNearbyPeers,
  type PairedNearbyPeer,
} from '@/services/nearbyPairingTrustService';

export type NearbyTrustRelationship = 'direct' | 'shared-group' | 'paired';

export interface NearbyTrustedPeer {
  deviceId: string;
  userId: string;
  label: string;
  relationship: NearbyTrustRelationship;
  sharedChatCount: number;
}

type DeviceLoader = (
  userId: string,
) => Promise<SignalDeviceDirectoryEntry[]>;
type PairedPeerLoader = (currentUserId: string) => Promise<PairedNearbyPeer[]>;

interface CandidateUser {
  userId: string;
  label: string;
  relationship: NearbyTrustRelationship;
  chatIds: Set<string>;
}

const MAX_TRUSTED_NEARBY_PEERS = 256;

const usableLabel = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 80) : null;
};

/**
 * Builds the installations that may enter the native nearby session.
 *
 * A device id observed under two different accounts is excluded. This is not
 * theoretical: an installation can remain in an old account's public device
 * directory after somebody signs out and signs into another account on that
 * phone. Guessing which identity owns the radio would turn stale cloud state
 * into an authorization decision.
 */
export const buildNearbyTrustedPeers = async (
  threads: readonly ChatThread[],
  currentUserId: string,
  currentDeviceId: string,
  loadDevices: DeviceLoader = (userId) =>
    listSignalDevices(userId, 'cache-only'),
  loadPairedPeers: PairedPeerLoader = loadPairedNearbyPeers,
): Promise<NearbyTrustedPeer[]> => {
  const candidates = new Map<string, CandidateUser>();

  for (const thread of threads) {
    const participantIds = new Set([
      ...(Array.isArray(thread.participantIds) ? thread.participantIds : []),
      ...(Array.isArray(thread.participants)
        ? thread.participants.map((participant) => participant?.userId)
        : []),
    ].filter((id): id is string => Boolean(id) && id !== currentUserId));

    for (const userId of participantIds) {
      const participant = thread.participants?.find(
        (entry) => entry?.userId === userId,
      );
      const nextRelationship: NearbyTrustRelationship =
        thread.type === 'direct' ? 'direct' : 'shared-group';
      const existing = candidates.get(userId);
      const label =
        usableLabel(participant?.displayName)
        ?? existing?.label
        ?? 'Known contact';

      if (existing) {
        existing.chatIds.add(thread.chatId);
        if (nextRelationship === 'direct') {
          existing.relationship = 'direct';
          existing.label = label;
        }
      } else {
        candidates.set(userId, {
          userId,
          label,
          relationship: nextRelationship,
          chatIds: new Set([thread.chatId]),
        });
      }
    }
  }

  const ownership = new Map<
    string,
    { candidate: CandidateUser; device: SignalDeviceDirectoryEntry }[]
  >();
  await Promise.all(
    [...candidates.values()].map(async (candidate) => {
      let devices: SignalDeviceDirectoryEntry[] = [];
      try {
        devices = await loadDevices(candidate.userId);
      } catch {
        return;
      }
      for (const device of devices) {
        if (
          !device.deviceId
          || device.deviceId === currentDeviceId
          || typeof device.identityKey !== 'string'
          || device.identityKey.length === 0
        ) {
          continue;
        }
        const owners = ownership.get(device.deviceId) ?? [];
        owners.push({ candidate, device });
        ownership.set(device.deviceId, owners);
      }
    }),
  );

  const conversationPeers = [...ownership.entries()]
    .filter(([, owners]) =>
      new Set(owners.map(({ candidate }) => candidate.userId)).size === 1,
    )
    .map(([deviceId, owners]) => {
      const candidate = owners[0].candidate;
      return {
        deviceId,
        userId: candidate.userId,
        label: candidate.label,
        relationship: candidate.relationship,
        sharedChatCount: candidate.chatIds.size,
      };
    })
    .sort((a, b) =>
      Number(a.relationship !== 'direct') - Number(b.relationship !== 'direct')
      || a.label.localeCompare(b.label)
      || a.deviceId.localeCompare(b.deviceId),
    );

  // An explicit, completed code ceremony is symmetric and therefore wins over
  // an older ambiguous device-directory collision. Conversation-derived trust
  // still supplies the richer direct/group relationship when both agree.
  const merged = new Map(
    conversationPeers.map((peer) => [peer.deviceId, peer]),
  );
  const pairedPeers = await loadPairedPeers(currentUserId).catch(() => []);
  for (const peer of pairedPeers) {
    if (peer.deviceId === currentDeviceId || peer.userId === currentUserId) continue;
    const existing = merged.get(peer.deviceId);
    if (!existing) {
      merged.set(peer.deviceId, {
        deviceId: peer.deviceId,
        userId: peer.userId,
        label: usableLabel(peer.label) ?? 'Paired contact',
        relationship: 'paired',
        sharedChatCount: 0,
      });
    }
  }

  return [...merged.values()]
    .sort((a, b) =>
      Number(a.relationship === 'paired') - Number(b.relationship === 'paired')
      || Number(a.relationship !== 'direct') - Number(b.relationship !== 'direct')
      || a.label.localeCompare(b.label)
      || a.deviceId.localeCompare(b.deviceId),
    )
    .slice(0, MAX_TRUSTED_NEARBY_PEERS);
};
