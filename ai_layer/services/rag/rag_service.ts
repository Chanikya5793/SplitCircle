/**
 * rag_service.ts — Core Retrieval-Augmented Generation service for SplitCircle.
 *
 * queryExpenseRAG(): embed the query → search Vertex Vector Search with a per-user
 * `restricts` filter (the security boundary, Critical Rule #2) → hydrate the
 * authoritative expense docs from Firestore → build grounded context → generate a
 * cited answer with Gemini 2.5 Flash (Critical Rule #4) → return a structured result.
 *
 * Designed for dependency injection: the Vertex/Firestore/Gemini calls are passed
 * in as a `RAGDeps` object so the pipeline is unit-testable without live GCP
 * (see __tests__/rag_service.test.ts).
 */

import {
  applyFilters,
  estimateConfidence,
  formatContext,
  type ExpenseDocument,
  type RAGFilters,
} from './context_builder';
import { RAG_SYSTEM_PROMPT, buildUserPrompt } from './prompt_templates';

export interface RAGQuery {
  query: string;
  userId: string; // authenticated uid — MUST come from the token, not user input
  groupId?: string;
  filters?: {
    dateRange?: { start: Date; end: Date };
    categories?: string[];
    minAmount?: number;
    maxAmount?: number;
  };
  topK?: number; // default 10
}

export interface RAGResult {
  answer: string;
  sources: ExpenseDocument[];
  confidence: number;
  generationMetadata: {
    model: string;
    retrieved: number;
    used: number;
    cached: boolean;
    promptTokens?: number;
    candidateTokens?: number;
  };
}

export interface Neighbor { datapointId: string; distance: number }

/** Injectable dependencies — real impls wrap embedding_client / Firestore / Gemini. */
export interface RAGDeps {
  embedQuery: (text: string) => Promise<number[]>;
  /** Vector Search findNeighbors, already scoped by the userId restrict. */
  searchNeighbors: (vector: number[], opts: { userId: string; groupId?: string; topK: number }) => Promise<Neighbor[]>;
  /** Hydrate authoritative expense docs from Firestore by id. */
  hydrate: (expenseIds: string[]) => Promise<ExpenseDocument[]>;
  /** Generate a grounded answer; returns text + token usage. */
  generate: (system: string, user: string) => Promise<{ text: string; promptTokens?: number; candidateTokens?: number }>;
  /** Optional cache (Memorystore). */
  cacheGet?: (key: string) => Promise<RAGResult | null>;
  cacheSet?: (key: string, value: RAGResult) => Promise<void>;
  model?: string;
}

function toMsFilters(f: RAGQuery['filters']): RAGFilters | undefined {
  if (!f) return undefined;
  return {
    dateRange: f.dateRange ? { start: f.dateRange.start.getTime(), end: f.dateRange.end.getTime() } : undefined,
    categories: f.categories,
    minAmount: f.minAmount,
    maxAmount: f.maxAmount,
  };
}

function cacheKey(q: RAGQuery): string {
  return JSON.stringify({
    q: q.query.trim().toLowerCase(),
    u: q.userId,
    g: q.groupId ?? null,
    f: toMsFilters(q.filters) ?? null,
    k: q.topK ?? 10,
  });
}

/**
 * Run the full RAG pipeline. Throws if `userId` is missing (refuse to query
 * without an authenticated scope — never search across all users).
 */
export async function queryExpenseRAG(q: RAGQuery, deps: RAGDeps): Promise<RAGResult> {
  if (!q.userId) throw new Error('queryExpenseRAG: userId (authenticated scope) is required');
  if (!q.query?.trim()) throw new Error('queryExpenseRAG: query is required');

  const model = deps.model ?? 'gemini-2.5-flash';
  const topK = q.topK ?? 10;
  const key = cacheKey(q);

  if (deps.cacheGet) {
    const cached = await deps.cacheGet(key);
    if (cached) return { ...cached, generationMetadata: { ...cached.generationMetadata, cached: true } };
  }

  // 1. Embed query (same model family as ingestion).
  const vector = await deps.embedQuery(q.query);

  // 2. Vector search, scoped to the authenticated user (+ optional group).
  const neighbors = await deps.searchNeighbors(vector, { userId: q.userId, groupId: q.groupId, topK });
  const retrieved = neighbors.length;

  // 3. Hydrate authoritative docs (vectors can lag; Firestore is source of truth).
  const ids = neighbors.map((n) => n.datapointId);
  const hydrated = await deps.hydrate(ids);

  // Preserve neighbor ranking order after hydration.
  const order = new Map(ids.map((id, i) => [id, i]));
  hydrated.sort((a, b) => (order.get(a.expenseId) ?? 0) - (order.get(b.expenseId) ?? 0));

  // 4. Post-retrieval filtering the index couldn't express.
  const filtered = applyFilters(hydrated, toMsFilters(q.filters));

  // 5. Build grounded context + prompt.
  const context = formatContext(filtered);
  const currencyHint = filtered[0]?.currency;
  const userPrompt = buildUserPrompt({ question: q.query, context, currencyHint });

  // 6. Generate grounded, cited answer.
  const gen = filtered.length === 0
    ? { text: "I couldn't find any of your expenses matching that. Try a narrower question (e.g. a category or date range).", promptTokens: 0, candidateTokens: 0 }
    : await deps.generate(RAG_SYSTEM_PROMPT, userPrompt);

  const result: RAGResult = {
    answer: gen.text,
    sources: filtered,
    confidence: estimateConfidence(retrieved, filtered.length),
    generationMetadata: {
      model,
      retrieved,
      used: filtered.length,
      cached: false,
      promptTokens: gen.promptTokens,
      candidateTokens: gen.candidateTokens,
    },
  };

  if (deps.cacheSet) await deps.cacheSet(key, result);
  return result;
}
