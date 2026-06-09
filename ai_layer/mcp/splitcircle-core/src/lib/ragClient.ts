/**
 * ragClient.ts — Optional RAG-service client for `search_expenses`.
 *
 * If `RAG_SERVICE_URL` is configured, returns a `RagSearchFn` that calls the RAG
 * Cloud Run service (the user is already authenticated by this MCP server; the
 * verified `uid` is forwarded and the hop is secured by a shared secret + IAM).
 * If not configured, returns `undefined` so `FirestoreDataAccess` falls back to
 * its substring scan — keeping the server runnable without the RAG backend.
 *
 * The response mapper is PURE so it is unit-tested without a network call.
 */

import type { RagSearchFn } from './firestore.js';
import type { Expense } from './types.js';
import type { SearchHit } from './dataAccess.js';

const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || '';
const RAG_SHARED_SECRET = process.env.RAG_SHARED_SECRET || '';

/** PURE: map a RAG service response ({answer, sources[]}) to a SearchHit. */
export function mapRagResponse(json: any, limit: number): SearchHit {
  const sources = Array.isArray(json?.sources) ? json.sources : [];
  const results: Expense[] = sources.slice(0, limit).map((s: any) => ({
    expenseId: s.expenseId ?? '',
    groupId: s.groupId ?? '',
    title: s.title ?? s.description ?? '',
    category: s.category ?? '',
    amount: typeof s.amount === 'number' ? s.amount : 0,
    paidBy: s.paidBy ?? '',
    splitType: 'custom',
    participants: [],
    notes: s.notes,
    createdAt: typeof s.createdAt === 'number' ? s.createdAt : 0,
    updatedAt: typeof s.createdAt === 'number' ? s.createdAt : 0,
  }));
  return { results, answer: typeof json?.answer === 'string' ? json.answer : '' };
}

/**
 * Build the RAG-backed search fn, or undefined if RAG is not fully configured.
 * BOTH the URL and the shared secret are required — a URL without the secret
 * would 401 on every call and defeat the intended substring fallback.
 */
export function makeRagSearch(): RagSearchFn | undefined {
  if (!RAG_SERVICE_URL || !RAG_SHARED_SECRET) return undefined;
  return async (uid: string, query: string, groupId: string | undefined, limit: number): Promise<SearchHit> => {
    const res = await fetch(`${RAG_SERVICE_URL.replace(/\/$/, '')}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-rag-secret': RAG_SHARED_SECRET },
      body: JSON.stringify({ query, userId: uid, groupId, topK: limit }),
    });
    if (!res.ok) throw new Error(`RAG service error ${res.status}`);
    return mapRagResponse(await res.json(), limit);
  };
}
