import type {
  MeshStateEvent,
  NativeNearbyMeshStatus,
} from '../../modules/splitcircle-mesh';
import type { NearbyTrustedPeer } from '@/services/nearbyTrustService';
import type { TransportId } from '@/services/mesh/transport';

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
  /**
   * Live reachability per transport, merged from EVERY transport's
   * `onNeighbourChange` — not just MultipeerConnectivity's native state events.
   *
   * The rest of this snapshot is fed by `applyNearbyMeshState`, which consumes
   * `addNearbyStateChangedListener` — an MPC-only event source. On Android MPC
   * never emits, so `connectedPeerCount` stayed 0 no matter how many peers were
   * connected over BLE or LAN, and every nearby surface in the app reported
   * "Looking for known contacts" while a link was actively carrying messages.
   * That is what made both phones show the same thing forever with no way to
   * tell a working mesh from a broken one.
   */
  transportPeers: Record<TransportId, string[]>;
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
  transportPeers: { mpc: [], ble: [], lan: [] },
  lastChangedAt: now,
});

/**
 * Every distinct node reachable right now, across all transports.
 *
 * Deduped: a phone reachable over both BLE and LAN is ONE peer. Counting links
 * would make a two-device test look like a three-device mesh, which is the
 * confusion `MeshNeighbourView` already exists to prevent one layer down.
 */
export const reachableNodeIds = (snapshot: NearbyMessagingSnapshot): string[] => [
  ...new Set([
    ...snapshot.connectedDeviceIds,
    ...Object.values(snapshot.transportPeers ?? {}).flat(),
  ]),
];

/** Transports with at least one peer, in the order the switch prefers them. */
export const liveTransports = (snapshot: NearbyMessagingSnapshot): TransportId[] =>
  (['mpc', 'lan', 'ble'] as const).filter(
    (id) => (snapshot.transportPeers?.[id]?.length ?? 0) > 0,
  );

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
    // Carried through untouched: this event is MPC's, and it knows nothing
    // about BLE or LAN reachability. Rebuilding it from the event would blank
    // every non-MPC peer on the next MPC state change.
    transportPeers: current.transportPeers ?? { mpc: [], ble: [], lan: [] },
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

/** Human name for a transport, as a route rather than a technology. */
const TRANSPORT_NAME: Record<TransportId, string> = {
  mpc: 'Apple Direct',
  lan: 'Wi-Fi',
  ble: 'Bluetooth',
};

/**
 * "over Wi-Fi", "over Bluetooth and Wi-Fi", or '' when nothing is live.
 *
 * Naming the ROUTE is the difference between a status the user can act on and
 * one they can only stare at: "connected" alone gave no way to tell a working
 * Bluetooth link from a working Wi-Fi one, so turning the wrong radio off
 * looked like a random failure.
 */
const routeSuffix = (snapshot: NearbyMessagingSnapshot): string => {
  const live = liveTransports(snapshot).map((id) => TRANSPORT_NAME[id]);
  if (live.length === 0) return '';
  if (live.length === 1) return ` over ${live[0]}`;
  return ` over ${live.slice(0, -1).join(', ')} and ${live[live.length - 1]}`;
};

export const getNearbyStatusPresentation = (
  snapshot: NearbyMessagingSnapshot,
): NearbyStatusPresentation => {
  // Transport reachability OUTRANKS the MPC-driven status field, because it is
  // the only source that knows about BLE and LAN. Without this an Android phone
  // with a live Bluetooth link still rendered whatever MPC last said, which is
  // nothing at all.
  const reachable = reachableNodeIds(snapshot);
  if (reachable.length > 0) {
    return {
      label: `Nearby · ${peerLabel(reachable.length)} connected`,
      detail: `Messages are going straight to ${reachable.length === 1 ? 'that device' : 'those devices'}${routeSuffix(snapshot)}, with no internet involved.`,
      icon: 'checkmark-circle',
      tone: 'success',
    };
  }

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
        label: 'Nearby messaging is off',
        // The old copy said "This build does not include the iPhone nearby
        // transport" — untrue on Android, where Bluetooth and Wi-Fi transports
        // exist, and unhelpful on iOS, where it blamed the build for what is
        // usually a switched-off radio or a denied permission.
        detail: 'Turn on Bluetooth or join a Wi-Fi network, and allow ManaSplit to find nearby devices.',
        icon: 'alert-circle-outline',
        tone: 'warning',
      };
  }
};
