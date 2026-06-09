/**
 * rag_deps.ts — Production RAGDeps adapter: wires the pure RAG pipeline
 * (rag_service.ts) to live Vertex/Vector-Search/Gemini (vertex_client.ts) and
 * Firestore. This is the concrete implementation the Cloud Run RAG service uses.
 *
 * The headline piece is `hydrate`: because expenses are EMBEDDED in
 * `groups/{gid}.expenses[]` (Phase 1), the datapoint id is `${gid}:${expenseId}`
 * and hydration reads the group doc(s) and pulls each expense out of the array —
 * resolving payer/participant display names from `members[]`. The mapping is a
 * PURE function (`expenseDocFromGroup`) so it is unit-tested without Firestore.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp, getApps } from 'firebase-admin/app';
import { queryExpenseRAG, type RAGDeps, type RAGQuery, type RAGResult, type ExpenseRef } from './rag_service';
import type { ExpenseDocument } from './context_builder';
import { embedQuery, findNeighbors, generate } from './vertex_client';

if (getApps().length === 0) initializeApp();

/** Build a `{userId: displayName}` map from a group's members[] (+ archived). */
export function memberNameMap(groupData: Record<string, any>): Record<string, string> {
  const map: Record<string, string> = {};
  const all = [
    ...(Array.isArray(groupData.members) ? groupData.members : []),
    ...(Array.isArray(groupData.archivedMembers) ? groupData.archivedMembers : []),
  ];
  for (const m of all) if (m?.userId) map[m.userId] = m.displayName ?? '';
  return map;
}

/**
 * PURE: extract one expense from an embedded group doc → ExpenseDocument.
 * Tolerates the `title`/`description` drift (Finding 2) and resolves names.
 */
export function expenseDocFromGroup(
  groupData: Record<string, any> | undefined,
  groupId: string,
  expenseId: string,
): ExpenseDocument | null {
  if (!groupData) return null;
  const expenses = Array.isArray(groupData.expenses) ? groupData.expenses : [];
  const e = expenses.find((x: any) => x?.expenseId === expenseId);
  if (!e) return null;

  const names = memberNameMap(groupData);
  const participantNames = (Array.isArray(e.participants) ? e.participants : [])
    .map((p: any) => names[p?.userId])
    .filter((n: string | undefined): n is string => Boolean(n));

  return {
    expenseId: e.expenseId,
    groupId,
    title: e.title ?? e.description,
    description: e.description,
    category: e.category,
    amount: typeof e.amount === 'number' ? e.amount : Number(e.amount) || 0,
    currency: groupData.currency,
    paidBy: e.paidBy,
    paidByName: names[e.paidBy],
    participantNames,
    notes: e.notes,
    createdAt: typeof e.createdAt === 'number' ? e.createdAt : undefined,
  };
}

/**
 * Hydrate refs (parsed from `${gid}:${expenseId}` datapoint ids) by batch-reading
 * the distinct group docs and pulling each expense from the embedded array.
 * Firestore is authoritative (vectors can lag). Membership is implicit: the
 * vector restricts already scoped results to the caller's uid.
 */
export async function hydrateFromFirestore(refs: ExpenseRef[]): Promise<ExpenseDocument[]> {
  const db = getFirestore();
  const groupIds = Array.from(new Set(refs.map((r) => r.groupId).filter((g): g is string => Boolean(g))));
  if (groupIds.length === 0) return [];

  const snaps = await db.getAll(...groupIds.map((g) => db.collection('groups').doc(g)));
  const byId = new Map<string, Record<string, any> | undefined>();
  for (const s of snaps) byId.set(s.id, s.exists ? s.data() : undefined);

  const out: ExpenseDocument[] = [];
  for (const ref of refs) {
    if (!ref.groupId) continue;
    const doc = expenseDocFromGroup(byId.get(ref.groupId), ref.groupId, ref.expenseId);
    if (doc) out.push(doc);
  }
  return out;
}

/** Assemble the production RAGDeps. Cache is left optional (wire Memorystore here). */
export function buildRAGDeps(): RAGDeps {
  return {
    embedQuery,
    searchNeighbors: (vector, opts) => findNeighbors(vector, opts),
    hydrate: hydrateFromFirestore,
    generate,
  };
}

/** Convenience entry: run a query end-to-end against the live backend. */
export function runExpenseQuery(q: RAGQuery): Promise<RAGResult> {
  return queryExpenseRAG(q, buildRAGDeps());
}
