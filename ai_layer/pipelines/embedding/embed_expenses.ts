/**
 * embed_expenses.ts — Streaming embedding pipeline for SplitCircle expenses (RAG-01/02/07).
 *
 * Triggers on `groups/{groupId}` writes (Phase 1: expenses are embedded arrays),
 * diffs the new/changed expenses, builds a compact embedding text, calls Vertex
 * `text-embedding-005` (768-dim), and UPSERTS datapoints into Vertex AI Vector
 * Search — namespaced by participant uids + groupId so a user can only ever
 * retrieve their own expenses (Critical Rule #2).
 *
 * Idempotency (Critical Rule #5): we hash the embedding text; if a per-group
 * `_embedHashes/{expenseId}` doc already holds the same hash, we skip. The hash
 * doc is the "embeddingId stored for reverse lookup" required by the spec.
 *
 * PII (Critical Rule #3): the embedding text deliberately EXCLUDES email/phone;
 * it includes title/category/notes/participant display names (needed for recall).
 * The raw text is never logged.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import * as logger from 'firebase-functions/logger';
import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp, getApps } from 'firebase-admin/app';
import { createHash } from 'node:crypto';
import { buildEmbeddingText, embedText, upsertDatapoint } from './embedding_client';

if (getApps().length === 0) initializeApp();
const db = getFirestore();

interface RawExpense {
  expenseId: string;
  title?: string;
  description?: string;
  category?: string;
  amount?: number;
  notes?: string;
  paidBy?: string;
  participants?: Array<{ userId?: string }>;
  createdAt?: number;
  updatedAt?: number;
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export const embedGroupExpenses = onDocumentWritten('groups/{groupId}', async (event) => {
  const after = event.data?.after?.data();
  const groupId = event.params.groupId;
  if (!after) return; // delete handled by erasure path (Phase 4 §7)

  const currency = (after.currency as string) || 'USD';
  const expenses: RawExpense[] = Array.isArray(after.expenses) ? after.expenses : [];
  if (expenses.length === 0) return;

  // Resolve member display names once (for richer, recallable embedding text).
  const nameById: Record<string, string> = {};
  for (const m of (Array.isArray(after.members) ? after.members : [])) {
    if (m?.userId) nameById[m.userId] = m.displayName ?? '';
  }

  let embedded = 0;
  let skipped = 0;

  for (const e of expenses) {
    if (!e?.expenseId) continue;

    const participantUids = (e.participants ?? [])
      .map((p) => p.userId)
      .filter((id): id is string => typeof id === 'string');
    // Index visibility = everyone who can already see the expense.
    const allowedUids = Array.from(new Set([e.paidBy, ...participantUids].filter(Boolean))) as string[];

    const text = buildEmbeddingText({
      title: e.title ?? e.description,
      category: e.category,
      amount: e.amount,
      currency,
      notes: e.notes,
      createdAt: e.createdAt,
      participantNames: participantUids.map((id) => nameById[id]).filter(Boolean),
    });
    const hash = contentHash(text);

    // Idempotency check / reverse-lookup record.
    const hashRef = db.doc(`groups/${groupId}/_embedHashes/${e.expenseId}`);
    const existing = await hashRef.get();
    if (existing.exists && existing.data()?.hash === hash) {
      skipped += 1;
      continue;
    }

    try {
      const vector = await embedText(text);
      await upsertDatapoint({
        datapointId: e.expenseId,
        featureVector: vector,
        restricts: [
          { namespace: 'user', allowList: allowedUids },
          { namespace: 'group', allowList: [groupId] },
        ],
        numericRestricts: [
          { namespace: 'amount', valueFloat: typeof e.amount === 'number' ? e.amount : 0 },
          { namespace: 'created_at_ms', valueLong: e.createdAt ?? 0 },
        ],
      });
      await hashRef.set({ hash, embeddingId: e.expenseId, updatedAt: Date.now() });
      embedded += 1;
    } catch (err) {
      logger.error('Embed/upsert failed for expense', {
        groupId, expenseId: e.expenseId,
        error: err instanceof Error ? err.message : 'unknown',
      });
      // Continue with the rest; the trigger will retry on next write.
    }
  }

  logger.info('Embedded group expenses', { groupId, embedded, skipped, total: expenses.length });
});
