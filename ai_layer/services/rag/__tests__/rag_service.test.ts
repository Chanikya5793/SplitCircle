/**
 * rag_service.test.ts — Unit tests for the RAG pipeline using injected fakes.
 * No live Vertex/Firestore/Gemini required (Critical Rule #7).
 */

import { describe, it, expect, vi } from 'vitest';
import { queryExpenseRAG, type RAGDeps } from '../rag_service';
import {
  applyFilters,
  formatContext,
  estimateConfidence,
  type ExpenseDocument,
} from '../context_builder';

const docs: ExpenseDocument[] = [
  { expenseId: 'e1', groupId: 'g1', title: 'Dinner', category: 'food', amount: 40, currency: '$', paidBy: 'u1', paidByName: 'Alex', participantNames: ['Alex', 'Sam'], createdAt: Date.parse('2026-05-10') },
  { expenseId: 'e2', groupId: 'g1', title: 'Taxi', category: 'transport', amount: 18, currency: '$', paidBy: 'u2', paidByName: 'Sam', createdAt: Date.parse('2026-05-11') },
];

function makeDeps(overrides: Partial<RAGDeps> = {}): RAGDeps {
  return {
    embedQuery: vi.fn(async () => new Array(768).fill(0.01)),
    searchNeighbors: vi.fn(async () => [
      { datapointId: 'e1', distance: 0.1 },
      { datapointId: 'e2', distance: 0.2 },
    ]),
    hydrate: vi.fn(async (ids: string[]) => docs.filter((d) => ids.includes(d.expenseId))),
    generate: vi.fn(async () => ({ text: 'You spent $40 on dinner [1].', promptTokens: 120, candidateTokens: 12 })),
    ...overrides,
  };
}

describe('queryExpenseRAG', () => {
  it('runs the full pipeline and returns a cited answer + sources', async () => {
    const deps = makeDeps();
    const res = await queryExpenseRAG({ query: 'what did I spend on dinner?', userId: 'u1' }, deps);
    expect(res.answer).toContain('[1]');
    expect(res.sources).toHaveLength(2);
    expect(res.generationMetadata.retrieved).toBe(2);
    expect(res.confidence).toBeGreaterThan(0);
  });

  it('refuses to query without an authenticated userId (security boundary)', async () => {
    await expect(
      queryExpenseRAG({ query: 'x', userId: '' }, makeDeps()),
    ).rejects.toThrow(/userId/);
  });

  it('passes the userId scope to the vector search', async () => {
    const deps = makeDeps();
    await queryExpenseRAG({ query: 'food', userId: 'u-secret', groupId: 'g1' }, deps);
    expect(deps.searchNeighbors).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ userId: 'u-secret', groupId: 'g1' }),
    );
  });

  it('does not call the LLM when nothing is retrieved', async () => {
    const deps = makeDeps({ searchNeighbors: vi.fn(async () => []), hydrate: vi.fn(async () => []) });
    const res = await queryExpenseRAG({ query: 'anything', userId: 'u1' }, deps);
    expect(deps.generate).not.toHaveBeenCalled();
    expect(res.confidence).toBe(0);
    expect(res.sources).toHaveLength(0);
  });

  it('serves from cache on a hit and marks the result cached', async () => {
    const cached = {
      answer: 'cached', sources: [], confidence: 0.9,
      generationMetadata: { model: 'gemini-2.5-flash', retrieved: 1, used: 1, cached: false },
    };
    const deps = makeDeps({ cacheGet: vi.fn(async () => cached) });
    const res = await queryExpenseRAG({ query: 'x', userId: 'u1' }, deps);
    expect(res.answer).toBe('cached');
    expect(res.generationMetadata.cached).toBe(true);
    expect(deps.embedQuery).not.toHaveBeenCalled();
  });

  it('preserves neighbor ranking order after hydration', async () => {
    const deps = makeDeps({
      searchNeighbors: vi.fn(async () => [
        { datapointId: 'e2', distance: 0.1 },
        { datapointId: 'e1', distance: 0.2 },
      ]),
    });
    const res = await queryExpenseRAG({ query: 'x', userId: 'u1' }, deps);
    expect(res.sources.map((s) => s.expenseId)).toEqual(['e2', 'e1']);
  });
});

describe('context_builder', () => {
  it('numbers context lines for citation', () => {
    const ctx = formatContext(docs);
    expect(ctx).toContain('[1]');
    expect(ctx).toContain('[2]');
    expect(ctx).toContain('Dinner');
  });

  it('filters by category and amount', () => {
    const out = applyFilters(docs, { categories: ['food'], minAmount: 20 });
    expect(out).toHaveLength(1);
    expect(out[0].expenseId).toBe('e1');
  });

  it('filters by date range', () => {
    const out = applyFilters(docs, { dateRange: { start: Date.parse('2026-05-11'), end: Date.parse('2026-05-12') } });
    expect(out.map((d) => d.expenseId)).toEqual(['e2']);
  });

  it('confidence is 0 with no docs, higher with full coverage', () => {
    expect(estimateConfidence(5, 0)).toBe(0);
    expect(estimateConfidence(5, 5)).toBeGreaterThan(estimateConfidence(5, 1));
  });
});
