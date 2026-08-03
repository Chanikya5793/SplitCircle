/**
 * LAN transport (ai_layer/docs/33 Phase 5) — the fast link.
 *
 * mDNS/Bonjour discovery plus a TCP stream. When two devices share a network
 * this is orders of magnitude faster than BLE, which is why the switch prefers
 * it and why it is the only transport allowed to carry `bulk` payloads.
 *
 * DIFFERENT SHAPE FROM BLE, deliberately. BLE has a ~20-500 byte MTU, so
 * `bleFraming` splits every frame and reassembles it. TCP is a reliable ordered
 * STREAM with no useful MTU — the problem is not size but boundaries, since a
 * stream gives no indication where one message ends. Framing is therefore
 * length-prefixed and lives in the NATIVE halves, which is the layer that owns
 * the socket buffer; JS receives whole frames only.
 *
 * That means no shared JS framing module here, and the Swift and Kotlin halves
 * must agree on exactly one thing: a 4-byte big-endian unsigned length followed
 * by that many UTF-8 bytes. It is small enough to state in one sentence and
 * verify by eye, unlike BLE's chunk headers.
 */
import type {
  MeshTransport,
  NeighbourState,
  NodeId,
  SendOutcome,
  TransportFrame,
  Unsubscribe,
} from './transport';

export interface NativeLanPeer {
  deviceId: NodeId;
  /** Dotted-quad or IPv6 literal, for diagnostics only. */
  address?: string;
}

/**
 * What each platform's native module must provide.
 *
 * Smaller than the BLE contract because TCP removes the hard parts: no MTU, no
 * chunking, no reassembly, no per-link negotiation.
 */
export interface NativeLanModule {
  isAvailable(): boolean;
  start(params: { deviceId: NodeId; trustedDeviceIds: NodeId[] }): Promise<boolean>;
  stop(): void;
  updateTrust(trustedDeviceIds: NodeId[]): void;
  connectedPeers(): NativeLanPeer[];
  /** Resolves false when the write failed; must not throw for a lost peer. */
  sendFrame(peerDeviceId: NodeId, frame: string): Promise<boolean>;
  addFrameListener(cb: (peerDeviceId: NodeId, frame: string) => void): Unsubscribe;
  addPeersChangedListener(cb: (peers: NativeLanPeer[]) => void): Unsubscribe;
}

/**
 * Advertised MTU. Not a real limit — TCP will carry anything — but the switch
 * needs a number, and a large one is what marks this as the transport that may
 * carry photos. `maxPayloadFor` treats `fast` transports as unbounded for bulk.
 */
const LAN_ADVERTISED_MTU = 64 * 1024;

/** Refuse absurd frames rather than buffering them into an OOM. */
const LAN_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export const createLanTransport = (native: NativeLanModule): MeshTransport => {
  const toNeighbours = (peers: NativeLanPeer[]): NeighbourState[] =>
    peers.map((peer) => ({
      nodeId: peer.deviceId,
      transport: 'lan' as const,
      connected: true,
    }));

  return {
    id: 'lan',
    mtu: LAN_ADVERTISED_MTU,
    /** TCP streams whatever it is given; the real bound is the frame cap. */
    maxPayloadBytes: LAN_MAX_FRAME_BYTES,
    throughputClass: 'fast',

    isAvailable: () => {
      try {
        return native.isAvailable();
      } catch {
        return false;
      }
    },

    /**
     * NO `isAvailable()` PRE-GATE — same reasoning as the BLE half, different
     * mechanism.
     *
     * iOS `isAvailable()` is `hasPath && !localNetworkDenied`, and `hasPath`
     * starts FALSE, set only by `NWPathMonitor`'s first asynchronous callback.
     * `startNearbyMessaging` runs at app launch and usually wins that race, so
     * this returned early, `NWListener`/`NWBrowser` were never created — and
     * starting them is what makes iOS show the Local Network prompt. Nothing
     * retried, so one lost race disabled LAN for the whole session.
     */
    start: async ({ deviceId, trustedDeviceIds }) => {
      try {
        return await native.start({ deviceId, trustedDeviceIds });
      } catch {
        // Local-network permission denial (iOS) arrives here. An ordinary
        // state, not a crash: the switch routes around a dead transport.
        return false;
      }
    },

    stop: () => {
      try {
        native.stop();
      } catch {
        // Teardown must never throw.
      }
    },

    updateTrust: (trustedDeviceIds: NodeId[]) => {
      try {
        native.updateTrust(trustedDeviceIds);
      } catch {
        // Refreshed on the next threads change.
      }
    },

    neighbours: () => {
      try {
        return toNeighbours(native.connectedPeers());
      } catch {
        return [];
      }
    },

    send: async (frame: TransportFrame, to: NodeId[]): Promise<SendOutcome> => {
      if (!native.isAvailable()) return { ok: false, reason: 'unavailable' };
      if (to.length === 0) return { ok: false, reason: 'no-route' };
      if (frame.data.length > LAN_MAX_FRAME_BYTES) {
        // Refusing loudly beats letting the native side buffer until the app
        // is killed. Nothing this app sends should approach this.
        return { ok: false, reason: 'too-large' };
      }

      const reachable = new Set(native.connectedPeers().map((peer) => peer.deviceId));
      let deliveredCount = 0;

      for (const target of to) {
        // Unlike MPC there is no native-side filter to fall back on: a TCP
        // write needs an established connection to a specific peer.
        if (!reachable.has(target)) continue;
        try {
          // Sequential, matching BLE. Concurrent writes to one socket from JS
          // would interleave at the native queue for no throughput gain — the
          // link is already fast, and ordering per peer is worth more.
          // eslint-disable-next-line no-await-in-loop
          if (await native.sendFrame(target, frame.data)) deliveredCount += 1;
        } catch {
          // A peer can vanish mid-write; keep going for the others.
        }
      }

      return deliveredCount > 0
        ? { ok: true, deliveredCount }
        : { ok: false, reason: 'no-route' };
    },

    // ARGUMENTS ARE SWAPPED BETWEEN THESE TWO CONTRACTS, deliberately not
    // passed through. The native listener emits (peerDeviceId, frame) — sender
    // first — while `MeshTransport.onFrame` is (data, from) — payload first.
    // Both are (string, string), so handing `cb` straight to the native
    // listener compiles perfectly and silently delivers every frame with the
    // peer id as its content. Caught by a test, not by tsc.
    onFrame: (cb): Unsubscribe =>
      native.addFrameListener((peerDeviceId, frame) => cb(frame, peerDeviceId)),

    onNeighbourChange: (cb): Unsubscribe =>
      native.addPeersChangedListener((peers) => cb(toNeighbours(peers))),
  };
};
