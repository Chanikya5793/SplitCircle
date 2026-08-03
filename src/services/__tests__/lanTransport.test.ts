/**
 * LAN transport adapter (ai_layer/docs/33 Phase 5).
 *
 * BLE shipped with 25 tests and LAN shipped with none, which is backwards: LAN
 * is the transport allowed to carry BULK payloads, so a mistake here loses a
 * photo rather than a text message. These pin the behaviours that differ from
 * BLE and the ones that are easy to get wrong on a stream transport.
 */
import { describe, expect, it, vi } from 'vitest';
import { createLanTransport, type NativeLanModule, type NativeLanPeer } from '../mesh/lanTransport';
import { maxPayloadFor } from '../mesh/transport';

const makeNative = (opts: {
  peers?: NativeLanPeer[];
  available?: boolean;
  /** Lets a test model a native `start()` that declines (no network yet). */
  startResult?: boolean;
  sendFrame?: (peer: string, frame: string) => Promise<boolean>;
} = {}) => {
  const sent: { peer: string; frame: string }[] = [];
  const frameCbs: ((p: string, f: string) => void)[] = [];
  const peersCbs: ((p: NativeLanPeer[]) => void)[] = [];
  const native: NativeLanModule = {
    isAvailable: () => opts.available ?? true,
    start: vi.fn(async () => opts.startResult ?? true),
    stop: vi.fn(),
    updateTrust: vi.fn(),
    connectedPeers: () => opts.peers ?? [],
    sendFrame: opts.sendFrame
      ? vi.fn(opts.sendFrame)
      : vi.fn(async (peer: string, frame: string) => { sent.push({ peer, frame }); return true; }),
    addFrameListener: (cb) => { frameCbs.push(cb); return () => { frameCbs.length = 0; }; },
    addPeersChangedListener: (cb) => { peersCbs.push(cb); return () => { peersCbs.length = 0; }; },
  };
  return {
    native,
    sent,
    emitFrame: (p: string, f: string) => frameCbs.forEach((cb) => cb(p, f)),
    emitPeers: (p: NativeLanPeer[]) => peersCbs.forEach((cb) => cb(p)),
  };
};

describe('capability', () => {
  it('is FAST, which is what lets it carry bulk at all', () => {
    // BLE is 'slow' and maxPayloadFor refuses bulk there outright. If LAN were
    // ever mislabelled, photos would silently have no route.
    const t = createLanTransport(makeNative().native);
    expect(t.throughputClass).toBe('fast');
    expect(maxPayloadFor(t, 'bulk')).not.toBeNull();
  });

  it('advertises a large MTU so the switch prefers it for big payloads', () => {
    expect(createLanTransport(makeNative().native).mtu).toBeGreaterThan(1024);
  });

  it('reports unavailable rather than throwing when the native side is dead', async () => {
    const t = createLanTransport(makeNative({ available: false, startResult: false }).native);
    expect(t.isAvailable()).toBe(false);
    expect(await t.start({ userId: 'u', deviceId: 'd', trustedDeviceIds: [] })).toBe(false);
    expect(await t.send({ data: 'x', payloadClass: 'text' }, ['p']))
      .toEqual({ ok: false, reason: 'unavailable' });
  });

  it('CALLS native start even while isAvailable() is false — the iOS prompt depends on it', async () => {
    // Same rule as the BLE half, different mechanism. iOS `isAvailable()` is
    // `hasPath && !localNetworkDenied`, and `hasPath` starts FALSE until
    // NWPathMonitor's first async callback — which `startNearbyMessaging`
    // usually beats at launch. A JS pre-gate therefore returned early,
    // NWListener/NWBrowser were never created, and starting THEM is what makes
    // iOS show the Local Network prompt. Nothing retried, so losing that race
    // once disabled LAN for the entire session.
    const harness = makeNative({ available: false, startResult: true });
    const t = createLanTransport(harness.native);

    expect(t.isAvailable()).toBe(false);
    await expect(t.start({ userId: 'u', deviceId: 'd', trustedDeviceIds: [] })).resolves.toBe(true);
    expect(harness.native.start).toHaveBeenCalled();
  });
});

describe('send', () => {
  it('sends WHOLE frames — no chunking, unlike BLE', async () => {
    // TCP has no MTU problem; splitting here would be pure overhead and would
    // duplicate framing the native half already does.
    const h = makeNative({ peers: [{ deviceId: 'p' }] });
    const t = createLanTransport(h.native);
    const payload = 'z'.repeat(200_000);
    await t.send({ data: payload, payloadClass: 'bulk' }, ['p']);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].frame).toBe(payload);
  });

  it('skips peers with no live socket rather than pretending to reach them', async () => {
    const h = makeNative({ peers: [{ deviceId: 'here' }] });
    const t = createLanTransport(h.native);
    const outcome = await t.send({ data: 'hi', payloadClass: 'text' }, ['here', 'gone']);
    expect(outcome).toEqual({ ok: true, deliveredCount: 1 });
    expect(h.sent.every((s) => s.peer === 'here')).toBe(true);
  });

  it('writes sequentially, never concurrently', async () => {
    // Two concurrent writes would interleave one frame's length prefix with
    // another's body. A length-prefixed stream has NO resync point, so that
    // desynchronises the connection permanently.
    let inFlight = 0;
    let maxInFlight = 0;
    const h = makeNative({
      peers: [{ deviceId: 'a' }, { deviceId: 'b' }, { deviceId: 'c' }],
      sendFrame: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 0));
        inFlight -= 1;
        return true;
      },
    });
    const t = createLanTransport(h.native);
    await t.send({ data: 'x', payloadClass: 'text' }, ['a', 'b', 'c']);
    expect(maxInFlight).toBe(1);
  });

  it('refuses an absurd frame instead of letting native buffer it into an OOM', async () => {
    const h = makeNative({ peers: [{ deviceId: 'p' }] });
    const t = createLanTransport(h.native);
    const outcome = await t.send(
      { data: 'x'.repeat(9 * 1024 * 1024), payloadClass: 'bulk' },
      ['p'],
    );
    expect(outcome).toEqual({ ok: false, reason: 'too-large' });
    expect(h.sent).toHaveLength(0);
  });

  it('counts only peers whose write actually succeeded', async () => {
    const h = makeNative({
      peers: [{ deviceId: 'ok' }, { deviceId: 'bad' }],
      sendFrame: async (peer) => peer === 'ok',
    });
    const t = createLanTransport(h.native);
    expect(await t.send({ data: 'x', payloadClass: 'text' }, ['ok', 'bad']))
      .toEqual({ ok: true, deliveredCount: 1 });
  });

  it('reports no-route rather than success when every write fails', async () => {
    const h = makeNative({ peers: [{ deviceId: 'p' }], sendFrame: async () => false });
    const t = createLanTransport(h.native);
    expect(await t.send({ data: 'x', payloadClass: 'text' }, ['p']))
      .toEqual({ ok: false, reason: 'no-route' });
  });

  it('survives a peer vanishing mid-write', async () => {
    const h = makeNative({
      peers: [{ deviceId: 'gone' }, { deviceId: 'ok' }],
      sendFrame: async (peer) => {
        if (peer === 'gone') throw new Error('socket closed');
        return true;
      },
    });
    const t = createLanTransport(h.native);
    expect(await t.send({ data: 'x', payloadClass: 'text' }, ['gone', 'ok']))
      .toEqual({ ok: true, deliveredCount: 1 });
  });
});

describe('receive and reachability', () => {
  it('passes whole frames straight through', () => {
    const h = makeNative();
    const t = createLanTransport(h.native);
    const got: { data: string; from: string }[] = [];
    t.onFrame((data, from) => got.push({ data, from }));
    h.emitFrame('peer-a', '{"v":1,"bodyBase64":"abc"}');
    expect(got).toEqual([{ data: '{"v":1,"bodyBase64":"abc"}', from: 'peer-a' }]);
  });

  it('reports neighbours as connected LAN links', () => {
    const h = makeNative();
    const t = createLanTransport(h.native);
    const seen: unknown[] = [];
    t.onNeighbourChange((n) => seen.push(n));
    h.emitPeers([{ deviceId: 'p', address: '192.168.1.5' }]);
    expect(seen[0]).toEqual([{ nodeId: 'p', transport: 'lan', connected: true }]);
  });

  it('degrades to an empty peer list rather than throwing', () => {
    const native = makeNative().native;
    native.connectedPeers = () => { throw new Error('native gone'); };
    expect(createLanTransport(native).neighbours()).toEqual([]);
  });
});
