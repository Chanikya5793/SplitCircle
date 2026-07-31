/**
 * Mesh diagnostics aggregation (ai_layer/docs/33 §4.1/§4.2, Phase 7).
 *
 * This layer exists because every hard mesh bug in this project was invisible
 * from the app while it was happening and had to be reconstructed from server
 * logs afterwards. Its own correctness therefore matters more than usual: a
 * diagnostics view that lies is worse than none, because it sends whoever is
 * debugging in a confident wrong direction.
 */
import { describe, expect, it } from 'vitest';
import {
  MeshEventLog,
  aggregateNeighbours,
  summariseMesh,
  type MeshDiagnostics,
} from '../mesh/diagnostics';
import type { NeighbourState } from '../mesh/transport';

const neighbour = (
  nodeId: string,
  transport: 'mpc' | 'ble' | 'lan',
  connected = true,
): NeighbourState => ({ nodeId, transport, connected });

describe('aggregateNeighbours', () => {
  it('collapses one phone reachable over two transports into ONE row', () => {
    // Rendering it twice would imply two devices in the room and make a
    // two-device test look like a three-device mesh.
    const rows = aggregateNeighbours(
      [neighbour('peer-a', 'mpc'), neighbour('peer-a', 'ble')],
      { 'peer-a': { label: 'Pixel 7' } },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].transports.sort()).toEqual(['ble', 'mpc']);
  });

  it('shows a reachable but UNTRUSTED peer rather than hiding it', () => {
    // "The other phone is right there and nothing happens" and "the other
    // phone was never discovered" are completely different problems. Filtering
    // untrusted peers out would make them indistinguishable.
    const rows = aggregateNeighbours([neighbour('stranger', 'ble')], {});
    expect(rows).toHaveLength(1);
    expect(rows[0].trusted).toBe(false);
  });

  it('labels an unknown peer with a short id instead of an empty string', () => {
    const rows = aggregateNeighbours([neighbour('abcdef0123456789', 'ble')], {});
    expect(rows[0].label).toBe('Unknown · abcdef01');
  });

  it('falls back to the short id when a trusted peer has a blank label', () => {
    const rows = aggregateNeighbours([neighbour('abcdef0123456789', 'ble')], {
      'abcdef0123456789': { label: '   ' },
    });
    expect(rows[0].label).toContain('abcdef01');
    expect(rows[0].trusted).toBe(true);
  });

  it('ignores links reported as disconnected', () => {
    expect(aggregateNeighbours([neighbour('gone', 'mpc', false)], {})).toEqual([]);
  });

  it('does not list the same transport twice for one node', () => {
    const rows = aggregateNeighbours(
      [neighbour('peer-a', 'ble'), neighbour('peer-a', 'ble')],
      {},
    );
    expect(rows[0].transports).toEqual(['ble']);
  });
});

describe('MeshEventLog', () => {
  it('keeps newest first, because the question is always "what just happened?"', () => {
    const log = new MeshEventLog();
    log.push({ at: 1, kind: 'sent', detail: 'first' });
    log.push({ at: 2, kind: 'sent', detail: 'second' });
    expect(log.list().map((e) => e.detail)).toEqual(['second', 'first']);
  });

  it('is bounded, so a mesh under load cannot grow it without limit', () => {
    const log = new MeshEventLog(3);
    for (let i = 0; i < 10; i += 1) log.push({ at: i, kind: 'info', detail: `e${i}` });
    expect(log.list()).toHaveLength(3);
    expect(log.list()[0].detail).toBe('e9');
  });
});

describe('summariseMesh', () => {
  const base: MeshDiagnostics = {
    transports: [], neighbours: [], queuedMessages: 0, routerPending: 0,
    bleEnabled: false, routerEnabled: false, events: [],
  };

  it('says so plainly when nothing is available', () => {
    expect(summariseMesh(base)).toBe('No transports available');
  });

  it('distinguishes searching from connected', () => {
    // The single most common question during a hardware test is whether the
    // radio is up but alone, or not up at all.
    expect(summariseMesh({
      ...base,
      transports: [{ id: 'ble', available: true, neighbourCount: 0 }],
    })).toBe('Searching over BLE');
  });

  it('counts devices, not links', () => {
    expect(summariseMesh({
      ...base,
      transports: [{ id: 'ble', available: true, neighbourCount: 2 }],
      neighbours: [
        { nodeId: 'a', transports: ['ble', 'mpc'], label: 'A', trusted: true },
      ],
    })).toBe('1 device nearby');
  });
});
