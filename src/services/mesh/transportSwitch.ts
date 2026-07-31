/**
 * Transport switch (ai_layer/docs/33 §2.1) — Phase 0.
 *
 * Owns the set of transports and answers one question for the router: given a
 * payload class and a destination, which link should carry it? It does not
 * decide WHERE a message goes (that is the router) and does not move bytes
 * (that is a transport).
 *
 * Kept free of native imports so it is unit-testable without a device.
 */
import {
  maxPayloadFor,
  type MeshTransport,
  type NeighbourState,
  type NodeId,
  type PayloadClass,
  type TransportId,
} from './transport';

/**
 * Preference order when several links can carry a payload. Fast links first;
 * BLE is the universal floor and therefore the last resort, not the default.
 */
const PREFERENCE: TransportId[] = ['mpc', 'lan', 'ble'];

export interface RouteChoice {
  transport: MeshTransport;
  /** Subset of `to` this transport can actually reach right now. */
  reachable: NodeId[];
}

export const createTransportSwitch = (transports: MeshTransport[]) => {
  const ordered = [...transports].sort(
    (a, b) => PREFERENCE.indexOf(a.id) - PREFERENCE.indexOf(b.id),
  );

  const available = (): MeshTransport[] => ordered.filter((t) => t.isAvailable());

  /** Union of neighbours across transports; the UI's topology source. */
  const neighbours = (): NeighbourState[] =>
    available().flatMap((t) => t.neighbours()).filter((n) => n.connected);

  /**
   * Every transport that can carry this payload to at least one of `to`,
   * best first. Returns a LIST rather than one winner so the router can fail
   * over without re-deciding, and so a group message can legitimately go out
   * over two links at once when its recipients are split across them.
   */
  const routesFor = (payloadClass: PayloadClass, to: NodeId[], size: number): RouteChoice[] => {
    const wanted = new Set(to);
    const choices: RouteChoice[] = [];
    for (const transport of available()) {
      const cap = maxPayloadFor(transport, payloadClass);
      // null means this class must never travel this link at all — bulk over a
      // slow radio. Queue it for a fast path instead of starting a transfer
      // that would take minutes and read as broken (doc 33 §1.3).
      if (cap === null || size > cap) continue;
      const reachable = transport
        .neighbours()
        .filter((n) => n.connected && wanted.has(n.nodeId))
        .map((n) => n.nodeId);
      if (reachable.length > 0) choices.push({ transport, reachable });
    }
    return choices;
  };

  /**
   * Available transports that may carry this payload class and size, best
   * first. Unlike `routesFor` this does NOT consult cached neighbour state —
   * it answers "may this travel here at all", leaving "can it reach anyone
   * right now" to the transport, which is the only layer that knows.
   */
  const capableOf = (payloadClass: PayloadClass, size: number): MeshTransport[] =>
    available().filter((t) => {
      const cap = maxPayloadFor(t, payloadClass);
      return cap !== null && size <= cap;
    });

  /** Nodes no available transport can reach — the router must store-and-forward these. */
  const unreachable = (to: NodeId[]): NodeId[] => {
    const seen = new Set(neighbours().map((n) => n.nodeId));
    return to.filter((id) => !seen.has(id));
  };

  return { available, neighbours, capableOf, routesFor, unreachable };
};

export type TransportSwitch = ReturnType<typeof createTransportSwitch>;
