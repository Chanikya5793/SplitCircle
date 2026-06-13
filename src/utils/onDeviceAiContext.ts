/**
 * onDeviceAiContext.ts — builds the grounding context for the on-device
 * Apple Foundation Models assistant (modules/splitcircle-ai `askOnDevice`).
 *
 * The group's expenses are already on the device (embedded array), so
 * "retrieval" is a local rank-and-trim: score each expense against the
 * question (keyword overlap + recency), keep the best N, and render them as
 * compact numbered lines the model can cite by index. The combined
 * input+output budget of the on-device model is 4096 tokens, hence the hard
 * line cap and trimmed fields. Pure module — no native/RN imports.
 */

import type { Expense } from '../models/expense';

export interface ContextMemberName {
  userId: string;
  displayName: string;
}

export interface ExpenseContext {
  /** Numbered lines, `[1] …` — the prompt context. */
  context: string;
  /** Expenses behind each line; `selected[i]` backs line `[i + 1]`. */
  selected: Expense[];
}

/**
 * Hard ceiling on context lines regardless of how big the window is — beyond
 * this, on-device latency and answer quality stop improving. Capable hardware
 * (iPhone Air / 17 Pro running Apple's larger "Core Advanced" model) reports a
 * bigger `contextSize` and so packs closer to this ceiling; base devices stay
 * well below it.
 */
export const MAX_CONTEXT_EXPENSES = 120;
/** Floor so even a tiny window still grounds the answer in some history. */
export const MIN_CONTEXT_EXPENSES = 15;
/** Conservative default window (tokens) when the device can't report one. */
export const DEFAULT_CONTEXT_TOKENS = 4096;

// Rough budgeting constants (deliberately conservative so we never overflow the
// real window — the on-device model throws if the prompt exceeds contextSize).
const APPROX_TOKENS_PER_LINE = 45; // a dated, currency-bearing expense line
const RESERVE_TOKENS = 900; // system instructions + question + room for the answer

const MAX_TITLE_CHARS = 48;

/**
 * How many ranked expense lines to include given the model's real context
 * window (tokens). Larger window → more grounding → better answers on capable
 * hardware; clamped to [MIN, MAX]. A non-positive/unknown window falls back to
 * the conservative default budget.
 */
export function maxExpensesForContext(contextTokens: number): number {
  const window = contextTokens > 0 ? contextTokens : DEFAULT_CONTEXT_TOKENS;
  const usable = window - RESERVE_TOKENS;
  const fit = Math.floor(usable / APPROX_TOKENS_PER_LINE);
  return Math.max(MIN_CONTEXT_EXPENSES, Math.min(MAX_CONTEXT_EXPENSES, fit));
}

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);

const isoDate = (ms: number): string => {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : 'unknown-date';
};

/**
 * Rank expenses for a question: keyword matches on title/category/payer-name
 * dominate; recency breaks ties so "latest" style questions stay answerable.
 */
export function rankExpenses(
  expenses: readonly Expense[],
  question: string,
  members: readonly ContextMemberName[],
  maxLines: number = MAX_CONTEXT_EXPENSES,
): Expense[] {
  const qTokens = new Set(tokenize(question));
  const nameOf = new Map(members.map((m) => [m.userId, m.displayName]));

  const scored = expenses.map((e, i) => {
    const haystack = tokenize(
      `${e.title} ${e.category} ${nameOf.get(e.paidBy) ?? ''}`,
    );
    let matches = 0;
    for (const t of haystack) if (qTokens.has(t)) matches += 1;
    return { e, score: matches * 1000 + i };
  });

  // `i` preserves array order (chronological in the embedded array), so the
  // tiebreak inside an equal match count is "most recent first" after sorting.
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, maxLines))
    .map((s) => s.e);
}

/**
 * Build the numbered context block. Lines are chronological so date-range
 * questions read naturally; the mapping array preserves line→expense lookup
 * for citation handling.
 */
export function buildExpenseContext(
  expenses: readonly Expense[],
  question: string,
  members: readonly ContextMemberName[],
  currency: string,
  maxLines: number = MAX_CONTEXT_EXPENSES,
): ExpenseContext {
  const nameOf = new Map(members.map((m) => [m.userId, m.displayName]));
  const selected = rankExpenses(expenses, question, members, maxLines).sort(
    (a, b) => a.createdAt - b.createdAt,
  );

  const lines = selected.map((e, i) => {
    const title = e.title.length > MAX_TITLE_CHARS ? `${e.title.slice(0, MAX_TITLE_CHARS)}…` : e.title;
    const payer = nameOf.get(e.paidBy) ?? 'someone';
    const people = e.participants.length;
    return `[${i + 1}] ${isoDate(e.createdAt)} | ${title} | ${e.category} | ${e.amount.toFixed(2)} ${currency} | paid by ${payer} | split between ${people}${e.settled ? ' | settled' : ''}`;
  });

  return { context: lines.join('\n'), selected };
}

/**
 * Map the model's 1-based citation indexes back to expenses, dropping
 * out-of-range or duplicate indexes (small models occasionally hallucinate
 * citation numbers; never let that crash the UI).
 */
export function resolveCitedExpenses(
  sourceIndexes: readonly number[],
  selected: readonly Expense[],
): Expense[] {
  const seen = new Set<number>();
  const cited: Expense[] = [];
  for (const idx of sourceIndexes) {
    if (!Number.isInteger(idx) || idx < 1 || idx > selected.length || seen.has(idx)) continue;
    seen.add(idx);
    cited.push(selected[idx - 1]);
  }
  return cited;
}
