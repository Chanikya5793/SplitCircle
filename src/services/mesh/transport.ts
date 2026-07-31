/**
 * Mesh transport contract (ai_layer/docs/33 §2.2) — Phase 0.
 *
 * The offline layer is built on exactly one link today: MultipeerConnectivity,
 * which is Apple-proprietary and can never reach an Android device (doc 33 §0).
 * Cross-platform nearby therefore needs several links behind one interface, so
 * that the router and switch above are written once rather than per-platform.
 *
 * This file is deliberately transport-agnostic and has NO native imports: it
 * must be loadable on any platform, including one where every transport is
 * unavailable. Concrete transports (`mpcTransport`, and later BLE and LAN)
 * adapt their native modules to this shape.
 */

/** Stable installation id of a device. Same id space as `getCurrentDeviceId`. */
export type NodeId = string;

export type TransportId = 'mpc' | 'ble' | 'lan';

/**
 * How fast a link is, in the only terms the switch needs to make a routing
 * decision. Deliberately two coarse buckets rather than a measured bitrate:
 * the real distinction is "can this carry a photo without looking broken",
 * and a precise number invites false precision under churn.
 */
export type ThroughputClass = 'slow' | 'fast';

/** What a payload needs, so the switch can pick a link for it (doc 33 §1.3). */
export type PayloadClass = 'control' | 'text' | 'thumbnail' | 'bulk';

export interface NeighbourState {
  nodeId: NodeId;
  transport: TransportId;
  /** Reachable right now — not merely discovered or pairing. */
  connected: boolean;
  /** Round-trip estimate in ms when the transport measures one. */
  latencyMs?: number;
}

export interface TransportFrame {
  /** Opaque, already-sealed bytes. Transports never inspect the payload. */
  readonly data: string;
  readonly payloadClass: PayloadClass;
}

export type SendOutcome =
  | { ok: true; deliveredTo: NodeId[] }
  | { ok: false; reason: 'unavailable' | 'no-route' | 'too-large' | 'error'; detail?: string };

export type Unsubscribe = () => void;

export interface MeshTransport {
  readonly id: TransportId;
  /** Usable payload bytes per frame after this transport's own headers. */
  readonly mtu: number;
  readonly throughputClass: ThroughputClass;

  /** False when the native half is missing (e.g. MPC on Android). */
  isAvailable(): boolean;

  start(params: { userId: string; deviceId: NodeId; trustedDeviceIds: NodeId[] }): Promise<boolean>;
  stop(): void;

  /** Trust changed; the transport must re-evaluate who it will talk to. */
  updateTrust(trustedDeviceIds: NodeId[]): void;

  neighbours(): NeighbourState[];

  send(frame: TransportFrame, to: NodeId[]): Promise<SendOutcome>;

  onFrame(cb: (data: string, from: NodeId) => void): Unsubscribe;

  /**
   * MUST fire on EVERY reachability change, including ones that originate from
   * a local trust mutation rather than a radio event.
   *
   * This is not a style preference. Doc 32 §5f: the native module mutated trust
   * and emitted only its state event, so the single listener that triggers
   * rebroadcast never fired, and a peer that had just become reachable kept its
   * queued messages unsent until an unrelated event happened along. A transport
   * that changes reachability silently is broken by definition.
   */
  onNeighbourChange(cb: (neighbours: NeighbourState[]) => void): Unsubscribe;
}

/** Frame overhead reserved by the router's own header (doc 33 §2.3). */
export const ROUTER_HEADER_BYTES = 54;

/**
 * Largest payload a transport can carry for a class, or null if it must not
 * carry that class at all. Bulk over a slow link is the case that matters:
 * a 12MP photo over BLE is effectively never, and letting it queue there
 * silently is what makes an offline feature feel broken rather than degraded.
 */
export const maxPayloadFor = (
  transport: Pick<MeshTransport, 'mtu' | 'throughputClass'>,
  payloadClass: PayloadClass,
): number | null => {
  if (payloadClass === 'bulk' && transport.throughputClass === 'slow') return null;
  return Math.max(0, transport.mtu - ROUTER_HEADER_BYTES);
};
