/**
 * BLE fragmentation/reassembly (ai_layer/docs/33 Phase 3).
 *
 * This is the layer that would otherwise be written twice — in Swift and in
 * Kotlin — where the copies can disagree about header layout or chunk
 * boundaries. That failure only shows up between an iPhone and a Pixel, on
 * real radios, and presents as corruption rather than a protocol mismatch.
 * These tests are what make one shared implementation trustworthy.
 */
import { describe, expect, it } from 'vitest';
import {
  BLE_MIN_USABLE_MTU,
  BleReassembler,
  decodeChunk,
  encodeChunk,
  fragment,
  randomMsgId,
} from '../mesh/bleFraming';

const roundTrip = (data: string, mtu: number, peer = 'peer-a'): string | null => {
  const r = new BleReassembler();
  let out: string | null = null;
  for (const chunk of fragment(data, mtu, 'ab12')) {
    out = r.accept(peer, chunk) ?? out;
  }
  return out;
};

describe('fragment / reassemble', () => {
  it('round-trips a frame far larger than the MTU', () => {
    const data = 'x'.repeat(4096);
    expect(roundTrip(data, 185)).toBe(data);
  });

  it('round-trips at the pessimistic default BLE MTU', () => {
    // 23-byte ATT default leaves almost nothing after the header; the point is
    // that it still works rather than silently truncating.
    const data = 'hello nearby world';
    expect(roundTrip(data, 23)).toBe(data);
  });

  it('never emits a chunk larger than the MTU', () => {
    for (const mtu of [23, 64, 185, 512]) {
      for (const chunk of fragment('y'.repeat(5000), mtu, 'ab12')) {
        expect(chunk.length).toBeLessThanOrEqual(mtu);
      }
    }
  });

  it('handles an empty frame as one chunk rather than zero', () => {
    expect(roundTrip('', 185)).toBe('');
  });

  it('refuses an MTU too small to carry anything, instead of looping forever', () => {
    expect(() => fragment('data', BLE_MIN_USABLE_MTU - 1)).toThrow(/too small/);
  });

  it('accounts for wider index fields as the chunk count grows', () => {
    // 5000 bytes at a 23-byte MTU needs 4-digit indices. Assuming a fixed
    // header width here emitted chunks one byte over the MTU — invisible in
    // JS, rejected by a real radio.
    const chunks = fragment('y'.repeat(5000), 23, 'ab12');
    // 3-digit indices at this size; the header must grow to match.
    expect(chunks.length).toBeGreaterThan(500);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(23);
  });

  it('preserves payloads containing the separator character', () => {
    // The payload is base64/JSON and may contain '|'. Splitting on every
    // separator instead of the first four would corrupt exactly these.
    const data = 'a|b||c|{"k":"v|w"}';
    expect(roundTrip(data, 32)).toBe(data);
  });

  it('reassembles when chunks arrive out of order', () => {
    const chunks = fragment('abcdefghijklmnopqrstuvwxyz', 30, 'ab12');
    const r = new BleReassembler();
    let out: string | null = null;
    for (const chunk of [...chunks].reverse()) out = r.accept('p', chunk) ?? out;
    expect(out).toBe('abcdefghijklmnopqrstuvwxyz');
  });
});

describe('decodeChunk hardening', () => {
  it('rejects garbage rather than throwing into the receive path', () => {
    // Another app can write to the same characteristic UUID; this must never
    // take the listener down.
    for (const bad of ['', 'nonsense', 'v1|xyz|0|1|p', 'v2|abcd1234|0|1|p', 'v1|ab12|0|0|p']) {
      expect(decodeChunk(bad)).toBeNull();
    }
  });

  it('rejects an index outside its own count', () => {
    expect(decodeChunk('v1|ab12|5|2|p')).toBeNull();
  });

  it('round-trips through encode', () => {
    const chunk = { msgId: 'ab12', index: 1, count: 3, payload: 'body|with|pipes' };
    expect(decodeChunk(encodeChunk(chunk))).toEqual(chunk);
  });
});

describe('BleReassembler bounds', () => {
  it('expires a partial transfer instead of buffering it forever', () => {
    // A peer vanishing mid-transfer is the NORMAL case on BLE.
    let now = 1000;
    const r = new BleReassembler(5_000, 8, () => now);
    const chunks = fragment('a'.repeat(500), 64, 'ab12');
    expect(r.accept('p', chunks[0])).toBeNull();
    now += 10_000;
    // The late remainder cannot complete a message that was already dropped.
    for (const c of chunks.slice(1)) expect(r.accept('p', c)).toBeNull();
  });

  it('drops the oldest partial so a stuck transfer cannot block a peer', () => {
    let now = 0;
    const r = new BleReassembler(60_000, 2, () => (now += 1));
    // Three concurrent transfers against a cap of two.
    r.accept('p', encodeChunk({ msgId: 'aaaa', index: 0, count: 2, payload: 'A' }));
    r.accept('p', encodeChunk({ msgId: 'bbbb', index: 0, count: 2, payload: 'B' }));
    r.accept('p', encodeChunk({ msgId: 'cccc', index: 0, count: 2, payload: 'C' }));
    // The newest still completes; the oldest was evicted.
    expect(r.accept('p', encodeChunk({ msgId: 'cccc', index: 1, count: 2, payload: 'c' })))
      .toBe('Cc');
    expect(r.accept('p', encodeChunk({ msgId: 'aaaa', index: 1, count: 2, payload: 'a' })))
      .toBeNull();
  });

  it('restarts rather than splicing two frames that collide on one id', () => {
    const r = new BleReassembler();
    r.accept('p', encodeChunk({ msgId: 'ab12', index: 0, count: 3, payload: 'X' }));
    // Same id, different count — a genuinely different message.
    expect(r.accept('p', encodeChunk({ msgId: 'ab12', index: 0, count: 2, payload: 'A' })))
      .toBeNull();
    expect(r.accept('p', encodeChunk({ msgId: 'ab12', index: 1, count: 2, payload: 'B' })))
      .toBe('AB');
  });

  it('keeps peers independent', () => {
    const r = new BleReassembler();
    const a = fragment('alpha', 30, 'aaaa');
    const b = fragment('beta', 30, 'bbbb');
    a.forEach((c) => r.accept('peer-a', c));
    expect(b.map((c) => r.accept('peer-b', c)).filter(Boolean)).toEqual(['beta']);
  });

  it('forgets a peer on disconnect', () => {
    const r = new BleReassembler();
    const chunks = fragment('hello there', 30, 'ab12');
    r.accept('p', chunks[0]);
    r.forget('p');
    for (const c of chunks.slice(1)) expect(r.accept('p', c)).toBeNull();
  });
});

describe('randomMsgId', () => {
  it('is 4 lowercase hex chars', () => {
    // Short on purpose: an 8-char id made the header consume the entire MTU at
    // the 23-byte ATT default, so no multi-chunk frame could be sent at all.
    expect(randomMsgId(() => 0.999)).toMatch(/^[0-9a-f]{4}$/);
    expect(randomMsgId(() => 0)).toBe('0000');
  });
});
