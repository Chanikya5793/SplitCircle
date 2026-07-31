import {
  addNearbyStateChangedListener,
  isNearbyMeshAvailable,
  probeNearbyPeer as probeNativeNearbyPeer,
  restartNearbyDiscovery as restartNativeNearbyDiscovery,
  sendPreparedNearbyAttachment,
} from '../../modules/splitcircle-mesh';
import { getCurrentDeviceId } from '@/services/pairingService';
import { createMpcTransport } from '@/services/mesh/mpcTransport';
import { createTransportSwitch } from '@/services/mesh/transportSwitch';
import {
  loadMeshMessageQueue,
  updateMeshMessage,
} from '@/services/meshMessageQueue';
import { updateMessageStatus } from '@/services/localMessageStorage';
import {
  applyNearbyMeshState,
  createNearbyMessagingSnapshot,
  type NearbyMessagingSnapshot,
  type NearbyMessageEvent,
} from '@/services/nearbyMessagingState';
import { announceIncomingNearbyAttachmentProgress } from '@/services/nearbyAttachmentService';
import { parseSignedMeshEnvelope } from '@/services/meshMessageProtocol';
import type { NearbyTrustedPeer } from '@/services/nearbyTrustService';
import type { PairedNearbyPeer } from '@/services/nearbyPairingTrustService';
import {
  cancelNearbyPairing,
  configureNearbyPairing,
  handleNearbyPairingEnvelope,
  handleNearbyPairingMeshState,
} from '@/services/nearbyPairingService';

let broadcastRunning = false;

/**
 * The transport layer (doc 33 Phase 0). One entry today — MultipeerConnectivity
 * — but every send and every reachability signal now goes through the switch
 * rather than straight at the native module, so adding BLE (Phase 3) or LAN
 * (Phase 5) is a registration rather than a rewrite of this file.
 *
 * Deliberately NOT covered by the switch yet, because the contract does not
 * model them: attachment resource transfer and the pairing handshake are both
 * MPC-specific APIs and stay on direct native calls until Phase 5/6 give them
 * transport-agnostic shapes. Mixing them in now would mean inventing an
 * interface for a transport that does not exist.
 */
const mpcTransport = createMpcTransport();
const transports = createTransportSwitch([mpcTransport]);

/**
 * Sends one envelope to whichever transports can currently reach the targets.
 *
 * Returns how many peers accepted the bytes, matching the count the native
 * call used to return — callers gate status updates and attachment sends on
 * `sent > 0`, so the semantics must not drift.
 *
 * Every capable transport is ATTEMPTED with the full recipient list rather
 * than a JS-side reachability guess. Filtering here against a cached neighbour
 * list skipped sends outright before the first state event populated it; the
 * transport knows who it can currently reach and this layer must not
 * second-guess that.
 */
const sendEnvelopeViaTransports = async (
  envelope: string,
  recipientDeviceIds: string[],
): Promise<number> => {
  let reached = 0;
  for (const transport of transports.capableOf('text', envelope.length)) {
    const outcome = await transport.send(
      { data: envelope, payloadClass: 'text' },
      recipientDeviceIds,
    );
    if (outcome.ok) reached += outcome.deliveredCount;
  }
  return reached;
};
let nearbySnapshot = createNearbyMessagingSnapshot(isNearbyMeshAvailable());
const nearbyStateListeners = new Set<() => void>();

const publishNearbySnapshot = (next: NearbyMessagingSnapshot): void => {
  nearbySnapshot = next;
  nearbyStateListeners.forEach((listener) => listener());
};

export const getNearbyMessagingSnapshot = (): NearbyMessagingSnapshot => nearbySnapshot;

export const subscribeToNearbyMessaging = (listener: () => void): (() => void) => {
  nearbyStateListeners.add(listener);
  return () => nearbyStateListeners.delete(listener);
};

export const setNearbyTrustedPeers = (
  peers: readonly NearbyTrustedPeer[],
): void => {
  const trustedPeers = Object.fromEntries(
    peers.map((peer) => [peer.deviceId, peer]),
  );
  publishNearbySnapshot({
    ...nearbySnapshot,
    trustedPeers,
    lastChangedAt: Date.now(),
  });
  mpcTransport.updateTrust(Object.keys(trustedPeers));
};

const addPairedNearbyPeer = (peer: PairedNearbyPeer): void => {
  const trustedPeers = {
    ...nearbySnapshot.trustedPeers,
    [peer.deviceId]: {
      deviceId: peer.deviceId,
      userId: peer.userId,
      label: peer.label,
      relationship: 'paired' as const,
      sharedChatCount: 0,
    },
  };
  publishNearbySnapshot({
    ...nearbySnapshot,
    trustedPeers,
    lastChangedAt: Date.now(),
  });
  mpcTransport.updateTrust(Object.keys(trustedPeers));
};

export const restartNearbyMessagingDiscovery = (): void => {
  if (!isNearbyMeshAvailable()) return;
  publishNearbySnapshot({
    ...nearbySnapshot,
    status: 'searching',
    errorCode: undefined,
    errorMessage: undefined,
    lastChangedAt: Date.now(),
  });
  restartNativeNearbyDiscovery();
};

export const testNearbyPeerConnection = (deviceId: string): boolean =>
  probeNativeNearbyPeer(deviceId);

export const reportNearbyMessageEvent = (
  event: Omit<NearbyMessageEvent, 'at'> & { at?: number },
): void => {
  publishNearbySnapshot({
    ...nearbySnapshot,
    lastMessageEvent: {
      ...event,
      at: event.at ?? Date.now(),
    },
  });
};

/**
 * Replays every still-live signed envelope whenever topology changes. Message
 * ids make receipt idempotent, so this also provides bounded gossip across a
 * partial mesh (A sees B, B sees C, but A cannot directly see C).
 */
export const broadcastQueuedNearbyMessages = async (): Promise<number> => {
  if (broadcastRunning) return 0;
  broadcastRunning = true;
  let totalRecipients = 0;
  try {
    const operations = await loadMeshMessageQueue();
    for (const operation of operations) {
      if (!operation.wireEnvelope) continue;
      try {
        const parsed = parseSignedMeshEnvelope(operation.wireEnvelope);
        const recipientDeviceIds = operation.recipientDeviceIds
          ?? (parsed ? Object.keys(parsed.body.encryptedForDevices) : []);
        if (recipientDeviceIds.length === 0) continue;
        const sent = await sendEnvelopeViaTransports(
          operation.wireEnvelope,
          recipientDeviceIds,
        );
        totalRecipients += sent;
        if (sent > 0) {
          reportNearbyMessageEvent({
            type: 'sent',
            detail: `Nearby message handed to ${sent} ${sent === 1 ? 'phone' : 'phones'}.`,
            peerCount: sent,
            chatId: operation.message.chatId,
          });
          await updateMeshMessage({ ...operation, meshBroadcastAt: Date.now() });
          if (operation.nearbyAttachment) {
            await sendPreparedNearbyAttachment(
              operation.nearbyAttachment.transferId,
              operation.nearbyAttachment.chunkCount,
              recipientDeviceIds,
            );
          } else if (operation.originOwned) {
            await updateMessageStatus(
              operation.message.chatId,
              operation.message.id,
              'sent',
            );
          }
        }
      } catch {
        // A peer can disappear between connectedPeerCount and send. The
        // durable queue is intentionally left untouched for the next topology
        // event.
      }
    }
    return totalRecipients;
  } finally {
    broadcastRunning = false;
  }
};

export const startNearbyMessaging = async (
  userId: string,
  displayName: string,
  onEnvelope: (envelope: string, peerDeviceId: string) => void,
): Promise<() => void> => {
  if (!isNearbyMeshAvailable()) {
    publishNearbySnapshot(createNearbyMessagingSnapshot(false));
    return () => undefined;
  }

  const deviceId = await getCurrentDeviceId();
  configureNearbyPairing({
    userId,
    deviceId,
    displayName,
    handlePaired: addPairedNearbyPeer,
  });
  const envelopeSubscription = mpcTransport.onFrame((envelope, peerDeviceId) => {
    if (!handleNearbyPairingEnvelope(envelope, peerDeviceId)) {
      onEnvelope(envelope, peerDeviceId);
    }
  });
  // Reachability now comes from the transport, not the native module directly.
  // The MPC adapter subscribes to BOTH native events behind this, because
  // onStateChanged carries peer identities while onPeersChanged is the one that
  // fires on a pure trust promotion — listening to only one is the doc 32 §5f
  // defect where a newly reachable peer's queued messages sat unsent.
  const peerSubscription = mpcTransport.onNeighbourChange((neighbours) => {
    if (neighbours.length > 0) {
      void announceIncomingNearbyAttachmentProgress();
      void broadcastQueuedNearbyMessages();
    }
  });
  const stateSubscription = addNearbyStateChangedListener((event) => {
    handleNearbyPairingMeshState(event);
    publishNearbySnapshot(applyNearbyMeshState(nearbySnapshot, event));
  });

  // Reset volatile carrier state without dropping the offline identity
  // allowlist that was deliberately prepared before this start call.
  const trustedPeers = nearbySnapshot.trustedPeers;
  publishNearbySnapshot({
    ...createNearbyMessagingSnapshot(true),
    status: 'searching',
    trustedPeers,
  });
  const started = await mpcTransport.start({
    userId,
    deviceId,
    trustedDeviceIds: Object.keys(trustedPeers),
  });
  if (!started) {
    publishNearbySnapshot(createNearbyMessagingSnapshot(false));
  }
  void broadcastQueuedNearbyMessages();

  return () => {
    cancelNearbyPairing();
    envelopeSubscription();
    peerSubscription();
    stateSubscription.remove();
    mpcTransport.stop();
    publishNearbySnapshot(createNearbyMessagingSnapshot(true));
  };
};
