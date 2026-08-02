/**
 * Every REGISTERED transport must be able to carry a text message.
 *
 * Doc 35 critical #2 was that `maxPayloadFor` computed BLE's capacity as zero,
 * so the switch's `capableOf` (`size <= cap`) excluded BLE from every non-empty
 * payload — the universal floor, and the only transport that reaches Android,
 * was dead code at the routing layer regardless of hardware.
 *
 * `transportSwitch.test.ts` now covers BLE specifically. This covers the
 * INVARIANT across all three, because the original defect was not BLE-specific
 * reasoning — it was conflating a per-frame `mtu` with a total payload budget,
 * and any transport whose `mtu` is smaller than `ROUTER_HEADER_BYTES` would
 * have hit it. A future transport (a QR-code or audio link, say, both plausible
 * for this app's threat model) would reintroduce it silently: no compile error,
 * no exception, just a transport that never carries anything.
 *
 * These construct the REAL transports, not fixtures. A hand-picked fixture mtu
 * is exactly what let the original bug survive the existing suite.
 */
import { describe, expect, it, vi } from 'vitest';

import { createBleTransport } from '../mesh/bleTransport';
import { createLanTransport } from '../mesh/lanTransport';
import { createMpcTransport } from '../mesh/mpcTransport';
import { ROUTER_HEADER_BYTES, maxPayloadFor } from '../mesh/transport';
import type { MeshTransport } from '../mesh/transport';

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: vi.fn(() => ({
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    connectedPeerCount: vi.fn(() => 0),
    send: vi.fn(async () => 0),
    start: vi.fn(async () => true),
    stop: vi.fn(),
    updateTrustedPeers: vi.fn(),
  })),
}));

const nativeStub = {
  isAvailable: () => true,
  start: vi.fn(async () => true),
  stop: vi.fn(),
  updateTrust: vi.fn(),
  connectedPeers: vi.fn(() => []),
  sendChunk: vi.fn(async () => true),
  sendFrame: vi.fn(async () => true),
  addChunkListener: vi.fn(() => () => undefined),
  addFrameListener: vi.fn(() => () => undefined),
  addPeersChangedListener: vi.fn(() => () => undefined),
};

const transports: MeshTransport[] = [
  createMpcTransport(),
  createBleTransport(nativeStub as never),
  createLanTransport(nativeStub as never),
];

describe('transport payload capacity', () => {
  it.each(transports.map((t) => [t.id, t] as const))(
    '%s can carry a control frame',
    (_id, transport) => {
      // The smallest thing the mesh sends. A transport that cannot carry this
      // cannot participate in routing at all.
      const cap = maxPayloadFor(transport, 'control');
      expect(cap).not.toBeNull();
      expect(cap as number).toBeGreaterThan(0);
    },
  );

  it.each(transports.map((t) => [t.id, t] as const))(
    '%s can carry an ordinary text message',
    (_id, transport) => {
      // ~500 bytes covers a long chat message plus the envelope's own overhead.
      const cap = maxPayloadFor(transport, 'text');
      expect(cap).not.toBeNull();
      expect(cap as number).toBeGreaterThan(500);
    },
  );

  it.each(transports.map((t) => [t.id, t] as const))(
    '%s declares a total budget larger than the router header',
    (_id, transport) => {
      // The exact relation the original bug violated: BLE's per-frame mtu (20)
      // is SMALLER than ROUTER_HEADER_BYTES (54), so budgeting against `mtu`
      // yielded a negative number clamped to zero.
      expect(transport.maxPayloadBytes).toBeGreaterThan(ROUTER_HEADER_BYTES);
    },
  );

  it('still refuses bulk over a slow link', () => {
    // The capacity fix must not have quietly re-enabled photos over BLE — a
    // 12MP image over a ~20-byte MTU is effectively never, and letting it queue
    // there silently is what makes an offline feature feel broken rather than
    // degraded.
    const ble = transports.find((t) => t.id === 'ble');
    expect(ble?.throughputClass).toBe('slow');
    expect(maxPayloadFor(ble as MeshTransport, 'bulk')).toBeNull();
  });

  it('lets a fast link carry bulk', () => {
    const lan = transports.find((t) => t.id === 'lan');
    expect(lan?.throughputClass).toBe('fast');
    expect(maxPayloadFor(lan as MeshTransport, 'bulk')).not.toBeNull();
  });

  it('keeps mtu and maxPayloadBytes as DISTINCT concepts', () => {
    // Conflating them is the whole bug. BLE fragments internally, so its
    // per-frame mtu is far smaller than what it can actually carry; asserting
    // they differ is what stops someone "simplifying" one away.
    const ble = transports.find((t) => t.id === 'ble') as MeshTransport;
    expect(ble.maxPayloadBytes).toBeGreaterThan(ble.mtu);
  });
});
