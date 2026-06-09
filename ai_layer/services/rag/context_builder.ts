/**
 * context_builder.ts — Formats retrieved expense documents into LLM context.
 *
 * Pure, deterministic, and unit-tested: given hydrated expense docs, produces a
 * numbered context block (the numbers are the citation handles used by the model)
 * and applies post-retrieval filters the vector index didn't cover.
 */

export interface ExpenseDocument {
  expenseId: string;
  groupId: string;
  title?: string;
  description?: string;
  category?: string;
  amount: number;
  currency?: string;
  paidBy?: string;
  paidByName?: string;
  participantNames?: string[];
  notes?: string;
  createdAt?: number;
}

export interface RAGFilters {
  dateRange?: { start: number; end: number }; // epoch ms
  categories?: string[];
  minAmount?: number;
  maxAmount?: number;
}

/** Apply filters the ANN index could not express (or to double-check it). */
export function applyFilters(docs: ExpenseDocument[], filters?: RAGFilters): ExpenseDocument[] {
  if (!filters) return docs;
  return docs.filter((d) => {
    if (filters.dateRange && typeof d.createdAt === 'number') {
      if (d.createdAt < filters.dateRange.start || d.createdAt > filters.dateRange.end) return false;
    }
    if (filters.categories && filters.categories.length > 0) {
      if (!d.category || !filters.categories.includes(d.category)) return false;
    }
    if (typeof filters.minAmount === 'number' && d.amount < filters.minAmount) return false;
    if (typeof filters.maxAmount === 'number' && d.amount > filters.maxAmount) return false;
    return true;
  });
}

/** One context line per expense, numbered for citation. */
export function formatContext(docs: ExpenseDocument[]): string {
  if (docs.length === 0) return '(no matching expenses found)';
  return docs
    .map((d, i) => {
      const title = d.title ?? d.description ?? 'Untitled';
      const date = d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : 'unknown date';
      const amount = `${d.currency ?? ''}${d.amount.toFixed(2)}`;
      const payer = d.paidByName ?? d.paidBy ?? 'someone';
      const people = d.participantNames && d.participantNames.length > 0
        ? ` with ${d.participantNames.join(', ')}` : '';
      const cat = d.category ? ` [${d.category}]` : '';
      const notes = d.notes ? ` — ${d.notes}` : '';
      return `[${i + 1}] ${date}: "${title}"${cat} ${amount}, paid by ${payer}${people}${notes}`;
    })
    .join('\n');
}

/**
 * Heuristic confidence: blends retrieval coverage (how many of topK survived
 * filtering) with whether any docs were found at all. Real systems can replace
 * this with model logprobs or a RAGAS faithfulness score.
 */
export function estimateConfidence(retrieved: number, afterFilter: number): number {
  if (afterFilter === 0) return 0;
  const coverage = Math.min(1, afterFilter / Math.max(1, retrieved));
  return Math.round((0.5 + 0.5 * coverage) * 100) / 100;
}
