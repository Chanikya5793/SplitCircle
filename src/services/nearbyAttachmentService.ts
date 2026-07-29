/**
 * Durable coordinator for the native nearby attachment data plane.
 *
 * Native code owns file encryption/decryption and streams disk-backed chunks
 * through MultipeerConnectivity. JS persists only the signed manifest and
 * message identity; the small attachment secret is protected by SecureStore.
 * This lets a transfer survive an app restart without ever serializing media
 * bytes across the React Native bridge.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { ChatMessage } from '@/models';
import {
  addNearbyAttachmentListener,
  announceReceivedNearbyChunks,
  cancelNearbyAttachment,
  decryptReceivedNearbyAttachment,
  discardNearbyAttachment,
  getReceivedNearbyChunkIndexes,
  type NearbyAttachmentEvent,
} from '../../modules/splitcircle-mesh';
import type { MeshAttachmentManifest } from '@/services/meshMessageProtocol';
import {
  deleteMessageLocally,
  getChatMessages,
  saveMessageLocally,
  updateMessageStatus,
} from '@/services/localMessageStorage';
import { getLocalMediaPath } from '@/services/mediaService';
import {
  clearSendProgress,
  setSendFraction,
  setSendProgress,
} from '@/services/mediaSendProgress';
import {
  loadMeshMessageQueue,
  removeMeshMessage,
} from '@/services/meshMessageQueue';
import { MEDIA_MAX_FILE_SIZE_BYTES } from '@/services/mediaPolicy';

const INBOX_STORAGE_PREFIX = 'nearby_attachment_inbox_v1_';
const SECURE_KEY_PREFIX = 'nearby_attachment_secret_v1_';

export interface NearbyAttachmentSecret {
  transferId: string;
  keyBase64: string;
  nonceSeedBase64: string;
}

interface IncomingTransfer {
  transferId: string;
  ownerUserId: string;
  chatId: string;
  messageId: string;
  originDeviceId: string;
  manifest: MeshAttachmentManifest;
  createdAt: number;
}

const incomingTransfers = new Map<string, IncomingTransfer>();
const finalizingTransfers = new Set<string>();
const outgoingPeerProgress = new Map<string, Map<string, number>>();
let writeChain: Promise<void> = Promise.resolve();

const secureKey = (ownerUserId: string, transferId: string): string =>
  `${SECURE_KEY_PREFIX}${ownerUserId}_${transferId}`;

const inboxStorageKey = (ownerUserId: string): string =>
  `${INBOX_STORAGE_PREFIX}${ownerUserId}`;

const persistInbox = async (ownerUserId: string): Promise<void> => {
  const snapshot = [...incomingTransfers.values()].filter(
    (transfer) => transfer.ownerUserId === ownerUserId,
  );
  const storageKey = inboxStorageKey(ownerUserId);
  const next = async () => {
    if (snapshot.length === 0) {
      await AsyncStorage.removeItem(storageKey);
    } else {
      await AsyncStorage.setItem(storageKey, JSON.stringify(snapshot));
    }
  };
  writeChain = writeChain.then(next, next);
  await writeChain;
};

const hydrateInbox = async (ownerUserId: string): Promise<void> => {
  incomingTransfers.clear();
  try {
    const raw = await AsyncStorage.getItem(inboxStorageKey(ownerUserId));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return;
    for (const item of parsed as IncomingTransfer[]) {
      if (
        item
        && typeof item.transferId === 'string'
        && item.ownerUserId === ownerUserId
        && typeof item.chatId === 'string'
        && typeof item.messageId === 'string'
        && item.manifest?.transferId === item.transferId
      ) {
        incomingTransfers.set(item.transferId, item);
      }
    }
  } catch {
    // A corrupt progress cache must not affect ordinary chat startup.
  }
};

const loadSecret = async (
  ownerUserId: string,
  transferId: string,
): Promise<NearbyAttachmentSecret | null> => {
  try {
    const raw = await SecureStore.getItemAsync(secureKey(ownerUserId, transferId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NearbyAttachmentSecret;
    return parsed.transferId === transferId ? parsed : null;
  } catch {
    return null;
  }
};

const currentMessage = async (
  chatId: string,
  messageId: string,
): Promise<ChatMessage | null> => {
  const messages = await getChatMessages(chatId);
  return messages.find(
    (message) => message.id === messageId || message.messageId === messageId,
  ) ?? null;
};

const completeIncomingTransfer = async (
  transferId: string,
  onIncomingComplete?: () => void,
): Promise<boolean> => {
  const transfer = incomingTransfers.get(transferId);
  if (!transfer || finalizingTransfers.has(transferId)) return false;
  const received = await getReceivedNearbyChunkIndexes(transferId);
  const unique = new Set(received.filter(
    (index) => Number.isInteger(index)
      && index >= 0
      && index < transfer.manifest.chunkCount,
  ));
  setSendProgress(transfer.messageId, {
    stage: 'uploading',
    fraction: unique.size / transfer.manifest.chunkCount,
  });
  if (unique.size !== transfer.manifest.chunkCount) return false;

  finalizingTransfers.add(transferId);
  try {
    const secret = await loadSecret(transfer.ownerUserId, transferId);
    if (!secret) throw new Error('Nearby attachment key is unavailable.');
    const destinationUri = getLocalMediaPath(
      transfer.chatId,
      transfer.messageId,
      transfer.manifest.fileName,
    );
    const localMediaPath = await decryptReceivedNearbyAttachment({
      transferId,
      destinationUri,
      keyBase64: secret.keyBase64,
      nonceSeedBase64: secret.nonceSeedBase64,
      chunkHashes: transfer.manifest.chunkHashes,
      chunkCount: transfer.manifest.chunkCount,
    });
    const message = await currentMessage(transfer.chatId, transfer.messageId);
    if (!message) throw new Error('Nearby attachment message is unavailable.');
    await saveMessageLocally({
      ...message,
      localMediaPath,
      mediaDownloaded: true,
      status: 'delivered',
    });
    incomingTransfers.delete(transferId);
    await Promise.all([
      persistInbox(transfer.ownerUserId),
      SecureStore.deleteItemAsync(secureKey(transfer.ownerUserId, transferId)),
    ]);
    discardNearbyAttachment(transferId);
    clearSendProgress(transfer.messageId);
    onIncomingComplete?.();
    return true;
  } catch (error) {
    setSendProgress(transfer.messageId, {
      stage: 'failed',
      fraction: null,
    });
    console.warn('Nearby attachment finalization failed', error);
    return false;
  } finally {
    finalizingTransfers.delete(transferId);
  }
};

export const registerIncomingNearbyAttachment = async ({
  message,
  manifest,
  secret,
  originDeviceId,
  ownerUserId,
}: {
  message: ChatMessage;
  manifest: MeshAttachmentManifest;
  secret: NearbyAttachmentSecret;
  originDeviceId: string;
  ownerUserId: string;
}): Promise<void> => {
  if (
    secret.transferId !== manifest.transferId
    || manifest.fileSize < 0
    || manifest.fileSize > MEDIA_MAX_FILE_SIZE_BYTES
  ) {
    throw new Error('Nearby attachment manifest is invalid.');
  }
  incomingTransfers.set(manifest.transferId, {
    transferId: manifest.transferId,
    ownerUserId,
    chatId: message.chatId,
    messageId: message.messageId,
    originDeviceId,
    manifest,
    createdAt: Date.now(),
  });
  await SecureStore.setItemAsync(
    secureKey(ownerUserId, manifest.transferId),
    JSON.stringify(secret),
    { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY },
  );
  await persistInbox(ownerUserId);
  setSendProgress(message.messageId, { stage: 'uploading', fraction: 0 });
  const received = await getReceivedNearbyChunkIndexes(manifest.transferId);
  await announceReceivedNearbyChunks(
    manifest.transferId,
    received,
    originDeviceId,
  );
  await completeIncomingTransfer(manifest.transferId);
};

/** Re-announces durable receive ranges whenever a peer reconnects. */
export const announceIncomingNearbyAttachmentProgress = async (): Promise<void> => {
  for (const transfer of incomingTransfers.values()) {
    const received = await getReceivedNearbyChunkIndexes(transfer.transferId);
    await announceReceivedNearbyChunks(
      transfer.transferId,
      received,
      transfer.originDeviceId,
    );
  }
};

const handleOutgoingEvent = async (event: NearbyAttachmentEvent): Promise<void> => {
  const operations = await loadMeshMessageQueue();
  const operation = operations.find(
    (candidate) => candidate.nearbyAttachment?.transferId === event.transferId,
  );
  if (!operation?.originOwned) return;

  const peerId = event.peerDeviceId ?? 'nearby-peer';
  const peerProgress = outgoingPeerProgress.get(event.transferId) ?? new Map<string, number>();
  outgoingPeerProgress.set(event.transferId, peerProgress);

  if (event.state === 'progress') {
    if (!Number.isFinite(event.fraction)) return;
    peerProgress.set(peerId, Math.max(0, Math.min(1, event.fraction ?? 0)));
    const values = [...peerProgress.values()];
    setSendProgress(operation.message.messageId, {
      stage: 'uploading',
      fraction: values.reduce((sum, value) => sum + value, 0) / values.length,
      cancel: () => cancelNearbyAttachment(event.transferId),
    });
    return;
  }
  if (event.state === 'completed') {
    peerProgress.set(peerId, 1);
    if ([...peerProgress.values()].some((fraction) => fraction < 1)) return;
    await updateMessageStatus(
      operation.message.chatId,
      operation.message.messageId,
      'sent',
    );
    outgoingPeerProgress.delete(event.transferId);
    clearSendProgress(operation.message.messageId);
    return;
  }
  if (event.state === 'cancelled') {
    outgoingPeerProgress.delete(event.transferId);
    await Promise.all([
      removeMeshMessage(operation.id),
      deleteMessageLocally(
        operation.message.chatId,
        operation.message.messageId,
      ),
    ]);
    clearSendProgress(operation.message.messageId);
    return;
  }
  if (event.state === 'failed') {
    // The durable outbox will retry when topology changes. Keep a retryable
    // state rather than turning a transient disconnect into a permanent fail.
    setSendProgress(operation.message.messageId, {
      stage: 'sending',
      fraction: null,
    });
  }
};

export const startNearbyAttachmentHandling = async (
  ownerUserId: string,
  onIncomingComplete?: () => void,
): Promise<() => void> => {
  await hydrateInbox(ownerUserId);
  const subscription = addNearbyAttachmentListener((event) => {
    if (event.direction === 'outgoing') {
      void handleOutgoingEvent(event);
      return;
    }
    const transfer = incomingTransfers.get(event.transferId);
    if (!transfer) return;
    if (event.state === 'progress' && Number.isFinite(event.fraction)) {
      setSendFraction(
        transfer.messageId,
        Math.max(0, Math.min(1, event.fraction ?? 0)),
      );
    }
    if (event.state === 'chunk-received' || event.state === 'completed') {
      void completeIncomingTransfer(event.transferId, onIncomingComplete);
    }
    if (event.state === 'failed') {
      setSendProgress(transfer.messageId, {
        stage: 'sending',
        fraction: null,
      });
    }
  });

  for (const transferId of incomingTransfers.keys()) {
    void completeIncomingTransfer(transferId, onIncomingComplete);
  }
  return () => subscription.remove();
};
