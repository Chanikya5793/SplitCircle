import type {
  MeshStateEvent,
  NativeNearbyMeshStatus,
} from '../../modules/splitcircle-mesh';
import type { NearbyTrustedPeer } from '@/services/nearbyTrustService';

export type NearbyMessagingStatus = 'unavailable' | NativeNearbyMeshStatus;

export interface NearbyMessagingSnapshot {
  status: NearbyMessagingStatus;
  connectedPeerCount: number;
  discoveredPeerCount: number;
  connectingPeerCount: number;
  discoveredDeviceIds: string[];
  connectingDeviceIds: string[];
  connectedDeviceIds: string[];
  pairingDeviceIds: string[];
  pairingEnabled: boolean;
  probingDeviceIds: string[];
  peerLatencyMs: Record<string, number>;
  trustedPeers: Record<string, NearbyTrustedPeer>;
  ignoredPeerCount: number;
  lastMessageEvent?: NearbyMessageEvent;
  errorCode?: number;
  errorMessage?: string;
  lastChangedAt: number;
}

export interface NearbyMessageEvent {
  type: 'sent' | 'received' | 'blocked' | 'rejected';
  detail: string;
  at: number;
  peerCount?: number;
  chatId?: string;
}

export type NearbyPeerStatus = 'found' | 'connecting' | 'connected';

export interface NearbyPeerPresentation {
  deviceId: string;
  label: string;
  status: NearbyPeerStatus;
  statusLabel: string;
  detail: string;
  latencyMs?: number;
  isProbing: boolean;
}

export type NearbyStatusTone = 'neutral' | 'accent' | 'success' | 'warning';

export interface NearbyStatusPresentation {
  label: string;
  detail: string;
  icon: 'radio-outline' | 'wifi-outline' | 'checkmark-circle' | 'alert-circle-outline';
  tone: NearbyStatusTone;
}

const count = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

export const createNearbyMessagingSnapshot = (
  available: boolean,
  now: number = Date.now(),
): NearbyMessagingSnapshot => ({
  status: available ? 'idle' : 'unavailable',
  connectedPeerCount: 0,
  discoveredPeerCount: 0,
  connectingPeerCount: 0,
  discoveredDeviceIds: [],
  connectingDeviceIds: [],
  connectedDeviceIds: [],
  pairingDeviceIds: [],
  pairingEnabled: false,
  probingDeviceIds: [],
  peerLatencyMs: {},
  trustedPeers: {},
  ignoredPeerCount: 0,
  lastChangedAt: now,
});

const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];

export const applyNearbyMeshState = (
  current: NearbyMessagingSnapshot,
  event: MeshStateEvent,
  now: number = Date.now(),
): NearbyMessagingSnapshot => {
  const connectedDeviceIds = ids(event.connectedDeviceIds);
  const connectingDeviceIds = ids(event.connectingDeviceIds)
    .filter((id) => !connectedDeviceIds.includes(id));
  const discoveredDeviceIds = ids(event.discoveredDeviceIds);
  const knownDeviceIds = [...new Set([
    ...discoveredDeviceIds,
    ...connectingDeviceIds,
    ...connectedDeviceIds,
  ])];
  const probingDeviceIds = ids(event.probingDeviceIds)
    .filter((id) => connectedDeviceIds.includes(id));
  const pairingDeviceIds = ids(event.pairingDeviceIds)
    .filter((id) => connectedDeviceIds.includes(id));
  const peerLatencyMs = Object.fromEntries(
    Object.entries(event.peerLatencyMs ?? {})
      .filter(([id, latency]) =>
        connectedDeviceIds.includes(id)
        && Number.isFinite(latency)
        && latency >= 0,
      )
      .map(([id, latency]) => [id, Math.floor(latency)]),
  );
  const connectedPeerCount = Math.max(
    count(event.connectedPeerCount),
    connectedDeviceIds.length,
  );

  return {
    status: event.status,
    connectedPeerCount,
    discoveredPeerCount: Math.max(count(event.discoveredPeerCount), knownDeviceIds.length),
    connectingPeerCount: Math.max(count(event.connectingPeerCount), connectingDeviceIds.length),
    discoveredDeviceIds: knownDeviceIds,
    connectingDeviceIds,
    connectedDeviceIds,
    pairingDeviceIds,
    pairingEnabled: event.pairingEnabled === true,
    probingDeviceIds,
    peerLatencyMs,
    trustedPeers: current.trustedPeers,
    ignoredPeerCount: count(event.ignoredPeerCount ?? 0),
    ...(current.lastMessageEvent ? { lastMessageEvent: current.lastMessageEvent } : {}),
    ...(typeof event.errorCode === 'number' ? { errorCode: event.errorCode } : {}),
    ...(typeof event.errorMessage === 'string' && event.errorMessage.length > 0
      ? { errorMessage: event.errorMessage }
      : {}),
    lastChangedAt: now,
  };
};

export const getNearbyPeerPresentations = (
  snapshot: NearbyMessagingSnapshot,
): NearbyPeerPresentation[] => {
  const connected = new Set(snapshot.connectedDeviceIds);
  const connecting = new Set(snapshot.connectingDeviceIds);
  const probing = new Set(snapshot.probingDeviceIds);
  const deviceIds = [...new Set([
    ...snapshot.discoveredDeviceIds,
    ...snapshot.connectingDeviceIds,
    ...snapshot.connectedDeviceIds,
  ])].sort();

  return deviceIds.map((deviceId) => {
    const trusted = snapshot.trustedPeers[deviceId];
    const status: NearbyPeerStatus = connected.has(deviceId)
      ? 'connected'
      : connecting.has(deviceId)
        ? 'connecting'
        : 'found';
    // Never expose an installation UUID/tail as a human identity. Native
    // discovery carries only the opaque installation id; the visible profile
    // name is resolved locally after that id matches the cached trust map.
    const label = trusted?.label ?? 'Recognized ManaSplit contact';
    const relationship = trusted?.relationship === 'direct'
      ? 'Direct-chat contact'
      : trusted?.relationship === 'shared-group'
        ? 'Shared-group member'
        : trusted?.relationship === 'paired'
          ? 'Explicitly paired phone'
          : 'Cached conversation member';
    const latencyMs = snapshot.peerLatencyMs[deviceId];
    if (status === 'connected') {
      return {
        deviceId,
        label,
        status,
        statusLabel: 'Connected',
        detail: latencyMs === undefined
          ? `${relationship} · private link`
          : `${relationship} · ${latencyMs} ms`,
        ...(latencyMs === undefined ? {} : { latencyMs }),
        isProbing: probing.has(deviceId),
      };
    }
    if (status === 'connecting') {
      return {
        deviceId,
        label,
        status,
        statusLabel: 'Securing…',
        detail: `Verifying ${relationship.toLowerCase()}`,
        isProbing: false,
      };
    }
    return {
      deviceId,
      label,
      status,
      statusLabel: 'Found',
      detail: `${relationship} · waiting for private link`,
      isProbing: false,
    };
  });
};

const peerLabel = (countValue: number): string =>
  `${countValue} ${countValue === 1 ? 'phone' : 'phones'}`;

export const getNearbyStatusPresentation = (
  snapshot: NearbyMessagingSnapshot,
): NearbyStatusPresentation => {
  switch (snapshot.status) {
    case 'connected':
      return {
        label: `Nearby · ${peerLabel(snapshot.connectedPeerCount)} connected`,
        detail: 'Only known conversation devices can use this private offline link.',
        icon: 'checkmark-circle',
        tone: 'success',
      };
    case 'connecting':
      return {
        label: 'Nearby · Connecting…',
        detail: `${peerLabel(Math.max(snapshot.connectingPeerCount, 1))} found. Keep ManaSplit open on both phones.`,
        icon: 'wifi-outline',
        tone: 'accent',
      };
    case 'searching':
      return {
        label: snapshot.discoveredPeerCount > 0
          ? `Nearby · ${peerLabel(snapshot.discoveredPeerCount)} known`
          : 'Nearby · Looking for known contacts',
        detail: 'Unknown nearby ManaSplit installations are ignored automatically.',
        icon: 'radio-outline',
        tone: 'accent',
      };
    case 'error':
      return {
        label: 'Nearby needs attention',
        detail: 'Check Local Network access and keep Wi-Fi and Bluetooth on, then try again.',
        icon: 'alert-circle-outline',
        tone: 'warning',
      };
    case 'idle':
      return {
        label: 'Nearby messaging ready',
        detail: 'Open ManaSplit on both phones to start discovery.',
        icon: 'radio-outline',
        tone: 'neutral',
      };
    case 'unavailable':
      return {
        label: 'Nearby messaging unavailable',
        detail: 'This build does not include the iPhone nearby transport.',
        icon: 'alert-circle-outline',
        tone: 'warning',
      };
  }
};
