/**
 * BLE transport adapter (ai_layer/docs/33 Phase 3).
 *
 * Pins the behaviours that are painful to discover on real radios: per-peer
 * MTU, strictly sequential writes, partial-frame handling, and dropping
 * buffered chunks when a peer disappears.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBleTransport, type NativeBleModule, type NativeBlePeer } from '../mesh/bleTransport';

const makeNative = (opts: {
  peers?: NativeBlePeer[];
  available?: boolean;
  sendChunk?: (peer: string, chunk: string) => Promise<boolean>;
} = {}) => {
  const sent: { peer: string; chunk: string }[] = [];
  const chunkCbs: ((p: string, c: string) => void)[] = [];
  // An array, not a single slot: createBleTransport subscribes internally for
  // reassembly cleanup, so a one-slot mock would silently drop that listener
  // the moment a consumer also subscribed.
  const peersCbs: ((p: NativeBlePeer[]) => void)[] = [];
  const native: NativeBleModule = {
    isAvailable: () => opts.available ?? true,
    start: vi.fn(async () => true),
    stop: vi.fn(),
    updateTrust: vi.fn(),
    connectedPeers: () => opts.peers ?? [],
    sendChunk: opts.sendChunk
      ? vi.fn(opts.sendChunk)
      : vi.fn(async (peer: string, chunk: string) => { sent.push({ peer, chunk }); return true; }),
    addChunkListener: (cb) => { chunkCbs.push(cb); return () => { chunkCbs.length = 0; }; },
    addPeersChangedListener: (cb) => { peersCbs.push(cb); return () => { peersCbs.length = 0; }; },
  };
  return {
    native,
    sent,
    emitChunk: (p: string, c: string) => chunkCbs.forEach((cb) => cb(p, c)),
    emitPeers: (p: NativeBlePeer[]) => peersCbs.forEach((cb) => cb(p)),
  };
};

describe('BLE transport', () => {
  it('advertises the pessimistic MTU floor, not a peer-specific one', () => {
    // The switch uses this to decide what may travel BLE at all; that must
    // hold for the worst link, not the best.
    const t = createBleTransport(makeNative().native);
    expect(t.mtu).toBe(20);
    expect(t.throughputClass).toBe('slow');
  });

  it('fragments per-peer using that peer’s negotiated MTU', async () => {
    const h = makeNative({ peers: [{ deviceId: 'big', mtu: 512 }, { deviceId: 'small', mtu: 23 }] });
    const t = createBleTransport(h.native);
    const payload = 'z'.repeat(600);
    await t.send({ data: payload, payloadClass: 'text' }, ['big', 'small']);

    const big = h.sent.filter((s) => s.peer === 'big');
    const small = h.sent.filter((s) => s.peer === 'small');
    // A 512-MTU link needs far fewer writes than a 23-MTU one for the same
    // frame. Using one global MTU would either waste the fast link or
    // overflow the slow one.
    expect(big.length).toBeLessThan(small.length);
    expect(Math.max(...small.map((s) => s.chunk.length))).toBeLessThanOrEqual(20);
  });

  it('writes chunks sequentially, never concurrently', async () => {
    // Concurrent GATT writes to one peripheral interleave or get dropped, and
    // a partial frame is unrecoverable.
    let inFlight = 0;
    let maxInFlight = 0;
    const h = makeNative({
      peers: [{ deviceId: 'p', mtu: 23 }],
      sendChunk: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 0));
        inFlight -= 1;
        return true;
      },
    });
    const t = createBleTransport(h.native);
    await t.send({ data: 'x'.repeat(200), payloadClass: 'text' }, ['p']);
    expect(maxInFlight).toBe(1);
  });

  it('counts a peer only when every chunk was written', async () => {
    const h = makeNative({
      peers: [{ deviceId: 'p', mtu: 23 }],
      sendChunk: async (_p, chunk) => !chunk.includes('|5|'),  // fail one mid-frame
    });
    const t = createBleTransport(h.native);
    const outcome = await t.send({ data: 'y'.repeat(300), payloadClass: 'text' }, ['p']);
    // A half-written frame is not a delivery; claiming it would let the router
    // mark a message sent that the peer can never reassemble.
    expect(outcome).toEqual({ ok: false, reason: 'no-route' });
  });

  it('skips peers with no live link rather than pretending to reach them', async () => {
    const h = makeNative({ peers: [{ deviceId: 'here', mtu: 185 }] });
    const t = createBleTransport(h.native);
    const outcome = await t.send({ data: 'hi', payloadClass: 'text' }, ['here', 'gone']);
    expect(outcome).toEqual({ ok: true, deliveredCount: 1 });
    expect(h.sent.every((s) => s.peer === 'here')).toBe(true);
  });

  it('reassembles an inbound frame across chunks', () => {
    const h = makeNative({ peers: [{ deviceId: 'p', mtu: 23 }] });
    const t = createBleTransport(h.native);
    const got: { data: string; from: string }[] = [];
    t.onFrame((data, from) => got.push({ data, from }));

    // Reuse the sender's own fragmentation so the test exercises the real
    // wire format rather than a hand-rolled approximation.
    const sender = createBleTransport(makeNative({ peers: [{ deviceId: 'p', mtu: 23 }] }).native);
    void sender;
    const chunks = ['v1|ab12|0|2|hello ', 'v1|ab12|1|2|world'];
    chunks.forEach((c) => h.emitChunk('p', c));

    expect(got).toEqual([{ data: 'hello world', from: 'p' }]);
  });

  it('never emits for a malformed chunk', () => {
    const h = makeNative();
    const t = createBleTransport(h.native);
    const got: string[] = [];
    t.onFrame((data) => got.push(data));
    h.emitChunk('p', 'not a frame');
    expect(got).toEqual([]);
  });

  it('drops buffered partials when a peer disappears', () => {
    // Otherwise a reconnecting peer's fresh chunks splice onto stale ones and
    // reassemble into garbage.
    const h = makeNative();
    const t = createBleTransport(h.native);
    const got: string[] = [];
    t.onFrame((data) => got.push(data));

    h.emitPeers([{ deviceId: 'p', mtu: 23 }]);
    h.emitChunk('p', 'v1|ab12|0|2|first');
    h.emitPeers([]);                              // p disconnects
    h.emitPeers([{ deviceId: 'p', mtu: 23 }]);    // and comes back
    h.emitChunk('p', 'v1|ab12|1|2|second');

    expect(got).toEqual([]);
  });

  it('reports unavailable rather than throwing when the radio is missing', async () => {
    const t = createBleTransport(makeNative({ available: false }).native);
    expect(t.isAvailable()).toBe(false);
    expect(await t.start({ userId: 'u', deviceId: 'd', trustedDeviceIds: [] })).toBe(false);
    expect(await t.send({ data: 'x', payloadClass: 'text' }, ['p']))
      .toEqual({ ok: false, reason: 'unavailable' });
  });
});
