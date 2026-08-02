/**
 * BLE transport (ai_layer/docs/33 Phase 3) — the universal floor.
 *
 * BLE is the only link that exists on BOTH platforms with no infrastructure:
 * MultipeerConnectivity cannot reach Android at all (doc 33 §0), and the LAN
 * transport needs a shared network. It is also the slowest, so the switch
 * treats it as a last resort and refuses bulk payloads over it entirely.
 *
 * The native half is deliberately thin: connect to trusted peers, move opaque
 * chunk strings, report reachability. Fragmentation, reassembly, ordering and
 * bounds all live in `bleFraming.ts`, in one tested implementation, rather
 * than being written twice in Swift and Kotlin where they could drift.
 */
import {
  BleReassembler,
  BLE_MIN_USABLE_MTU,
  fragment,
} from './bleFraming';
import { MAX_MESH_ENVELOPE_BYTES } from './constants';
import type {
  MeshTransport,
  NeighbourState,
  NodeId,
  SendOutcome,
  TransportFrame,
  Unsubscribe,
} from './transport';

/** Peer as the native layer sees it. `mtu` is per-CONNECTION, not global. */
export interface NativeBlePeer {
  deviceId: NodeId;
  /** Negotiated ATT MTU for this link. Varies per peer and per connection. */
  mtu: number;
  rssi?: number;
}

/**
 * What each platform's native module must provide. Kept minimal on purpose —
 * every capability here has to be built twice, so anything that can live in
 * TypeScript does.
 */
export interface NativeBleModule {
  isAvailable(): boolean;
  start(params: { deviceId: NodeId; trustedDeviceIds: NodeId[] }): Promise<boolean>;
  stop(): void;
  updateTrust(trustedDeviceIds: NodeId[]): void;
  connectedPeers(): NativeBlePeer[];
  /** Resolves false when the write failed; must not throw for a lost peer. */
  sendChunk(peerDeviceId: NodeId, chunk: string): Promise<boolean>;
  addChunkListener(cb: (peerDeviceId: NodeId, chunk: string) => void): Unsubscribe;
  addPeersChangedListener(cb: (peers: NativeBlePeer[]) => void): Unsubscribe;
}

/**
 * Conservative default when a peer reports no negotiated MTU. The ATT default
 * is 23 with 3 bytes of protocol overhead; assuming more and being wrong means
 * writes silently rejected by the radio, which is far worse than being slow.
 */
const DEFAULT_ATT_MTU = 23;
const ATT_OVERHEAD = 3;

const usableMtuFor = (peer: NativeBlePeer): number =>
  Math.max(BLE_MIN_USABLE_MTU, (peer.mtu || DEFAULT_ATT_MTU) - ATT_OVERHEAD);

export const createBleTransport = (native: NativeBleModule): MeshTransport => {
  const reassembler = new BleReassembler();
  let peerCache: NativeBlePeer[] = [];

  /**
   * Subscribed ONCE at construction, not inside onNeighbourChange. Dropping a
   * departed peer's buffered chunks is a correctness requirement — otherwise a
   * reconnecting peer's fresh chunks splice onto stale ones and reassemble
   * into garbage — and it must not depend on whether some consumer happened to
   * subscribe to reachability.
   */
  native.addPeersChangedListener((peers) => {
    const stillHere = new Set(peers.map((p) => p.deviceId));
    for (const previous of peerCache) {
      if (!stillHere.has(previous.deviceId)) reassembler.forget(previous.deviceId);
    }
    peerCache = peers;
  });

  const toNeighbours = (peers: NativeBlePeer[]): NeighbourState[] =>
    peers.map((p) => ({
      nodeId: p.deviceId,
      transport: 'ble' as const,
      connected: true,
    }));

  return {
    id: 'ble',
    /**
     * Advertised as the pessimistic floor rather than any peer's negotiated
     * value: the switch uses this to decide what MAY travel here at all, and
     * that decision must hold for the worst link, not the best.
     */
    mtu: DEFAULT_ATT_MTU - ATT_OVERHEAD,
    /**
     * Far larger than `mtu` on purpose: `fragment()` splits any payload across
     * as many chunks as needed, so a 20-byte frame budget is not a 20-byte
     * message budget. Capped at the mesh envelope ceiling because BLE is slow
     * enough that anything bigger would take minutes and read as broken —
     * `throughputClass: 'slow'` separately bars bulk media entirely.
     */
    maxPayloadBytes: MAX_MESH_ENVELOPE_BYTES,
    throughputClass: 'slow',

    isAvailable: () => native.isAvailable(),

    start: async ({ deviceId, trustedDeviceIds }) => {
      if (!native.isAvailable()) return false;
      return native.start({ deviceId, trustedDeviceIds });
    },

    stop: () => {
      peerCache = [];
      native.stop();
    },

    updateTrust: (trustedDeviceIds: NodeId[]) => native.updateTrust(trustedDeviceIds),

    neighbours: () => toNeighbours(native.connectedPeers()),

    send: async (frame: TransportFrame, to: NodeId[]): Promise<SendOutcome> => {
      if (!native.isAvailable()) return { ok: false, reason: 'unavailable' };
      if (to.length === 0) return { ok: false, reason: 'no-route' };

      const connected = new Map(native.connectedPeers().map((p) => [p.deviceId, p]));
      let deliveredCount = 0;

      for (const target of to) {
        const peer = connected.get(target);
        // Unlike MPC, there is no native-side filter to fall back on: a BLE
        // write needs an established connection to a specific peripheral, so a
        // peer we hold no link to is genuinely unreachable right now. The
        // router stores and forwards it.
        if (!peer) continue;

        try {
          const chunks = fragment(frame.data, usableMtuFor(peer));
          let allWritten = true;
          for (const chunk of chunks) {
            // SEQUENTIAL, never Promise.all. Concurrent GATT writes to one
            // peripheral interleave or get dropped by the stack, and a partial
            // frame is unrecoverable — the receiver would buffer it until it
            // expires. Slower and correct beats faster and lossy.
            // eslint-disable-next-line no-await-in-loop
            const written = await native.sendChunk(target, chunk);
            if (!written) {
              allWritten = false;
              break;
            }
          }
          if (allWritten) deliveredCount += 1;
        } catch {
          // A peer can disappear mid-frame; that is ordinary on BLE. Keep
          // going for the others rather than failing the whole send.
        }
      }

      return deliveredCount > 0
        ? { ok: true, deliveredCount }
        : { ok: false, reason: 'no-route' };
    },

    onFrame: (cb): Unsubscribe =>
      native.addChunkListener((peerDeviceId, chunk) => {
        const complete = reassembler.accept(peerDeviceId, chunk);
        if (complete !== null) cb(complete, peerDeviceId);
      }),

    onNeighbourChange: (cb): Unsubscribe =>
      native.addPeersChangedListener((peers) => cb(toNeighbours(peers))),
  };
};
