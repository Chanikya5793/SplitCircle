import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

interface MeshEnvelopeEvent {
  envelope: string;
}

interface MeshPeerEvent {
  connectedPeerCount: number;
}

export interface PreparedNearbyAttachment {
  transferId: string;
  fileSize: number;
  chunkSize: number;
  chunkCount: number;
  chunkHashes: string[];
  encryptedChunkSizes: number[];
  keyBase64: string;
  nonceSeedBase64: string;
}

export interface NearbyAttachmentEvent {
  direction: 'incoming' | 'outgoing';
  state: 'progress' | 'chunk-received' | 'completed' | 'failed' | 'cancelled';
  transferId: string;
  peerDeviceId?: string;
  chunkIndex?: number;
  chunkCount?: number;
  fraction?: number;
  errorMessage?: string;
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
  prepareAttachment(
    sourceUri: string,
    transferId: string,
    chunkSize: number,
  ): Promise<PreparedNearbyAttachment>;
  sendPreparedAttachment(transferId: string, chunkCount: number): Promise<number>;
  cancelAttachment(transferId: string): void;
  discardAttachment(transferId: string): void;
  receivedChunkIndexes(transferId: string): Promise<number[]>;
  announceReceivedChunks(
    transferId: string,
    chunkIndexes: number[],
    originDeviceId: string,
  ): Promise<boolean>;
  decryptReceivedAttachment(
    transferId: string,
    destinationUri: string,
    keyBase64: string,
    nonceSeedBase64: string,
    chunkHashes: string[],
    chunkCount: number,
  ): Promise<string>;
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
  addListener(
    event: 'onAttachmentEvent',
    listener: (payload: NearbyAttachmentEvent) => void,
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

export const prepareNearbyAttachment = async (
  sourceUri: string,
  transferId: string,
  chunkSize = 1024 * 1024,
): Promise<PreparedNearbyAttachment> => {
  if (!nativeModule) {
    throw new Error('Nearby attachment transfer is unavailable in this build.');
  }
  return nativeModule.prepareAttachment(sourceUri, transferId, chunkSize);
};

export const sendPreparedNearbyAttachment = async (
  transferId: string,
  chunkCount: number,
): Promise<number> =>
  nativeModule?.sendPreparedAttachment(transferId, chunkCount) ?? 0;

export const cancelNearbyAttachment = (transferId: string): void =>
  nativeModule?.cancelAttachment(transferId);

export const discardNearbyAttachment = (transferId: string): void =>
  nativeModule?.discardAttachment(transferId);

export const getReceivedNearbyChunkIndexes = async (
  transferId: string,
): Promise<number[]> =>
  nativeModule?.receivedChunkIndexes(transferId) ?? [];

export const announceReceivedNearbyChunks = async (
  transferId: string,
  chunkIndexes: number[],
  originDeviceId: string,
): Promise<boolean> =>
  nativeModule?.announceReceivedChunks(
    transferId,
    chunkIndexes,
    originDeviceId,
  ) ?? false;

export const decryptReceivedNearbyAttachment = async ({
  transferId,
  destinationUri,
  keyBase64,
  nonceSeedBase64,
  chunkHashes,
  chunkCount,
}: {
  transferId: string;
  destinationUri: string;
  keyBase64: string;
  nonceSeedBase64: string;
  chunkHashes: string[];
  chunkCount: number;
}): Promise<string> => {
  if (!nativeModule) {
    throw new Error('Nearby attachment transfer is unavailable in this build.');
  }
  return nativeModule.decryptReceivedAttachment(
    transferId,
    destinationUri,
    keyBase64,
    nonceSeedBase64,
    chunkHashes,
    chunkCount,
  );
};

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

export const addNearbyAttachmentListener = (
  listener: (event: NearbyAttachmentEvent) => void,
): { remove: () => void } =>
  nativeModule?.addListener('onAttachmentEvent', listener) ?? { remove: () => {} };
