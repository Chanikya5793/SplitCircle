import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

interface MeshEnvelopeEvent {
  envelope: string;
  peerDeviceId: string;
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
  pairingDeviceIds?: string[];
  pairingEnabled?: boolean;
  probingDeviceIds?: string[];
  peerLatencyMs?: Record<string, number>;
  ignoredPeerCount?: number;
  errorCode?: number;
  errorMessage?: string;
}

interface NativeMeshModule {
  start(userId: string, deviceId: string, trustedDeviceIds: string[]): Promise<boolean>;
  updateTrustedPeers(trustedDeviceIds: string[]): void;
  setPairingMode(enabled: boolean): void;
  stop(): void;
  send(envelope: string, recipientDeviceIds: string[]): Promise<number>;
  sendPairing(envelope: string, recipientDeviceIds: string[]): Promise<number>;
  prepareAttachment(
    sourceUri: string,
    transferId: string,
    chunkSize: number,
  ): Promise<PreparedNearbyAttachment>;
  sendPreparedAttachment(
    transferId: string,
    chunkCount: number,
    recipientDeviceIds: string[],
  ): Promise<number>;
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

export const startNearbyMesh = async (
  userId: string,
  deviceId: string,
  trustedDeviceIds: string[],
): Promise<boolean> =>
  nativeModule?.start(userId, deviceId, trustedDeviceIds) ?? false;

export const updateNearbyTrustedPeers = (trustedDeviceIds: string[]): void =>
  nativeModule?.updateTrustedPeers(trustedDeviceIds);

/**
 * Opens or closes the deliberately user-initiated admission window for
 * previously unknown installations. Pairing payloads use a separate bounded
 * native lane; chat envelopes and attachments remain blocked until JS has
 * completed the signed code ceremony and promoted the device to trusted.
 */
export const setNearbyPairingMode = (enabled: boolean): void =>
  nativeModule?.setPairingMode(enabled);

export const stopNearbyMesh = (): void => nativeModule?.stop();

/** Returns the number of currently connected nearby peers that received it. */
export const broadcastNearbyEnvelope = async (
  envelope: string,
  recipientDeviceIds: string[],
): Promise<number> =>
  nativeModule?.send(envelope, recipientDeviceIds) ?? 0;

export const sendNearbyPairingEnvelope = async (
  envelope: string,
  recipientDeviceIds: string[],
): Promise<number> =>
  nativeModule?.sendPairing(envelope, recipientDeviceIds) ?? 0;

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
  recipientDeviceIds: string[],
): Promise<number> =>
  nativeModule?.sendPreparedAttachment(
    transferId,
    chunkCount,
    recipientDeviceIds,
  ) ?? 0;

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
  listener: (envelope: string, peerDeviceId: string) => void,
): { remove: () => void } =>
  nativeModule?.addListener(
    'onEnvelope',
    ({ envelope, peerDeviceId }) => listener(envelope, peerDeviceId),
  )
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
