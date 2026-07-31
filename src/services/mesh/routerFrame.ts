/**
 * Router frame header (ai_layer/docs/33 §2.3, Phase 4).
 *
 * The routing layer's own header, wrapped AROUND the already-sealed mesh
 * envelope. Routers operate only on this header: the payload stays encrypted
 * end to end, so a relay learns `(origin, dest, size, time)` and nothing else.
 * That metadata exposure is inherent to any relay mesh and is stated in the UI
 * copy rather than hidden.
 *
 * TWO DELIBERATE DEVIATIONS from doc 33 §2.3's table, both decided while
 * building against what Phase 3 actually produced:
 *
 * 1. **ASCII, not packed binary.** §2.3 specifies a byte layout, but every
 *    transport in this codebase carries strings — `bleFraming` fragments
 *    strings, MPC envelopes are strings. Packing to binary would force a
 *    base64 round trip that costs ~33% MORE than a compact ASCII header, so
 *    the byte table is honoured as a field list, not as a memory layout.
 *
 * 2. **No `fragIdx`/`fragCnt`.** Fragmentation is a TRANSPORT concern and lives
 *    in `bleFraming` (Phase 3), because MTU varies per transport AND per peer.
 *    A router-level fragment count would have to assume one MTU for the whole
 *    path, which is wrong the moment a frame crosses BLE to MPC — the exact
 *    situation this mesh exists to create. Each hop refragments for its own
 *    link instead.
 *
 * Wire format, splitting only the first six separators since the payload is
 * itself a delimited envelope and will contain '|':
 *
 *   r1|<msgId>|<ttl>|<cls>|<origin>|<dest>|<payload>
 *
 * `cls` is one character, and it is in the header for a specific reason: doc 33
 * §2.4 requires backpressure to drop the lowest payload class first, and a
 * RELAY has no other way to know what it is holding. Without it every relayed
 * frame would be treated identically and a backed-up photo could evict the
 * text message a user is waiting on — the precise thing that rule prevents.
 */
import type { NodeId, PayloadClass } from './transport';

export const ROUTER_FRAME_VERSION = 'r1';

/** Group traffic has no single destination. Node ids are UUIDs, so no collision. */
export const BROADCAST_DEST = '*';

/**
 * Doc 33 §2.4: enough to cross a room, bounded against flood storms. Each hop
 * decrements; a frame arriving at 1 is delivered locally but never forwarded.
 */
export const DEFAULT_TTL = 4;

export interface RouterFrame {
  readonly msgId: string;
  readonly ttl: number;
  /** Travels with the frame so a RELAY can prioritise what it holds. */
  readonly payloadClass: PayloadClass;
  readonly origin: NodeId;
  /** A specific node, or `BROADCAST_DEST` for group traffic. */
  readonly dest: NodeId | typeof BROADCAST_DEST;
  /** Opaque sealed envelope. Routers never inspect or modify this. */
  readonly payload: string;
}

/** One char on the wire; the BLE floor makes every byte of header count. */
const CLASS_TO_CODE: Record<PayloadClass, string> = {
  control: 'c',
  text: 't',
  thumbnail: 'h',
  bulk: 'b',
};
const CODE_TO_CLASS: Record<string, PayloadClass> = {
  c: 'control',
  t: 'text',
  h: 'thumbnail',
  b: 'bulk',
};

const isCleanToken = (value: string): boolean =>
  value.length > 0 && !value.includes('|');

export const encodeRouterFrame = (frame: RouterFrame): string =>
  `${ROUTER_FRAME_VERSION}|${frame.msgId}|${frame.ttl}|${CLASS_TO_CODE[frame.payloadClass]}`
  + `|${frame.origin}|${frame.dest}|${frame.payload}`;

/**
 * Returns null for anything malformed. A mesh accepts frames from any radio in
 * range, so this is a trust boundary and must never throw into the receive
 * path — a crash here is a remotely triggerable denial of service.
 */
export const decodeRouterFrame = (raw: string): RouterFrame | null => {
  const parts: string[] = [];
  let rest = raw;
  for (let i = 0; i < 6; i += 1) {
    const at = rest.indexOf('|');
    if (at < 0) return null;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  const [version, msgId, ttlRaw, classCode, origin, dest] = parts;
  if (version !== ROUTER_FRAME_VERSION) return null;
  if (!isCleanToken(msgId) || !isCleanToken(origin) || !isCleanToken(dest)) return null;

  const payloadClass = CODE_TO_CLASS[classCode];
  if (!payloadClass) return null;

  const ttl = Number(ttlRaw);
  // Reject a non-integer or absurd TTL rather than clamping: a frame claiming
  // ttl=9999 is either a bug or an attempt to make one message circulate
  // forever, and silently clamping would hide both.
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > DEFAULT_TTL) return null;

  return { msgId, ttl, payloadClass, origin, dest, payload: rest };
};

/**
 * The frame as it should leave this node, or null when it must not be
 * forwarded. Returning null rather than a ttl-0 frame makes "do not forward"
 * impossible to ignore at the call site.
 */
export const decrementTtl = (frame: RouterFrame): RouterFrame | null =>
  frame.ttl <= 1 ? null : { ...frame, ttl: frame.ttl - 1 };

export const isBroadcast = (frame: RouterFrame): boolean => frame.dest === BROADCAST_DEST;
