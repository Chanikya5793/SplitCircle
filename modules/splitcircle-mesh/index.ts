import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

interface MeshEnvelopeEvent {
  envelope: string;
}

interface MeshPeerEvent {
  connectedPeerCount: number;
}

export type NativeNearbyMeshStatus =
  | 'idle'
  | 'searching'
  | 'connecting'
  | 'connected'
  | 'error';

export interface MeshStateEvent {
  status: NativeNearbyMeshStatus;
  connectedPeerCount: number;
  discoveredPeerCount: number;
  connectingPeerCount: number;
  discoveredDeviceIds?: string[];
  connectingDeviceIds?: string[];
  connectedDeviceIds: string[];
  probingDeviceIds?: string[];
  peerLatencyMs?: Record<string, number>;
  errorCode?: number;
  errorMessage?: string;
}

interface NativeMeshModule {
  start(userId: string, deviceId: string): Promise<boolean>;
  stop(): void;
  send(envelope: string): Promise<number>;
  connectedPeerCount(): number;
  restartDiscovery(): void;
  probePeer(deviceId: string): boolean;
  addListener(
    event: 'onEnvelope',
    listener: (payload: MeshEnvelopeEvent) => void,
  ): { remove: () => void };
  addListener(
    event: 'onPeersChanged',
    listener: (payload: MeshPeerEvent) => void,
  ): { remove: () => void };
  addListener(
    event: 'onStateChanged',
    listener: (payload: MeshStateEvent) => void,
  ): { remove: () => void };
}

const nativeModule =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<NativeMeshModule>('SplitCircleMesh')
    : null;

export const isNearbyMeshAvailable = (): boolean => nativeModule !== null;

export const startNearbyMesh = async (userId: string, deviceId: string): Promise<boolean> =>
  nativeModule?.start(userId, deviceId) ?? false;

export const stopNearbyMesh = (): void => nativeModule?.stop();

/** Returns the number of currently connected nearby peers that received it. */
export const broadcastNearbyEnvelope = async (envelope: string): Promise<number> =>
  nativeModule?.send(envelope) ?? 0;

export const getNearbyPeerCount = (): number => nativeModule?.connectedPeerCount() ?? 0;

export const restartNearbyDiscovery = (): void => nativeModule?.restartDiscovery();

/** Starts a link-local round-trip test for an already connected peer. */
export const probeNearbyPeer = (deviceId: string): boolean =>
  nativeModule?.probePeer(deviceId) ?? false;

export const addNearbyEnvelopeListener = (
  listener: (envelope: string) => void,
): { remove: () => void } =>
  nativeModule?.addListener('onEnvelope', ({ envelope }) => listener(envelope))
  ?? { remove: () => {} };

export const addNearbyPeersChangedListener = (
  listener: (connectedPeerCount: number) => void,
): { remove: () => void } =>
  nativeModule?.addListener(
    'onPeersChanged',
    ({ connectedPeerCount }) => listener(connectedPeerCount),
  ) ?? { remove: () => {} };

export const addNearbyStateChangedListener = (
  listener: (state: MeshStateEvent) => void,
): { remove: () => void } =>
  nativeModule?.addListener('onStateChanged', listener) ?? { remove: () => {} };
