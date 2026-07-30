import AsyncStorage from '@react-native-async-storage/async-storage';

export const NEARBY_PAIRING_TRUST_DAYS = 30;
const TRUST_LIFETIME_MS = NEARBY_PAIRING_TRUST_DAYS * 24 * 60 * 60 * 1000;
const TRUST_KEY_PREFIX = 'splitcircle.nearby.pairedPeers.v1.';
const MAX_PAIRED_PEERS = 64;

export interface PairedNearbyPeer {
  deviceId: string;
  userId: string;
  label: string;
  signalDeviceId: number;
  identityKey: string;
  pairedAt: number;
  expiresAt: number;
}

const trustKey = (currentUserId: string): string =>
  `${TRUST_KEY_PREFIX}${currentUserId}`;

const normalize = (value: unknown, now = Date.now()): PairedNearbyPeer[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((peer): peer is PairedNearbyPeer =>
    Boolean(peer)
    && typeof peer.deviceId === 'string'
    && peer.deviceId.length > 0
    && typeof peer.userId === 'string'
    && peer.userId.length > 0
    && typeof peer.label === 'string'
    && peer.label.length > 0
    && Number.isFinite(peer.signalDeviceId)
    && peer.signalDeviceId > 0
    && typeof peer.identityKey === 'string'
    && peer.identityKey.length > 0
    && Number.isFinite(peer.pairedAt)
    && Number.isFinite(peer.expiresAt)
    && peer.expiresAt > now,
  );
};

export const loadPairedNearbyPeers = async (
  currentUserId: string,
  now = Date.now(),
): Promise<PairedNearbyPeer[]> => {
  try {
    const raw = await AsyncStorage.getItem(trustKey(currentUserId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const peers = normalize(parsed, now)
      .sort((a, b) => b.pairedAt - a.pairedAt)
      .slice(0, MAX_PAIRED_PEERS);
    // Prune expired or malformed records opportunistically.
    if (raw && JSON.stringify(parsed) !== JSON.stringify(peers)) {
      void AsyncStorage.setItem(trustKey(currentUserId), JSON.stringify(peers));
    }
    return peers;
  } catch {
    return [];
  }
};

export const rememberPairedNearbyPeer = async (
  currentUserId: string,
  peer: Omit<PairedNearbyPeer, 'pairedAt' | 'expiresAt'>,
  now = Date.now(),
): Promise<PairedNearbyPeer> => {
  if (!currentUserId || peer.userId === currentUserId) {
    throw new Error('A nearby pairing must belong to another account.');
  }
  const record: PairedNearbyPeer = {
    ...peer,
    label: peer.label.trim().slice(0, 80) || 'Paired contact',
    pairedAt: now,
    expiresAt: now + TRUST_LIFETIME_MS,
  };
  const existing = await loadPairedNearbyPeers(currentUserId, now);
  const next = [
    record,
    ...existing.filter(({ deviceId }) => deviceId !== record.deviceId),
  ].slice(0, MAX_PAIRED_PEERS);
  await AsyncStorage.setItem(trustKey(currentUserId), JSON.stringify(next));
  return record;
};

export const forgetPairedNearbyPeer = async (
  currentUserId: string,
  deviceId: string,
): Promise<void> => {
  const existing = await loadPairedNearbyPeers(currentUserId);
  await AsyncStorage.setItem(
    trustKey(currentUserId),
    JSON.stringify(existing.filter((peer) => peer.deviceId !== deviceId)),
  );
};
