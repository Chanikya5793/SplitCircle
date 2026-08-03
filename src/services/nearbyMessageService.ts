import {
  addNearbyStateChangedListener,
  isNearbyMeshAvailable,
  probeNearbyPeer as probeNativeNearbyPeer,
  restartNearbyDiscovery as restartNativeNearbyDiscovery,
  sendPreparedNearbyAttachment,
} from '../../modules/splitcircle-mesh';
import { getCurrentDeviceId } from '@/services/pairingService';
import { bleNeedsPermission, nativeBle } from '../../modules/splitcircle-ble';
import { nativeLan } from '../../modules/splitcircle-lan';
import { createBleTransport } from '@/services/mesh/bleTransport';
import { createLanTransport } from '@/services/mesh/lanTransport';
import { createMeshRouter } from '@/services/mesh/router';
import {
  isTransportEnabled,
  loadTransportPreferences,
  subscribeToTransportPreferences,
} from '@/services/mesh/transportPreferences';
import {
  MeshEventLog,
  aggregateNeighbours,
  type MeshDiagnostics,
} from '@/services/mesh/diagnostics';
import { BROADCAST_DEST, decodeRouterFrame } from '@/services/mesh/routerFrame';
import { createMpcTransport } from '@/services/mesh/mpcTransport';
import type { MeshTransport, PayloadClass, TransportId } from '@/services/mesh/transport';
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
 * Minimum gap before the same queued operation is re-broadcast.
 *
 * Gossip needs each message to reach a peer that lacks it, not to reach the
 * same peer every few seconds. Long enough that a stalled queue stops
 * saturating the radio, short enough that a genuinely undelivered message is
 * retried well within a conversation.
 */
const MESH_REBROADCAST_COOLDOWN_MS = 60_000;

/**
 * How often to re-attempt a transport that is enabled but not running.
 *
 * Cheap: when everything that should be running is running, the tick does
 * nothing but a filter over at most three entries.
 */
const TRANSPORT_RETRY_INTERVAL_MS = 15_000;

/** Bounded, newest-first. Replaces the single overwritable event slot. */
const meshEvents = new MeshEventLog();

/**
 * The transport layer (doc 33 Phase 0). MultipeerConnectivity always, plus BLE
 * (Phase 3) when the flag below is on. Every send and every reachability signal
 * goes through the switch rather than straight at the native module, which is
 * what made adding BLE a registration rather than a rewrite of this file — and
 * what will make LAN (Phase 5) the same.
 *
 * Deliberately NOT covered by the switch yet, because the contract does not
 * model them: attachment resource transfer and the pairing handshake are both
 * MPC-specific APIs and stay on direct native calls until Phase 5/6 give them
 * transport-agnostic shapes. Mixing them in now would mean inventing an
 * interface for a transport that does not exist.
 */
/**
 * BLE is OFF unless explicitly enabled (doc 33 Phase 3). Both native halves
 * compile but neither has touched a radio, and this file is the live nearby
 * send path on a mesh that already carries several changes proven only by
 * unit tests. The flag is what makes it testable on two phones without
 * betting the working transport on it.
 *
 * `EXPO_PUBLIC_` so it inlines at bundle time and can be flipped by a rebuild
 * without a code change. Remove the flag once §9.6's device verification
 * passes — a permanent flag is a permanently untested branch.
 */
const BLE_MESH_ENABLED = ['1', 'true'].includes(
  (process.env.EXPO_PUBLIC_ENABLE_BLE_MESH ?? '').trim().toLowerCase(),
);

/**
 * LAN (doc 33 Phase 5), OFF unless enabled. Same staged-rollout rule as BLE:
 * both native halves compile, neither has moved a byte on a real network.
 */
const LAN_MESH_ENABLED = ['1', 'true'].includes(
  (process.env.EXPO_PUBLIC_ENABLE_LAN_MESH ?? '').trim().toLowerCase(),
);

const mpcTransport = createMpcTransport();
const bleTransport = BLE_MESH_ENABLED ? createBleTransport(nativeBle) : null;
const lanTransport = LAN_MESH_ENABLED ? createLanTransport(nativeLan) : null;

/**
 * Lifecycle, trust and reachability fan out across all of these; sends go
 * through the switch below. MPC stays FIRST and stays authoritative for the
 * user-visible nearby status — see `startNearbyMessaging`, where BLE is
 * best-effort and a BLE failure cannot degrade a working MPC mesh.
 */
// MPC stays FIRST and authoritative for the user-visible nearby status; the
// switch's own PREFERENCE order (mpc, lan, ble) decides what actually carries
// a given payload.
const activeTransports: MeshTransport[] = [
  mpcTransport,
  ...(lanTransport ? [lanTransport] : []),
  ...(bleTransport ? [bleTransport] : []),
];

const transports = createTransportSwitch(activeTransports);

/**
 * Puts opaque bytes on every transport that can carry them, and reports how
 * many peers took them.
 *
 * The lowest rung: it knows nothing about envelopes or routing, which is what
 * lets both the direct path and the router share it. Every capable transport
 * is ATTEMPTED with the full recipient list rather than a JS-side reachability
 * guess — filtering here against a cached neighbour list skipped sends
 * outright before the first state event populated it.
 */
const sendRawToTransports = async (
  raw: string,
  to: string[],
  payloadClass: PayloadClass,
): Promise<number> => {
  let reached = 0;
  for (const transport of transports.capableOf(payloadClass, raw.length)) {
    const outcome = await transport.send({ data: raw, payloadClass }, to);
    if (outcome.ok) reached += outcome.deliveredCount;
  }
  return reached;
};

/**
 * Multi-hop routing (doc 33 Phase 4), OFF by default.
 *
 * Separate from the BLE flag because the risk is different in kind. BLE is
 * additive and invisible to peers; the router puts a header on every frame, so
 * a device that originates them cannot be understood by a device that does not
 * know about them. RECEIVING is always on and always safe — a bare envelope
 * fails `decodeRouterFrame` and takes the pre-existing path — so this flag
 * gates ORIGINATION only, which is the half that can break a working device.
 *
 * Turn on only when every device in the test set is running this build.
 */
const MESH_ROUTER_ENABLED = ['1', 'true'].includes(
  (process.env.EXPO_PUBLIC_ENABLE_MESH_ROUTER ?? '').trim().toLowerCase(),
);

/** Resolved during startNearbyMessaging; the router reads it lazily. */
let localNodeId = '';

const router = createMeshRouter({
  localNodeId: () => localNodeId,
  // Deduped across transports: the same phone reachable over both MPC and BLE
  // is one node, and forwarding to it twice is pure waste.
  neighbours: () => [...new Set(transports.neighbours().map((n) => n.nodeId))],
  send: (encoded, to, payloadClass) => sendRawToTransports(encoded, to, payloadClass),
});

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
  msgId: string,
): Promise<number> => {
  if (!MESH_ROUTER_ENABLED) {
    return sendRawToTransports(envelope, recipientDeviceIds, 'text');
  }
  // One recipient is a unicast the mesh can relay hop by hop; several is a
  // group, which floods. Both keep the payload sealed per device — a relay
  // carries bytes it cannot read.
  const result = await router.originate({
    msgId,
    payload: envelope,
    dest: recipientDeviceIds.length === 1 ? recipientDeviceIds[0] : BROADCAST_DEST,
    payloadClass: 'text',
  });
  return result.delivered;
};
// Availability across EVERY registered transport, not just MPC (doc 35,
// critical #1). Seeding this from `isNearbyMeshAvailable()` — an
// iOS-only MultipeerConnectivity probe — made the initial snapshot report
// "nearby unavailable" on every Android device even with BLE and LAN
// registered and usable.
let nearbySnapshot = createNearbyMessagingSnapshot(
  activeTransports.some((transport) => transport.isAvailable()),
);
const nearbyStateListeners = new Set<() => void>();

/**
 * Records which nodes one transport can currently reach.
 *
 * Kept per transport rather than as one merged list so a transport going quiet
 * clears only its own peers — a single list would need to know which entries
 * came from where in order to remove them, and would either strand dead peers
 * or wipe live ones.
 */
const publishTransportPeers = (id: TransportId, nodeIds: string[]): void => {
  const previous = nearbySnapshot.transportPeers?.[id] ?? [];
  const unchanged =
    previous.length === nodeIds.length && previous.every((nodeId) => nodeIds.includes(nodeId));
  if (unchanged) return;

  const transportPeers = {
    ...(nearbySnapshot.transportPeers ?? { mpc: [], ble: [], lan: [] }),
    [id]: nodeIds,
  };
  const reachable = new Set(Object.values(transportPeers).flat());

  // A transport reporting peers means nearby is genuinely working, whatever the
  // MPC-driven status last said. Only PROMOTE from here — an empty BLE list must
  // not overwrite a live MPC 'connected'.
  const status = reachable.size > 0 && nearbySnapshot.status !== 'connected'
    ? 'connected'
    : nearbySnapshot.status;

  publishNearbySnapshot({
    ...nearbySnapshot,
    transportPeers,
    status,
    lastChangedAt: Date.now(),
  });
};

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
  activeTransports.forEach((transport) => transport.updateTrust(Object.keys(trustedPeers)));
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
  activeTransports.forEach((transport) => transport.updateTrust(Object.keys(trustedPeers)));
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
  const at = event.at ?? Date.now();
  // Also into the bounded log (doc 33 §4.1). `lastMessageEvent` is a single
  // slot overwritten by the next event, so it can only ever be seen by someone
  // already staring at the sheet at that instant — useless for diagnosing a
  // mesh, which is why every hard bug here was diagnosed from server logs
  // instead of from the app.
  meshEvents.push({
    at,
    kind: event.type === 'sent' ? 'sent' : event.type === 'received' ? 'received' : 'info',
    detail: event.detail,
    chatId: event.chatId,
    peerCount: event.peerCount,
  });
  publishNearbySnapshot({
    ...nearbySnapshot,
    lastMessageEvent: { ...event, at },
  });
};

/**
 * Everything the diagnostics/topology screen needs, assembled on demand.
 *
 * Read live rather than pushed into the snapshot: neighbour state changes far
 * more often than the UI needs to redraw, and threading it through the snapshot
 * would re-render every subscriber on each radio event.
 */
export const getMeshDiagnostics = async (): Promise<MeshDiagnostics> => {
  const queue = await loadMeshMessageQueue().catch(() => []);
  return {
    transports: activeTransports.map((transport) => ({
      id: transport.id,
      available: transport.isAvailable(),
      neighbourCount: transport.neighbours().filter((n) => n.connected).length,
      // BLE is the only transport with a queryable consent state on either
      // platform. Local Network has no such API on iOS at all — Apple provides
      // none — which is why a denial there is inferred from the listener's
      // `.waiting(PolicyDenied)` state instead.
      ...(transport.id === 'ble' ? { needsPermission: bleNeedsPermission() } : {}),
    })),
    neighbours: aggregateNeighbours(transports.neighbours(), nearbySnapshot.trustedPeers),
    queuedMessages: queue.filter((operation) => Boolean(operation.wireEnvelope)).length,
    routerPending: router.pendingCount(),
    bleEnabled: BLE_MESH_ENABLED,
    lanEnabled: LAN_MESH_ENABLED,
    routerEnabled: MESH_ROUTER_ENABLED,
    events: meshEvents.list(),
  };
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
    const now = Date.now();
    for (const operation of operations) {
      if (!operation.wireEnvelope) continue;
      // REBROADCAST COOLDOWN. This runs on every neighbour change and every
      // offline send, and re-broadcasts the ENTIRE queue each time. With a
      // queue that is not draining — a cloud relay that exhausted its retries
      // leaves operations behind permanently, and nothing else removes them —
      // that is the whole backlog on the air every few seconds, every entry
      // emitting its own "handed to N phones" event. Observed on an iPhone:
      // 102 queued messages replaying continuously.
      //
      // Gossip only needs each message to reach a peer that does not have it
      // yet, and a peer that just received one does not need it again seconds
      // later. Anything genuinely undelivered is still retried, just not at
      // the rate of the loop that discovers it.
      if (
        operation.meshBroadcastAt !== undefined
        && now - operation.meshBroadcastAt < MESH_REBROADCAST_COOLDOWN_MS
      ) {
        continue;
      }
      try {
        const parsed = parseSignedMeshEnvelope(operation.wireEnvelope);
        const recipientDeviceIds = operation.recipientDeviceIds
          ?? (parsed ? Object.keys(parsed.body.encryptedForDevices) : []);
        if (recipientDeviceIds.length === 0) continue;
        const sent = await sendEnvelopeViaTransports(
          operation.wireEnvelope,
          recipientDeviceIds,
          // The mesh operation id is already the cross-hop dedup key
          // (claimMeshMessageProcessing), so reuse it rather than minting a
          // second identity for the same message.
          operation.id,
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
  // NOT gated on isNearbyMeshAvailable() any more (doc 35, critical #1).
  //
  // That function is `Platform.OS === 'ios' ? requireOptionalNativeModule(...)
  // : null` — it probes the MULTIPEERCONNECTIVITY module specifically, so on
  // Android it is unconditionally false. Returning here meant this function
  // exited before loadTransportPreferences(), getCurrentDeviceId(), and every
  // transport's start(), so BLE and LAN — the only transports that can reach
  // Android at all (doc 33 §0) — never ran on the one platform they exist for.
  // Their runtime permission requests, GATT handshake and NSD/TCP stacks were
  // unreachable from the app's real entry point regardless of any flag or
  // Settings toggle.
  //
  // The diagnostics screen hid this: `transport.isAvailable()` reports HARDWARE
  // capability (adapter present and enabled), which is true whether or not
  // start() was ever called — so "Bluetooth: available, 0 connected" was
  // truthful about the radio and silent about the service never having started.
  //
  // Nothing needs this guard: every transport's own start() already returns
  // false when its native half is missing, and the MPC-specific calls below
  // (configureNearbyPairing / addNearbyStateChangedListener) are individually
  // no-ops or guarded. Bail only when there is genuinely nothing to run.
  if (activeTransports.length === 0) {
    publishNearbySnapshot(createNearbyMessagingSnapshot(false));
    return () => undefined;
  }

  // Load before any transport starts: the switch consults these synchronously,
  // so an unloaded snapshot would let a radio the user disabled run until the
  // read completed.
  await loadTransportPreferences();
  const deviceId = await getCurrentDeviceId();
  // The router is a module-level singleton but its identity only exists now.
  localNodeId = deviceId;
  configureNearbyPairing({
    userId,
    deviceId,
    displayName,
    handlePaired: addPairedNearbyPeer,
  });
  // Per transport, not per native module: an envelope means the same thing
  // whichever radio carried it, and a frame arriving over BLE has to reach the
  // same handler or it is received and silently discarded.
  const deliverEnvelope = (envelope: string, peerDeviceId: string): void => {
    if (!handleNearbyPairingEnvelope(envelope, peerDeviceId)) {
      onEnvelope(envelope, peerDeviceId);
    }
  };

  const envelopeSubscriptions = activeTransports.map((transport) =>
    transport.onFrame((raw, peerDeviceId) => {
      // RECEIVING both formats is always on, regardless of the router flag —
      // that is what makes the rollout survivable (doc 33 §10.3). A bare
      // envelope fails `decodeRouterFrame` and takes the pre-existing path
      // unchanged, so a device running this build understands one that is not.
      if (!decodeRouterFrame(raw)) {
        deliverEnvelope(raw, peerDeviceId);
        return;
      }
      void router.accept(raw, peerDeviceId).then((outcome) => {
        // 'relay' deliberately carries no payload: this node forwarded bytes it
        // cannot read and has nothing to hand the local delivery path.
        if (outcome.action === 'deliver') deliverEnvelope(outcome.payload, peerDeviceId);
      });
    }),
  );
  // Reachability now comes from the transport, not the native module directly.
  // The MPC adapter subscribes to BOTH native events behind this, because
  // onStateChanged carries peer identities while onPeersChanged is the one that
  // fires on a pure trust promotion — listening to only one is the doc 32 §5f
  // defect where a newly reachable peer's queued messages sat unsent.
  const peerSubscriptions = activeTransports.map((transport) =>
    transport.onNeighbourChange((neighbours) => {
      // PUBLISH IT. This callback previously fired side effects only, so the
      // user-visible snapshot was fed exclusively by
      // `addNearbyStateChangedListener` — an MPC-only native event. On Android
      // MPC never emits, so every nearby surface in the app reported zero peers
      // and "Looking for known contacts" while BLE or LAN was actively
      // connected and carrying messages. Two phones both showing the same
      // never-changing status, with no way to tell a working mesh from a dead
      // one, is exactly that.
      publishTransportPeers(
        transport.id,
        neighbours.filter((neighbour) => neighbour.connected).map((neighbour) => neighbour.nodeId),
      );
      if (neighbours.length > 0) {
        void announceIncomingNearbyAttachmentProgress();
        void broadcastQueuedNearbyMessages();
        // Store-and-forward's only trigger: a frame held for an unreachable
        // destination is retried when the topology changes, which is exactly
        // when a route to it can appear.
        void router.flush();
      }
    }),
  );
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
  // EVERY transport is started, and availability reflects whether ANY of them
  // came up — not whether MPC did (doc 35, critical #1).
  //
  // Previously MPC's result alone drove the snapshot, so on Android — where MPC
  // can never start — the UI reported "nearby unavailable" even with BLE and
  // LAN running. A radio failing to start is an ordinary state on a phone (off,
  // permission denied, no network) and must not condemn the others.
  //
  // console.error, not warn: a Release bundle drops console.warn entirely
  // (CLAUDE.md), and a transport that silently never starts is precisely what
  // needs to be diagnosable here — this whole finding existed because nothing
  // reported it.
  // A DISABLED TRANSPORT MUST NOT RUN ITS RADIO (doc 35, high #1).
  //
  // `isTransportEnabled` was previously consulted in exactly one place: the
  // switch's `available()` gate, which only decides which transport carries a
  // NEW outbound send. Nothing ever stopped — or declined to start — a running
  // transport. So a user who turned "Nearby messaging" off in Settings still
  // had every radio advertising, scanning, accepting inbound frames and, with
  // the router on, RELAYING other people's traffic, while the UI said "Off".
  // That is a broken privacy promise, not a cosmetic bug, and it is worse on
  // the individual toggles: "Bluetooth off" left BLE fully live.
  //
  // Enabled transports are started; disabled ones are skipped outright rather
  // than started-then-stopped, so a radio the user has already refused never
  // comes up even briefly.
  /**
   * Flips availability WITHOUT resetting the rest of the snapshot.
   *
   * `createNearbyMessagingSnapshot` builds a fresh one, which zeroes
   * `trustedPeers` — correct at module load, wrong once running. The block
   * above went out of its way to preserve the offline identity allowlist across
   * a start, and then the "no transport started" branch below threw it away
   * again; nothing re-populates it until the next pairing event, so the user's
   * paired peers simply vanished on any device where every radio was off. The
   * same reset on a Settings toggle would have lost them on every off/on cycle.
   */
  const publishAvailability = (available: boolean): void => {
    if (available === (nearbySnapshot.status !== 'unavailable')) return;
    publishNearbySnapshot({
      ...nearbySnapshot,
      status: available ? 'idle' : 'unavailable',
      connectedPeerCount: available ? nearbySnapshot.connectedPeerCount : 0,
      connectedDeviceIds: available ? nearbySnapshot.connectedDeviceIds : [],
      discoveredPeerCount: available ? nearbySnapshot.discoveredPeerCount : 0,
      discoveredDeviceIds: available ? nearbySnapshot.discoveredDeviceIds : [],
      connectingPeerCount: available ? nearbySnapshot.connectingPeerCount : 0,
      connectingDeviceIds: available ? nearbySnapshot.connectingDeviceIds : [],
      lastChangedAt: Date.now(),
    });
  };

  const runningTransports = new Set<TransportId>();

  /**
   * `quiet` exists because the retry below runs every 15s forever.
   *
   * A phone with Bluetooth switched off would otherwise log an error on every
   * tick for the life of the session — the exact log-saturation this codebase
   * has already been burned by (CLAUDE.md: a retry storm that produced 99.96%
   * of all JS output and saturated the JS thread). The FIRST attempt is loud,
   * because a transport failing at startup is genuinely diagnostic; the
   * repeats are not.
   */
  const startTransport = async (
    transport: MeshTransport,
    quiet = false,
  ): Promise<boolean> => {
    try {
      const ok = await transport.start({
        userId,
        deviceId,
        trustedDeviceIds: Object.keys(nearbySnapshot.trustedPeers),
      });
      if (ok) runningTransports.add(transport.id);
      else if (!quiet) {
        console.error(
          `⚠️ ${transport.id} transport did not start `
          + '(radio/network off, permission denied, or unavailable on this platform)',
        );
      }
      return ok;
    } catch (error) {
      if (!quiet) console.error(`⚠️ ${transport.id} transport threw while starting`, error);
      return false;
    }
  };

  const startResults = await Promise.all(
    activeTransports.map((transport) =>
      (isTransportEnabled(transport.id) ? startTransport(transport) : Promise.resolve(false))),
  );

  if (!startResults.some(Boolean)) publishAvailability(false);
  void broadcastQueuedNearbyMessages();

  // Reconcile on every preference change, in both directions. Toggling nearby
  // off and back on must bring the radios back without restarting the app.
  let reconciling = false;
  const applyPreferences = (): void => {
    // `stop()` can itself emit a state change; without this a re-entrant call
    // could observe a half-applied `runningTransports` and double-start.
    if (reconciling) return;
    reconciling = true;
    try {
      for (const transport of activeTransports) {
        const wanted = isTransportEnabled(transport.id);
        if (wanted === runningTransports.has(transport.id)) continue;
        if (wanted) {
          void startTransport(transport).then((ok) => {
            if (ok) publishAvailability(true);
          });
        } else {
          transport.stop();
          runningTransports.delete(transport.id);
        }
      }
      publishAvailability(runningTransports.size > 0);
    } finally {
      reconciling = false;
    }
  };
  const unsubscribePreferences = subscribeToTransportPreferences(applyPreferences);

  // A TRANSPORT THAT COULD NOT START MUST BE RE-ATTEMPTED.
  //
  // Every reason a radio declines to start is temporary and user-controlled:
  // Bluetooth switched off, no Wi-Fi yet, an Android runtime grant not given,
  // an iOS prompt not yet answered. Nothing retried, so the state at the
  // instant of launch decided the whole session — turn Bluetooth on five
  // seconds after opening the app and nearby stayed dark until a full restart,
  // with the UI reporting the radio as available the entire time.
  //
  // This is also what makes the permission prompts reachable at all on iOS:
  // the prompt appears when the native manager is constructed inside `start()`,
  // so a start that never happens is a prompt that never appears.
  //
  // Polled rather than event-driven because there is no cross-platform signal
  // for "the user just granted permission" or "Bluetooth came back" that
  // reaches JS — CBManager state changes and Android adapter broadcasts stay
  // native. 15s is slow enough to be free and fast enough that flipping a
  // switch in Settings and returning to the app just works.
  const retryTimer = setInterval(() => {
    const pending = activeTransports.filter(
      (transport) => isTransportEnabled(transport.id) && !runningTransports.has(transport.id),
    );
    if (pending.length === 0) return;
    void Promise.all(pending.map((transport) => startTransport(transport, true))).then((results) => {
      if (results.some(Boolean)) publishAvailability(true);
    });
  }, TRANSPORT_RETRY_INTERVAL_MS);

  return () => {
    clearInterval(retryTimer);
    cancelNearbyPairing();
    envelopeSubscriptions.forEach((unsubscribe) => unsubscribe());
    peerSubscriptions.forEach((unsubscribe) => unsubscribe());
    stateSubscription.remove();
    unsubscribePreferences();
    activeTransports.forEach((transport) => transport.stop());
    runningTransports.clear();
    publishNearbySnapshot(createNearbyMessagingSnapshot(true));
  };
};
