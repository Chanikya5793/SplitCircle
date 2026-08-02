/**
 * Mesh router (ai_layer/docs/33 §2.4, Phase 4).
 *
 * Decides where a frame goes next and when to give up. Sits above the switch
 * (which picks a transport) and below the message services (which own
 * plaintext). It reads only the routing header — the payload stays sealed end
 * to end, so a relay learns `(origin, dest, size, time)` and nothing more.
 *
 * Flood with dedup and TTL, rather than a routing table. A phone mesh's
 * topology changes faster than any table converges: people walk out of range
 * mid-message. Flooding is stateless per hop and self-healing, and the cost —
 * duplicate frames — is exactly what the dedup set exists to absorb.
 *
 * The single most important property here: **a relay never mints or alters
 * ciphertext.** It forwards bytes it cannot read. Re-sealing for a device
 * added mid-thread is the ORIGIN's job alone (doc 33 §2.5); a relay doing it
 * would be forgery.
 */
import {
  BROADCAST_DEST,
  DEFAULT_TTL,
  decodeRouterFrame,
  decrementTtl,
  encodeRouterFrame,
  isBroadcast,
  type RouterFrame,
} from './routerFrame';
import type { NodeId, PayloadClass } from './transport';

/**
 * Drop order under pressure: bulk first, control last. A dropped photo is an
 * inconvenience; a dropped control frame desynchronises the mesh, and a
 * dropped text message is the thing the user actually noticed sending.
 */
const DROP_PRIORITY: Record<PayloadClass, number> = {
  bulk: 0,
  thumbnail: 1,
  text: 2,
  control: 3,
};

/**
 * Bounded dedup set with insertion-order eviction (doc 33 §2.4).
 *
 * Bounded because an unbounded seen-set on a long-lived mesh is a memory leak
 * that only shows up after hours of use. Capacity is well above any plausible
 * in-flight window, so eviction only ever reaches ids whose frames have long
 * since exceeded their TTL.
 */
export class SeenSet {
  private readonly ids = new Set<string>();

  constructor(private readonly capacity = 2048) {}

  has(msgId: string): boolean {
    return this.ids.has(msgId);
  }

  /** Returns false when this id was already present. */
  add(msgId: string): boolean {
    if (this.ids.has(msgId)) return false;
    this.ids.add(msgId);
    if (this.ids.size > this.capacity) {
      // Set preserves insertion order, so the first key is the oldest.
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }

  /**
   * For persistence across restarts. The router does NOT persist itself: it
   * stays synchronous and pure, and the caller owns storage. Without a restore
   * on boot a device re-floods frames it already relayed — bounded by TTL, so
   * wasteful rather than harmful.
   */
  snapshot(): string[] {
    return [...this.ids];
  }

  restore(ids: readonly string[]): void {
    ids.forEach((id) => this.add(id));
  }
}

interface PendingFrame {
  frame: RouterFrame;
  payloadClass: PayloadClass;
  bytes: number;
  queuedAt: number;
}

export interface RouterDeps {
  /**
   * A GETTER, not a value: the router is a module-level singleton constructed
   * at import time, while this device's id only resolves once
   * `getCurrentDeviceId()` completes during startup. Capturing a value here
   * would freeze the empty string and every frame would claim origin `''`.
   */
  localNodeId: () => NodeId;
  /** Encoded frame out to specific neighbours; resolves with how many took it. */
  send(encoded: string, to: NodeId[], payloadClass: PayloadClass): Promise<number>;
  /** Every currently reachable neighbour, across all transports. */
  neighbours(): NodeId[];
  now?: () => number;
  seen?: SeenSet;
  /** Total bytes held for unreachable destinations before eviction starts. */
  queueByteCap?: number;
  /** Frames older than this are dropped on the next flush. */
  maxHoldMs?: number;
}

export type AcceptOutcome =
  | { action: 'deliver'; payload: string; forwarded: number }
  | { action: 'relay'; forwarded: number }
  | { action: 'drop'; reason: 'malformed' | 'duplicate' | 'ttl-expired' | 'self-origin' };

export interface MeshRouter {
  /** Injects a locally authored payload into the mesh. */
  originate(input: {
    msgId: string;
    payload: string;
    dest: NodeId | typeof BROADCAST_DEST;
    payloadClass: PayloadClass;
  }): Promise<{ delivered: number; held: boolean }>;
  /** Handles one inbound frame from a neighbour. */
  accept(raw: string, from: NodeId): Promise<AcceptOutcome>;
  /** Retries everything held for a now-reachable destination. */
  flush(): Promise<number>;
  pendingCount(): number;
  seenSet(): SeenSet;
}

export const createMeshRouter = (deps: RouterDeps): MeshRouter => {
  const now = deps.now ?? Date.now;
  const seen = deps.seen ?? new SeenSet();
  const queueByteCap = deps.queueByteCap ?? 512 * 1024;
  const maxHoldMs = deps.maxHoldMs ?? 7 * 24 * 60 * 60 * 1000;
  let pending: PendingFrame[] = [];

  const pendingBytes = (): number => pending.reduce((total, item) => total + item.bytes, 0);

  /**
   * Evicts until the queue fits, lowest payload class first and oldest first
   * within a class. Bulk media backing up must never push out the text
   * messages a user is actually waiting on.
   */
  const enforceCap = (): void => {
    if (pendingBytes() <= queueByteCap) return;
    const ordered = [...pending].sort((a, b) => {
      const byClass = DROP_PRIORITY[a.payloadClass] - DROP_PRIORITY[b.payloadClass];
      return byClass !== 0 ? byClass : a.queuedAt - b.queuedAt;
    });
    let total = pendingBytes();
    const dropped = new Set<PendingFrame>();
    for (const item of ordered) {
      if (total <= queueByteCap) break;
      dropped.add(item);
      total -= item.bytes;
    }
    pending = pending.filter((item) => !dropped.has(item));
  };

  /**
   * Buffers a frame for later, returning whether it SURVIVED (doc 35).
   *
   * `enforceCap` can evict the very frame just pushed — a large bulk frame into
   * a full queue does exactly that. `originate` reported `held: true`
   * regardless, so the router's public contract claimed a message would be
   * delivered once reachable when it had already been discarded.
   */
  const hold = (frame: RouterFrame, payloadClass: PayloadClass): boolean => {
    const entry: PendingFrame = {
      frame,
      payloadClass,
      bytes: frame.payload.length,
      queuedAt: now(),
    };
    pending.push(entry);
    enforceCap();
    return pending.includes(entry);
  };

  /**
   * Neighbours worth forwarding to.
   *
   * SPLIT HORIZON: never back to the node that just handed us the frame, and
   * never to the origin. Both would be pure waste — they demonstrably have it —
   * and on a slow link that waste is the difference between a mesh that keeps
   * up and one that saturates on its own echoes. Dedup would catch the loop
   * anyway; this stops it costing bandwidth first.
   */
  const forwardTargets = (frame: RouterFrame, from?: NodeId): NodeId[] =>
    deps.neighbours().filter(
      (node) => node !== from && node !== frame.origin && node !== deps.localNodeId(),
    );

  const forward = async (frame: RouterFrame, from?: NodeId): Promise<number> => {
    const payloadClass = frame.payloadClass;
    const next = decrementTtl(frame);
    // TTL exhausted. Not an error: it is the bound that stops a flood
    // circulating forever, and reaching it simply means this copy stops here.
    if (!next) return 0;

    const targets = forwardTargets(frame, from);
    if (targets.length === 0) {
      // Unicast to someone we cannot currently see: hold it for a neighbour
      // change. Broadcast is NOT held — a group frame with no neighbours has
      // no one to relay to, and the origin's own queue is what replays it.
      if (!isBroadcast(next) && next.dest !== deps.localNodeId()) hold(next, payloadClass);
      return 0;
    }
    return deps.send(encodeRouterFrame(next), targets, payloadClass);
  };

  return {
    originate: async ({ msgId, payload, dest, payloadClass }) => {
      // NO IDENTITY YET means no valid frame (doc 35). `localNodeId` is resolved
      // asynchronously during startNearbyMessaging, and other entry points that
      // reach here — queued-send broadcasts, attachment callbacks — are not
      // gated on that. Originating with `origin: ''` produces a frame every peer
      // rejects as malformed in `decodeRouterFrame`, yet `deliveredCount`
      // counts raw bytes handed to a connected transport, not frames anyone
      // accepted, so the message was still marked sent: a false delivery
      // confirmation for something no peer could ever process.
      //
      // held: true, not a silent drop — the caller's message is real and this is
      // a transient startup condition, so it belongs in the store-and-forward
      // buffer to go out once identity exists.
      const origin = deps.localNodeId();
      if (!origin) {
        const held = hold(
          { msgId, ttl: DEFAULT_TTL, payloadClass, origin, dest, payload },
          payloadClass,
        );
        return { delivered: 0, held };
      }
      const frame: RouterFrame = {
        msgId,
        ttl: DEFAULT_TTL,
        payloadClass,
        origin,
        dest,
        payload,
      };
      // Mark our OWN id seen before sending. Without this the first echo of our
      // own broadcast comes back, passes dedup, and we re-flood it — the mesh
      // amplifies its own traffic.
      seen.add(msgId);

      const targets = forwardTargets(frame);
      if (targets.length === 0) {
        if (!isBroadcast(frame)) {
          // `hold` reports whether the frame SURVIVED `enforceCap`, which can
          // evict the very frame it was just given. This previously returned an
          // unconditional `true` — a claim the router had never checked (doc 35).
          return { delivered: 0, held: hold(frame, payloadClass) };
        }
        return { delivered: 0, held: false };
      }
      const delivered = await deps.send(encodeRouterFrame(frame), targets, payloadClass);
      return { delivered, held: false };
    },

    accept: async (raw, from) => {
      const frame = decodeRouterFrame(raw);
      if (!frame) return { action: 'drop', reason: 'malformed' };

      // Our own frame come back around. Dedup would catch it, but naming the
      // case keeps the diagnostic honest — this is normal on a flood mesh, not
      // a fault.
      if (frame.origin === deps.localNodeId()) return { action: 'drop', reason: 'self-origin' };

      if (!seen.add(frame.msgId)) return { action: 'drop', reason: 'duplicate' };

      const forMe = frame.dest === deps.localNodeId();
      const broadcast = isBroadcast(frame);

      if (forMe) {
        // Terminal. Forwarding a frame addressed to us would put it back on the
        // air for no one.
        return { action: 'deliver', payload: frame.payload, forwarded: 0 };
      }

      // Broadcast is both consumed locally AND relayed onward — that dual role
      // is what makes group messaging work across a partial mesh, where A sees
      // B and B sees C but A never sees C.
      const forwarded = await forward(frame, from);
      return broadcast
        ? { action: 'deliver', payload: frame.payload, forwarded }
        : { action: 'relay', forwarded };
    },

    flush: async () => {
      if (pending.length === 0) return 0;
      const cutoff = now() - maxHoldMs;
      const live = pending.filter((item) => item.queuedAt >= cutoff);
      pending = [];

      let delivered = 0;
      for (const item of live) {
        const targets = forwardTargets(item.frame);
        if (targets.length === 0) {
          // Still unreachable. Re-hold with the ORIGINAL queuedAt so the hold
          // window cannot be extended indefinitely by repeated flushes.
          pending.push(item);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        delivered += await deps.send(
          encodeRouterFrame(item.frame),
          targets,
          item.payloadClass,
        );
      }
      enforceCap();
      return delivered;
    },

    pendingCount: () => pending.length,
    seenSet: () => seen,
  };
};
