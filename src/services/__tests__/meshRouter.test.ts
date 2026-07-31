/**
 * Mesh router (ai_layer/docs/33 §2.4, Phase 4).
 *
 * The behaviours here are the ones that are expensive or impossible to observe
 * on real radios: a flood that fails to terminate looks like "the mesh is
 * slow", a dedup miss looks like duplicate messages, and a store-and-forward
 * bug looks like a message that simply never arrived. Each is cheap to pin
 * here and brutal to diagnose in a room with three phones.
 */
import { describe, expect, it } from 'vitest';
import {
  BROADCAST_DEST,
  DEFAULT_TTL,
  decodeRouterFrame,
  encodeRouterFrame,
} from '../mesh/routerFrame';
import { SeenSet, createMeshRouter } from '../mesh/router';

const makeRouter = (opts: {
  localNodeId: string;
  neighbours?: string[];
  queueByteCap?: number;
  now?: () => number;
}) => {
  const sent: { encoded: string; to: string[]; payloadClass: string }[] = [];
  let neighbours = opts.neighbours ?? [];
  const router = createMeshRouter({
    localNodeId: opts.localNodeId,
    neighbours: () => neighbours,
    send: async (encoded, to, payloadClass) => {
      sent.push({ encoded, to, payloadClass });
      return to.length;
    },
    queueByteCap: opts.queueByteCap,
    now: opts.now,
  });
  return {
    router,
    sent,
    setNeighbours: (next: string[]) => { neighbours = next; },
  };
};

const frameFrom = (encoded: string) => decodeRouterFrame(encoded)!;

describe('router frame', () => {
  it('round-trips, payload separators and all', () => {
    const frame = {
      msgId: 'm1', ttl: 4, payloadClass: 'text' as const,
      origin: 'A', dest: 'C', payload: 'sealed|body|with|pipes',
    };
    expect(decodeRouterFrame(encodeRouterFrame(frame))).toEqual(frame);
  });

  it('carries the payload class so a RELAY can prioritise what it holds', () => {
    // Without this in the header a relay cannot know whether it is buffering a
    // photo or a text message, and backpressure cannot honour doc 33 §2.4.
    const encoded = encodeRouterFrame({
      msgId: 'm1', ttl: 4, payloadClass: 'bulk',
      origin: 'A', dest: BROADCAST_DEST, payload: 'x',
    });
    expect(frameFrom(encoded).payloadClass).toBe('bulk');
  });

  it('rejects garbage rather than throwing into the receive path', () => {
    // Any radio in range can write here; a throw would be a remotely
    // triggerable crash.
    for (const bad of ['', 'nonsense', 'r2|m|4|t|A|B|p', 'r1|m|4|z|A|B|p', 'r1||4|t|A|B|p']) {
      expect(decodeRouterFrame(bad)).toBeNull();
    }
  });

  it('rejects a TTL above the maximum instead of clamping it', () => {
    // A frame claiming ttl=9999 is a bug or an attempt to circulate forever.
    // Clamping would hide both.
    expect(decodeRouterFrame(`r1|m|9999|t|A|B|p`)).toBeNull();
    expect(decodeRouterFrame(`r1|m|0|t|A|B|p`)).toBeNull();
  });
});

describe('router: flood, dedup, TTL', () => {
  it('marks its OWN message seen so an echo cannot be re-flooded', async () => {
    // Otherwise the first echo of our own broadcast passes dedup and we
    // amplify our own traffic.
    const { router } = makeRouter({ localNodeId: 'A', neighbours: ['B'] });
    await router.originate({
      msgId: 'm1', payload: 'p', dest: BROADCAST_DEST, payloadClass: 'text',
    });
    const echo = encodeRouterFrame({
      msgId: 'm1', ttl: 3, payloadClass: 'text', origin: 'B', dest: BROADCAST_DEST, payload: 'p',
    });
    expect(await router.accept(echo, 'B')).toEqual({ action: 'drop', reason: 'duplicate' });
  });

  it('drops a second copy of the same message id', async () => {
    const { router } = makeRouter({ localNodeId: 'B', neighbours: ['C'] });
    const encoded = encodeRouterFrame({
      msgId: 'm1', ttl: 3, payloadClass: 'text', origin: 'A', dest: BROADCAST_DEST, payload: 'p',
    });
    const first = await router.accept(encoded, 'A');
    expect(first.action).toBe('deliver');
    expect(await router.accept(encoded, 'A')).toEqual({ action: 'drop', reason: 'duplicate' });
  });

  it('never forwards back to the sender or to the origin', async () => {
    // Both demonstrably have it. Dedup would catch the loop, but only after
    // paying for it on a link where bandwidth is the scarce thing.
    const { router, sent } = makeRouter({ localNodeId: 'B', neighbours: ['A', 'C', 'D'] });
    const encoded = encodeRouterFrame({
      msgId: 'm1', ttl: 3, payloadClass: 'text', origin: 'A', dest: BROADCAST_DEST, payload: 'p',
    });
    await router.accept(encoded, 'A');
    expect(sent).toHaveLength(1);
    expect(sent[0].to.sort()).toEqual(['C', 'D']);
  });

  it('stops forwarding when the TTL runs out', async () => {
    const { router, sent } = makeRouter({ localNodeId: 'B', neighbours: ['C'] });
    const encoded = encodeRouterFrame({
      msgId: 'm1', ttl: 1, payloadClass: 'text', origin: 'A', dest: BROADCAST_DEST, payload: 'p',
    });
    const outcome = await router.accept(encoded, 'A');
    // Still delivered locally — the last hop is a legitimate recipient.
    expect(outcome).toMatchObject({ action: 'deliver', forwarded: 0 });
    expect(sent).toHaveLength(0);
  });

  it('decrements the TTL by exactly one per hop', async () => {
    const { router, sent } = makeRouter({ localNodeId: 'B', neighbours: ['C'] });
    await router.accept(encodeRouterFrame({
      msgId: 'm1', ttl: 4, payloadClass: 'text', origin: 'A', dest: BROADCAST_DEST, payload: 'p',
    }), 'A');
    expect(frameFrom(sent[0].encoded).ttl).toBe(3);
  });

  it('does not relay a frame addressed to us', async () => {
    const { router, sent } = makeRouter({ localNodeId: 'C', neighbours: ['B', 'D'] });
    const outcome = await router.accept(encodeRouterFrame({
      msgId: 'm1', ttl: 3, payloadClass: 'text', origin: 'A', dest: 'C', payload: 'secret',
    }), 'B');
    expect(outcome).toEqual({ action: 'deliver', payload: 'secret', forwarded: 0 });
    expect(sent).toHaveLength(0);
  });

  it('relays a unicast frame meant for someone else without delivering it', async () => {
    const { router, sent } = makeRouter({ localNodeId: 'B', neighbours: ['C'] });
    const outcome = await router.accept(encodeRouterFrame({
      msgId: 'm1', ttl: 3, payloadClass: 'text', origin: 'A', dest: 'C', payload: 'secret',
    }), 'A');
    // 'relay' carries no payload: a relay must never hand ciphertext it cannot
    // read to the local delivery path.
    expect(outcome).toEqual({ action: 'relay', forwarded: 1 });
    expect(sent).toHaveLength(1);
  });
});

describe('router: the three-device gate (doc 33 §5, Phase 4)', () => {
  it('relays A to C through B when A and C cannot see each other', async () => {
    // The acceptance criterion for this phase, simulated end to end.
    const a = makeRouter({ localNodeId: 'A', neighbours: ['B'] });
    const b = makeRouter({ localNodeId: 'B', neighbours: ['A', 'C'] });
    const c = makeRouter({ localNodeId: 'C', neighbours: ['B'] });

    await a.router.originate({
      msgId: 'm1', payload: 'sealed-for-C', dest: 'C', payloadClass: 'text',
    });
    expect(a.sent[0].to).toEqual(['B']);

    const atB = await b.router.accept(a.sent[0].encoded, 'A');
    expect(atB).toEqual({ action: 'relay', forwarded: 1 });

    const atC = await c.router.accept(b.sent[0].encoded, 'B');
    expect(atC).toEqual({ action: 'deliver', payload: 'sealed-for-C', forwarded: 0 });
  });

  it('reaches C on a broadcast while B also delivers it locally', async () => {
    const b = makeRouter({ localNodeId: 'B', neighbours: ['A', 'C'] });
    const c = makeRouter({ localNodeId: 'C', neighbours: ['B'] });

    const atB = await b.router.accept(encodeRouterFrame({
      msgId: 'g1', ttl: 4, payloadClass: 'text',
      origin: 'A', dest: BROADCAST_DEST, payload: 'group-msg',
    }), 'A');
    // Both consumed AND relayed — that dual role is what makes group messaging
    // work across a partial mesh.
    expect(atB).toEqual({ action: 'deliver', payload: 'group-msg', forwarded: 1 });

    const atC = await c.router.accept(b.sent[0].encoded, 'B');
    expect(atC).toMatchObject({ action: 'deliver', payload: 'group-msg' });
  });
});

describe('router: store-and-forward', () => {
  it('holds a unicast frame for an unreachable destination and sends it on flush', async () => {
    const h = makeRouter({ localNodeId: 'A', neighbours: [] });
    const result = await h.router.originate({
      msgId: 'm1', payload: 'p', dest: 'C', payloadClass: 'text',
    });
    expect(result).toEqual({ delivered: 0, held: true });
    expect(h.router.pendingCount()).toBe(1);

    h.setNeighbours(['B']);
    expect(await h.router.flush()).toBe(1);
    expect(h.router.pendingCount()).toBe(0);
  });

  it('re-holds rather than dropping when still unreachable', async () => {
    const h = makeRouter({ localNodeId: 'A', neighbours: [] });
    await h.router.originate({ msgId: 'm1', payload: 'p', dest: 'C', payloadClass: 'text' });
    expect(await h.router.flush()).toBe(0);
    expect(h.router.pendingCount()).toBe(1);
  });

  it('does not extend the hold window across repeated flushes', async () => {
    // Re-holding with a fresh timestamp would make a frame immortal, quietly
    // defeating the 7-day cap.
    let clock = 1_000;
    const h = makeRouter({ localNodeId: 'A', neighbours: [], now: () => clock });
    await h.router.originate({ msgId: 'm1', payload: 'p', dest: 'C', payloadClass: 'text' });

    for (let i = 0; i < 5; i += 1) {
      clock += 24 * 60 * 60 * 1000;
      await h.router.flush();
    }
    expect(h.router.pendingCount()).toBe(1);

    clock += 3 * 24 * 60 * 60 * 1000;   // now past 7 days total
    await h.router.flush();
    expect(h.router.pendingCount()).toBe(0);
  });

  it('does not hold a broadcast with nobody to relay to', async () => {
    // Nobody to relay to means nothing to hold for; the origin's own queue is
    // what replays a group message.
    const h = makeRouter({ localNodeId: 'A', neighbours: [] });
    const result = await h.router.originate({
      msgId: 'g1', payload: 'p', dest: BROADCAST_DEST, payloadClass: 'text',
    });
    expect(result).toEqual({ delivered: 0, held: false });
    expect(h.router.pendingCount()).toBe(0);
  });
});

describe('router: backpressure', () => {
  it('drops bulk before text when the queue is over its byte cap', async () => {
    // A backed-up photo must never evict the text message the user is actually
    // waiting on.
    const h = makeRouter({ localNodeId: 'A', neighbours: [], queueByteCap: 100 });
    await h.router.originate({
      msgId: 'text-1', payload: 'x'.repeat(60), dest: 'C', payloadClass: 'text',
    });
    await h.router.originate({
      msgId: 'bulk-1', payload: 'y'.repeat(60), dest: 'C', payloadClass: 'bulk',
    });
    expect(h.router.pendingCount()).toBe(1);

    h.setNeighbours(['B']);
    await h.router.flush();
    expect(frameFrom(h.sent[0].encoded).msgId).toBe('text-1');
  });

  it('drops the oldest first within one class', async () => {
    let clock = 0;
    const h = makeRouter({
      localNodeId: 'A', neighbours: [], queueByteCap: 100, now: () => (clock += 10),
    });
    await h.router.originate({ msgId: 'old', payload: 'x'.repeat(60), dest: 'C', payloadClass: 'text' });
    await h.router.originate({ msgId: 'new', payload: 'y'.repeat(60), dest: 'C', payloadClass: 'text' });

    h.setNeighbours(['B']);
    await h.router.flush();
    expect(frameFrom(h.sent[0].encoded).msgId).toBe('new');
  });
});

describe('SeenSet', () => {
  it('evicts oldest beyond capacity so a long-lived mesh cannot leak', async () => {
    const seen = new SeenSet(3);
    ['a', 'b', 'c'].forEach((id) => seen.add(id));
    expect(seen.add('d')).toBe(true);
    expect(seen.has('a')).toBe(false);
    expect(seen.has('d')).toBe(true);
  });

  it('reports whether an id was new', () => {
    const seen = new SeenSet();
    expect(seen.add('x')).toBe(true);
    expect(seen.add('x')).toBe(false);
  });

  it('round-trips through snapshot/restore for restart persistence', () => {
    const seen = new SeenSet();
    seen.add('a');
    seen.add('b');
    const revived = new SeenSet();
    revived.restore(seen.snapshot());
    expect(revived.has('a')).toBe(true);
    expect(revived.add('b')).toBe(false);
  });
});
