/**
 * Mesh diagnostics (ai_layer/docs/33 §4.1, §4.2, Phase 7).
 *
 * Pure aggregation, deliberately free of native imports so it can be unit
 * tested and so the screen that renders it stays presentational.
 *
 * Exists because the previous answer to "what is the mesh doing?" was a single
 * `lastMessageEvent` slot, overwritten by the next event and visible only if
 * the user happened to have a sheet open at that instant. Every hard mesh bug
 * this project has hit — doc 32 §5f's unsent queue, §10.1's dead self-sync,
 * §10.2's collapsing session — was invisible from the app while it was
 * happening, and diagnosed afterwards from server logs. This is the in-app
 * version of that evidence.
 */
import type { NeighbourState, NodeId, TransportId } from './transport';

/** One event worth showing the user, kept in a bounded log rather than a slot. */
export interface MeshEventEntry {
  at: number;
  kind: 'sent' | 'received' | 'relayed' | 'failed' | 'info';
  detail: string;
  chatId?: string;
  peerCount?: number;
}

/**
 * A peer as the UI should see it: one row per NODE, not per link.
 *
 * A phone reachable over both MPC and BLE is ONE neighbour with two transports.
 * Rendering it twice would imply two peers in the room and make a two-device
 * test look like a three-device mesh — precisely the confusion a topology view
 * exists to remove.
 */
export interface MeshNeighbourView {
  nodeId: NodeId;
  transports: TransportId[];
  label: string;
  trusted: boolean;
}

export interface MeshTransportView {
  id: TransportId;
  available: boolean;
  neighbourCount: number;
  /**
   * The radio is capable but the user has refused access.
   *
   * Distinct from `available` because they need different words in front of a
   * person: "turn Bluetooth on" versus "allow ManaSplit to use Bluetooth" are
   * different actions, and telling someone the wrong one sends them hunting
   * through Settings for something that is already correct. The Android half
   * always distinguished these; iOS could not until `CBManager.authorization`
   * was exposed.
   */
  needsPermission?: boolean;
}

export interface MeshDiagnostics {
  transports: MeshTransportView[];
  neighbours: MeshNeighbourView[];
  /** Envelopes still queued for nearby delivery. */
  queuedMessages: number;
  /** Frames the router is holding for an unreachable destination. */
  routerPending: number;
  bleEnabled: boolean;
  lanEnabled: boolean;
  routerEnabled: boolean;
  events: MeshEventEntry[];
}

/**
 * Bounded, newest-first event log.
 *
 * Bounded because this runs for the life of the app and a mesh under load
 * emits continuously; newest-first because the question being asked is always
 * "what just happened?".
 */
export class MeshEventLog {
  private entries: MeshEventEntry[] = [];

  constructor(private readonly capacity = 50) {}

  push(entry: MeshEventEntry): void {
    this.entries = [entry, ...this.entries].slice(0, this.capacity);
  }

  list(): MeshEventEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }
}

/**
 * Collapses per-transport neighbour states into one row per node.
 *
 * `trusted` is reported rather than filtered on: a peer that is reachable but
 * NOT trusted is exactly what someone debugging a failed pairing needs to see.
 * Hiding it would make "the other phone is right there and nothing happens"
 * indistinguishable from "the other phone was never discovered", which are
 * completely different problems.
 */
export const aggregateNeighbours = (
  states: readonly NeighbourState[],
  trustedPeers: Readonly<Record<string, { label?: string }>>,
): MeshNeighbourView[] => {
  const byNode = new Map<NodeId, MeshNeighbourView>();
  for (const state of states) {
    if (!state.connected) continue;
    const existing = byNode.get(state.nodeId);
    if (existing) {
      if (!existing.transports.includes(state.transport)) {
        existing.transports.push(state.transport);
      }
      continue;
    }
    const trustedEntry = trustedPeers[state.nodeId];
    byNode.set(state.nodeId, {
      nodeId: state.nodeId,
      transports: [state.transport],
      // Falls back to a short id rather than an empty string: an unlabelled row
      // is unusable, and a truncated id is still enough to tell two peers apart.
      label: trustedEntry?.label?.trim() || `Unknown · ${state.nodeId.slice(0, 8)}`,
      trusted: trustedEntry !== undefined,
    });
  }
  return [...byNode.values()].sort((a, b) => a.label.localeCompare(b.label));
};

/** Human summary for the header, in the order a person actually asks it. */
export const summariseMesh = (diagnostics: MeshDiagnostics): string => {
  const live = diagnostics.transports.filter((t) => t.available);
  if (live.length === 0) return 'No transports available';
  if (diagnostics.neighbours.length === 0) {
    return `Searching over ${live.map((t) => t.id.toUpperCase()).join(' + ')}`;
  }
  const peers = diagnostics.neighbours.length;
  return `${peers} ${peers === 1 ? 'device' : 'devices'} nearby`;
};
