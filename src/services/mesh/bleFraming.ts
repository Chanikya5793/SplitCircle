/**
 * BLE fragmentation and reassembly (ai_layer/docs/33 Phase 3).
 *
 * A BLE GATT write carries ~20 bytes by default and ~500 after a successful
 * MTU negotiation — against envelopes that are routinely kilobytes. Every
 * frame therefore has to be split, carried, and rebuilt in order.
 *
 * THIS LIVES IN TYPESCRIPT ON PURPOSE. The alternative is implementing it
 * twice, in Swift and in Kotlin, where the two copies can silently disagree
 * about header layout or chunk boundaries — a class of bug that only appears
 * between an iPhone and a Pixel, on real radios, and looks like corruption
 * rather than a protocol mismatch. Keeping it here means one implementation,
 * unit-tested without a device, and native modules that only have to move
 * opaque bytes between two peers.
 *
 * Wire format, ASCII so it survives any UTF-8 transport without escaping:
 *
 *   v1|<msgId>|<idx>|<cnt>|<payload>
 *
 * `msgId` is 8 hex chars — enough to keep concurrent transfers apart within a
 * session, and it is NOT a security boundary (the payload is already sealed
 * end to end; a relay cannot read it and a forged reassembly still fails
 * signature verification upstream).
 */

export const BLE_FRAME_VERSION = 'v1';

/**
 * Header length for a given chunk count: `v1|` + 8 hex + `|` + idx + `|` +
 * cnt + `|`. The index/count digits depend on how many chunks there are, which
 * depends on how much payload fits, which depends on this — so it is computed,
 * not assumed. A fixed guess silently produced oversized writes at the 23-byte
 * ATT default, which a real radio rejects or truncates.
 */
export const bleHeaderBytes = (count: number): number =>
  3 + 8 + 1 + String(Math.max(0, count - 1)).length + 1 + String(count).length + 1;

/** Smallest MTU that can carry at least one payload byte at any chunk count. */
export const BLE_MIN_USABLE_MTU = bleHeaderBytes(1) + 1;

export interface BleChunk {
  readonly msgId: string;
  readonly index: number;
  readonly count: number;
  readonly payload: string;
}

const HEX = '0123456789abcdef';

/**
 * Caller-supplied so this module stays pure and testable — `Math.random` here
 * would make every fragmentation test depend on a mock.
 */
export const randomMsgId = (rand: () => number = Math.random): string => {
  let out = '';
  for (let i = 0; i < 8; i += 1) out += HEX[Math.floor(rand() * 16)];
  return out;
};

export const encodeChunk = (chunk: BleChunk): string =>
  `${BLE_FRAME_VERSION}|${chunk.msgId}|${chunk.index}|${chunk.count}|${chunk.payload}`;

/**
 * Returns null for anything that is not a well-formed chunk. A BLE
 * characteristic can deliver garbage from an unrelated app writing to the same
 * UUID, so this must never throw into the receive path.
 */
export const decodeChunk = (raw: string): BleChunk | null => {
  // Split only the first four separators: the payload is base64/JSON and may
  // itself contain '|'.
  const parts: string[] = [];
  let rest = raw;
  for (let i = 0; i < 4; i += 1) {
    const at = rest.indexOf('|');
    if (at < 0) return null;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  const [version, msgId, idxRaw, cntRaw] = parts;
  if (version !== BLE_FRAME_VERSION) return null;
  if (!/^[0-9a-f]{8}$/.test(msgId)) return null;
  const index = Number(idxRaw);
  const count = Number(cntRaw);
  if (!Number.isInteger(index) || !Number.isInteger(count)) return null;
  if (count <= 0 || index < 0 || index >= count) return null;
  return { msgId, index, count, payload: rest };
};

/**
 * Splits a frame into chunks that each fit `mtu` bytes INCLUDING the header.
 *
 * Throws on an mtu too small to carry any payload rather than emitting an
 * infinite number of empty chunks — a caller that negotiated a useless MTU
 * needs to know, not to hang.
 */
export const fragment = (
  data: string,
  mtu: number,
  msgId: string = randomMsgId(),
): string[] => {
  if (mtu < BLE_MIN_USABLE_MTU) {
    throw new Error(`BLE mtu ${mtu} is too small to carry a payload`);
  }
  if (data.length === 0) return [encodeChunk({ msgId, index: 0, count: 1, payload: '' })];

  // Fixed point: more chunks means wider index/count fields, which shrinks the
  // usable payload, which can mean more chunks again. Iterate until the count
  // stops growing — it converges in a couple of passes because the header only
  // grows by one byte per power of ten.
  let total = Math.ceil(data.length / (mtu - bleHeaderBytes(1)));
  for (let guard = 0; guard < 8; guard += 1) {
    const usable = mtu - bleHeaderBytes(total);
    if (usable <= 0) throw new Error(`BLE mtu ${mtu} is too small to carry a payload`);
    const next = Math.ceil(data.length / usable);
    if (next <= total) break;
    total = next;
  }

  const usable = mtu - bleHeaderBytes(total);
  const chunks: string[] = [];
  for (let i = 0; i < total; i += 1) {
    chunks.push(
      encodeChunk({
        msgId,
        index: i,
        count: total,
        payload: data.slice(i * usable, (i + 1) * usable),
      }),
    );
  }
  return chunks;
};

interface PendingMessage {
  count: number;
  received: Map<number, string>;
  firstSeenAt: number;
}

/**
 * Rebuilds frames from chunks arriving per peer.
 *
 * Bounded on purpose. A peer that vanishes mid-transfer — which on BLE is the
 * normal case, not the exception — leaves a partial message behind, and an
 * unbounded buffer would grow until the app is killed. Partials expire, and
 * the number of concurrent transfers per peer is capped.
 */
export class BleReassembler {
  private readonly pending = new Map<string, Map<string, PendingMessage>>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly maxConcurrentPerPeer = 8,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns a completed frame, or null while still incomplete/invalid. */
  accept(peerId: string, raw: string): string | null {
    const chunk = decodeChunk(raw);
    if (!chunk) return null;

    this.expire();

    let byPeer = this.pending.get(peerId);
    if (!byPeer) {
      byPeer = new Map();
      this.pending.set(peerId, byPeer);
    }

    let entry = byPeer.get(chunk.msgId);
    if (!entry) {
      // Drop the OLDEST partial rather than refusing the new one: a stuck
      // transfer must not permanently block a peer from sending anything else.
      if (byPeer.size >= this.maxConcurrentPerPeer) {
        let oldestId: string | null = null;
        let oldestAt = Infinity;
        for (const [id, value] of byPeer) {
          if (value.firstSeenAt < oldestAt) {
            oldestAt = value.firstSeenAt;
            oldestId = id;
          }
        }
        if (oldestId) byPeer.delete(oldestId);
      }
      entry = { count: chunk.count, received: new Map(), firstSeenAt: this.now() };
      byPeer.set(chunk.msgId, entry);
    }

    // A count that disagrees with the first chunk seen means two different
    // messages collided on one id, or a peer is misbehaving. Restart rather
    // than concatenating pieces of two frames into one corrupt result.
    if (entry.count !== chunk.count) {
      entry = { count: chunk.count, received: new Map(), firstSeenAt: this.now() };
      byPeer.set(chunk.msgId, entry);
    }

    entry.received.set(chunk.index, chunk.payload);
    if (entry.received.size < entry.count) return null;

    let out = '';
    for (let i = 0; i < entry.count; i += 1) out += entry.received.get(i) ?? '';
    byPeer.delete(chunk.msgId);
    if (byPeer.size === 0) this.pending.delete(peerId);
    return out;
  }

  /** Forgets everything buffered for a peer. Call on disconnect. */
  forget(peerId: string): void {
    this.pending.delete(peerId);
  }

  private expire(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [peerId, byPeer] of this.pending) {
      for (const [msgId, entry] of byPeer) {
        if (entry.firstSeenAt < cutoff) byPeer.delete(msgId);
      }
      if (byPeer.size === 0) this.pending.delete(peerId);
    }
  }
}
