/**
 * MultipeerConnectivity transport (ai_layer/docs/33 Phase 0).
 *
 * Adapts the existing `modules/splitcircle-mesh` native module to the
 * `MeshTransport` contract. This is a pure adapter: it adds no behaviour and
 * changes no wire format, so the live iOS path keeps working exactly as it
 * does today while the layers above are rewritten against the interface.
 *
 * MPC is Apple-only and always will be (doc 33 §0), so `isAvailable()` is
 * false on Android — which is the whole reason the interface exists.
 */
import {
  addNearbyEnvelopeListener,
  addNearbyPeersChangedListener,
  addNearbyStateChangedListener,
  broadcastNearbyEnvelope,
  isNearbyMeshAvailable,
  startNearbyMesh,
  stopNearbyMesh,
  updateNearbyTrustedPeers,
} from '../../../modules/splitcircle-mesh';
import type {
  MeshTransport,
  NeighbourState,
  NodeId,
  SendOutcome,
  TransportFrame,
  Unsubscribe,
} from './transport';

/**
 * MPC negotiates its own framing and handles large payloads via its resource
 * API, so this is a practical chunk size rather than a hard radio limit —
 * generous compared with BLE, which is the constraint that actually shapes
 * the frame format.
 */
const MPC_MTU = 60_000;

export const createMpcTransport = (): MeshTransport => {
  let neighbourCache: NeighbourState[] = [];

  /**
   * Rebuilt from the state event, which carries `connectedDeviceIds`. The
   * peer-count event alone cannot populate this — it reports a number, not
   * identities — so both native events feed the same cache.
   */
  const setNeighboursFromState = (event: unknown): NeighbourState[] => {
    const payload = (event ?? {}) as { connectedDeviceIds?: unknown; peerLatencyMs?: unknown };
    const ids = Array.isArray(payload.connectedDeviceIds)
      ? payload.connectedDeviceIds.filter((id): id is string => typeof id === 'string')
      : [];
    const latencies = (payload.peerLatencyMs ?? {}) as Record<string, unknown>;
    neighbourCache = ids.map((nodeId) => {
      const latency = latencies[nodeId];
      return {
        nodeId,
        transport: 'mpc' as const,
        connected: true,
        ...(typeof latency === 'number' ? { latencyMs: latency } : {}),
      };
    });
    return neighbourCache;
  };

  return {
    id: 'mpc',
    mtu: MPC_MTU,
    throughputClass: 'fast',

    isAvailable: () => isNearbyMeshAvailable(),

    start: async ({ userId, deviceId, trustedDeviceIds }) => {
      if (!isNearbyMeshAvailable()) return false;
      return startNearbyMesh(userId, deviceId, trustedDeviceIds);
    },

    stop: () => {
      neighbourCache = [];
      stopNearbyMesh();
    },

    updateTrust: (trustedDeviceIds: NodeId[]) => updateNearbyTrustedPeers(trustedDeviceIds),

    neighbours: () => neighbourCache,

    send: async (frame: TransportFrame, to: NodeId[]): Promise<SendOutcome> => {
      if (!isNearbyMeshAvailable()) return { ok: false, reason: 'unavailable' };
      if (to.length === 0) return { ok: false, reason: 'no-route' };
      try {
        const sent = await broadcastNearbyEnvelope(frame.data, to);
        // The native call reports how many peers it handed bytes to. That is a
        // TRANSPORT acknowledgement and nothing more: it does not mean the peer
        // decrypted, or even kept, the message. Conflating the two is exactly
        // the false-'sent' bug in doc 32 §10.1, so the outcome here stays
        // deliberately narrow and the router decides what to claim.
        if (typeof sent === 'number') {
          return sent > 0
            ? { ok: true, deliveredTo: to }
            : { ok: false, reason: 'no-route' };
        }
        return { ok: true, deliveredTo: to };
      } catch (error) {
        return { ok: false, reason: 'error', detail: String(error) };
      }
    },

    onFrame: (cb): Unsubscribe => {
      const sub = addNearbyEnvelopeListener((envelope, peerDeviceId) => cb(envelope, peerDeviceId));
      return () => sub.remove();
    },

    onNeighbourChange: (cb): Unsubscribe => {
      // BOTH native events are subscribed on purpose. `onStateChanged` carries
      // the identities; `onPeersChanged` is the one that fires on a pure
      // trust promotion. Listening to only one of them is precisely the doc 32
      // §5f defect, where a newly reachable peer never triggered a flush.
      const stateSub = addNearbyStateChangedListener((event) => cb(setNeighboursFromState(event)));
      const peerSub = addNearbyPeersChangedListener(() => cb(neighbourCache));
      return () => {
        stateSub.remove();
        peerSub.remove();
      };
    },
  };
};
