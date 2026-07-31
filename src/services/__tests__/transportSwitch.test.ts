/**
 * Transport switch behaviour (ai_layer/docs/33 Phase 0).
 *
 * The switch is where doc 33's payload policy actually bites: "text and small
 * media over any transport, full-size media only over a fast path". These
 * tests pin that, plus the unavailability handling that exists because MPC
 * simply does not exist on Android.
 */
import { describe, expect, it } from 'vitest';
import { createTransportSwitch } from '../mesh/transportSwitch';
import { maxPayloadFor, type MeshTransport, type NeighbourState, type TransportId } from '../mesh/transport';

const fake = (
  id: TransportId,
  opts: {
    available?: boolean;
    throughputClass?: 'slow' | 'fast';
    mtu?: number;
    peers?: string[];
  } = {},
): MeshTransport => {
  const peers: NeighbourState[] = (opts.peers ?? []).map((nodeId) => ({
    nodeId,
    transport: id,
    connected: true,
  }));
  return {
    id,
    mtu: opts.mtu ?? 60_000,
    throughputClass: opts.throughputClass ?? 'fast',
    isAvailable: () => opts.available ?? true,
    start: async () => true,
    stop: () => undefined,
    updateTrust: () => undefined,
    neighbours: () => peers,
    send: async () => ({ ok: true, deliveredTo: [] }),
    onFrame: () => () => undefined,
    onNeighbourChange: () => () => undefined,
  };
};

describe('maxPayloadFor', () => {
  it('refuses bulk on a slow link entirely', () => {
    // Not "allow a small amount" — null. A 12MP photo over BLE is effectively
    // never, and letting it queue there silently is what makes an offline
    // feature read as broken rather than degraded.
    expect(maxPayloadFor({ mtu: 185, throughputClass: 'slow' }, 'bulk')).toBeNull();
  });

  it('allows bulk on a fast link, minus router header', () => {
    expect(maxPayloadFor({ mtu: 60_000, throughputClass: 'fast' }, 'bulk')).toBe(60_000 - 54);
  });

  it('allows text on a slow link', () => {
    expect(maxPayloadFor({ mtu: 185, throughputClass: 'slow' }, 'text')).toBe(185 - 54);
  });
});

describe('transport switch', () => {
  it('prefers a fast link over BLE when both reach the peer', () => {
    const sw = createTransportSwitch([
      fake('ble', { throughputClass: 'slow', mtu: 185, peers: ['bob'] }),
      fake('mpc', { peers: ['bob'] }),
    ]);
    const routes = sw.routesFor('text', ['bob'], 40);
    expect(routes.map((r) => r.transport.id)).toEqual(['mpc', 'ble']);
  });

  it('falls back to BLE when no fast link reaches the peer', () => {
    const sw = createTransportSwitch([
      fake('mpc', { peers: [] }),
      fake('ble', { throughputClass: 'slow', mtu: 185, peers: ['bob'] }),
    ]);
    expect(sw.routesFor('text', ['bob'], 40).map((r) => r.transport.id)).toEqual(['ble']);
  });

  it('never routes bulk over a slow link, even as a last resort', () => {
    const sw = createTransportSwitch([
      fake('ble', { throughputClass: 'slow', mtu: 185, peers: ['bob'] }),
    ]);
    expect(sw.routesFor('bulk', ['bob'], 5_000_000)).toEqual([]);
    // ...and the node is reported unreachable-for-now rather than silently
    // dropped, so the router can hold it for a fast path.
    expect(sw.unreachable(['carol'])).toEqual(['carol']);
  });

  it('ignores a transport whose native half is missing', () => {
    // The Android reality: MPC is compiled in but has no implementation.
    const sw = createTransportSwitch([
      fake('mpc', { available: false, peers: ['bob'] }),
      fake('ble', { throughputClass: 'slow', mtu: 185, peers: ['bob'] }),
    ]);
    expect(sw.available().map((t) => t.id)).toEqual(['ble']);
    expect(sw.routesFor('text', ['bob'], 10).map((r) => r.transport.id)).toEqual(['ble']);
  });

  it('splits a group across links when recipients are on different transports', () => {
    const sw = createTransportSwitch([
      fake('mpc', { peers: ['ios-friend'] }),
      fake('ble', { throughputClass: 'slow', mtu: 185, peers: ['android-friend'] }),
    ]);
    const routes = sw.routesFor('text', ['ios-friend', 'android-friend'], 30);
    expect(routes).toHaveLength(2);
    expect(routes.find((r) => r.transport.id === 'mpc')?.reachable).toEqual(['ios-friend']);
    expect(routes.find((r) => r.transport.id === 'ble')?.reachable).toEqual(['android-friend']);
  });

  it('reports nodes no transport can reach, for store-and-forward', () => {
    const sw = createTransportSwitch([fake('mpc', { peers: ['bob'] })]);
    expect(sw.unreachable(['bob', 'dave'])).toEqual(['dave']);
  });

  it('rejects an oversized payload rather than truncating it', () => {
    const sw = createTransportSwitch([fake('mpc', { mtu: 100, peers: ['bob'] })]);
    expect(sw.routesFor('text', ['bob'], 5_000)).toEqual([]);
  });
});
