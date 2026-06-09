/**
 * server.test.ts — Unit tests for the RAG HTTP service's pure request helpers
 * (auth + body parsing). The module is imported dynamically after the shared
 * secret is set so the module-level constant picks it up.
 */

import { describe, it, expect, beforeAll } from 'vitest';

let mod: typeof import('../server');

beforeAll(async () => {
  process.env.RAG_SHARED_SECRET = 'shh';
  mod = await import('../server');
});

describe('authorize', () => {
  it('accepts a matching secret', () => {
    expect(() => mod.authorize('shh')).not.toThrow();
  });
  it('rejects a wrong/missing secret', () => {
    expect(() => mod.authorize('nope')).toThrow(mod.Unauthorized);
    expect(() => mod.authorize(undefined)).toThrow(mod.Unauthorized);
  });
});

describe('parseQueryBody', () => {
  it('requires query and userId', () => {
    expect(() => mod.parseQueryBody({ userId: 'u1' })).toThrow(mod.BadRequest);
    expect(() => mod.parseQueryBody({ query: 'hi' })).toThrow(mod.BadRequest);
  });

  it('parses a minimal body', () => {
    const q = mod.parseQueryBody({ query: 'food?', userId: 'u1' });
    expect(q).toMatchObject({ query: 'food?', userId: 'u1', groupId: undefined, topK: undefined });
  });

  it('converts a numeric dateRange to Date objects and passes filters through', () => {
    const start = Date.parse('2026-05-01');
    const end = Date.parse('2026-05-31');
    const q = mod.parseQueryBody({
      query: 'x', userId: 'u1', groupId: 'g1', topK: 5,
      filters: { dateRange: { start, end }, categories: ['food'], minAmount: 10 },
    });
    expect(q.groupId).toBe('g1');
    expect(q.topK).toBe(5);
    expect(q.filters?.dateRange?.start).toBeInstanceOf(Date);
    expect(q.filters?.dateRange?.start.getTime()).toBe(start);
    expect(q.filters?.categories).toEqual(['food']);
    expect(q.filters?.minAmount).toBe(10);
  });
});
