/**
 * ragClient.test.ts — Unit tests for the optional RAG-service client used by
 * search_expenses. Verifies the response mapping and the configured/unconfigured
 * behavior (fetch is mocked; no network).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mapRagResponse } from '../lib/ragClient.js';

describe('mapRagResponse', () => {
  it('maps RAG sources to Expense[] and keeps the grounded answer', () => {
    const json = {
      answer: 'You spent $58 [1][2].',
      sources: [
        { expenseId: 'e1', groupId: 'g1', title: 'Dinner', category: 'food', amount: 40, paidBy: 'u1', createdAt: 111 },
        { expenseId: 'e2', groupId: 'g1', description: 'Taxi', amount: 18, paidBy: 'u2', createdAt: 222 },
      ],
    };
    const hit = mapRagResponse(json, 10);
    expect(hit.answer).toBe('You spent $58 [1][2].');
    expect(hit.results).toHaveLength(2);
    expect(hit.results[0]).toMatchObject({ expenseId: 'e1', title: 'Dinner', amount: 40, splitType: 'custom' });
    expect(hit.results[1].title).toBe('Taxi'); // description fallback
  });

  it('respects the limit and tolerates an empty/odd payload', () => {
    const json = { answer: '', sources: [{ expenseId: 'a' }, { expenseId: 'b' }, { expenseId: 'c' }] };
    expect(mapRagResponse(json, 2).results).toHaveLength(2);
    expect(mapRagResponse({}, 10)).toEqual({ results: [], answer: '' });
  });
});

describe('makeRagSearch', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.resetModules(); });
  beforeEach(() => { vi.resetModules(); });

  it('returns undefined when RAG_SERVICE_URL is not set', async () => {
    delete process.env.RAG_SERVICE_URL;
    delete process.env.RAG_SHARED_SECRET;
    const { makeRagSearch } = await import('../lib/ragClient.js');
    expect(makeRagSearch()).toBeUndefined();
  });

  it('returns undefined when the URL is set but the shared secret is missing', async () => {
    process.env.RAG_SERVICE_URL = 'https://rag.example';
    delete process.env.RAG_SHARED_SECRET;
    const { makeRagSearch } = await import('../lib/ragClient.js');
    expect(makeRagSearch()).toBeUndefined(); // would 401 every call; fall back to substring
  });

  it('returns a fn that calls the RAG service and maps the result', async () => {
    process.env.RAG_SERVICE_URL = 'https://rag.example';
    process.env.RAG_SHARED_SECRET = 'shh';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ answer: 'a', sources: [{ expenseId: 'e1', amount: 5 }] }),
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const { makeRagSearch } = await import('../lib/ragClient.js');
    const fn = makeRagSearch();
    expect(fn).toBeDefined();
    const hit = await fn!('u1', 'food?', 'g1', 10);

    expect(hit.results[0].expenseId).toBe('e1');
    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe('https://rag.example/query');
    expect(JSON.parse(init.body)).toMatchObject({ query: 'food?', userId: 'u1', groupId: 'g1', topK: 10 });
    expect(init.headers['x-rag-secret']).toBe('shh');
  });
});
