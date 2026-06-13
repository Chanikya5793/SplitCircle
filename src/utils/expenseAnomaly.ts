/**
 * expenseAnomaly.ts — pure, on-device heuristics that flag likely-problem
 * expenses as the user adds one: a probable duplicate, or an unusually large
 * amount for the group. No model/network — deterministic and unit-tested.
 */

import type { Expense } from '@/models/expense';

export type ExpenseAnomalyType = 'duplicate' | 'unusually_large';

export interface ExpenseAnomaly {
  type: ExpenseAnomalyType;
  message: string;
}

export interface AnomalyInput {
  title: string;
  amount: number;
  /** Defaults to now; used to scope the duplicate window. */
  createdAt?: number;
  /** Exclude this expense id from history (when editing). */
  excludeExpenseId?: string;
}

const DUPLICATE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const SIMILAR_TITLE_THRESHOLD = 0.6;
const LARGE_MULTIPLE = 4; // flag at ≥ 4× the typical (median) amount
const MIN_HISTORY_FOR_LARGE = 5;
const AMOUNT_EPSILON = 0.01;

const tokenize = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2),
  );

const titleSimilarity = (a: string, b: string): number => {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  ta.forEach((t) => {
    if (tb.has(t)) overlap += 1;
  });
  return overlap / Math.max(ta.size, tb.size);
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const formatAmount = (n: number): string => n.toFixed(2);

/**
 * Detect anomalies for a candidate expense against the group's existing
 * expenses. Returns zero or more flags (duplicate and/or unusually large).
 */
export function detectExpenseAnomalies(
  input: AnomalyInput,
  history: readonly Expense[],
): ExpenseAnomaly[] {
  const anomalies: ExpenseAnomaly[] = [];
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return anomalies;

  const now = input.createdAt ?? Date.now();
  const others = (history ?? []).filter((e) => e && e.expenseId !== input.excludeExpenseId);

  // ── Duplicate: same amount + similar title within the recent window ──
  const duplicate = others.find(
    (e) =>
      Math.abs((e.amount ?? 0) - amount) <= AMOUNT_EPSILON &&
      Math.abs(now - (e.createdAt ?? 0)) <= DUPLICATE_WINDOW_MS &&
      titleSimilarity(input.title ?? '', e.title ?? '') >= SIMILAR_TITLE_THRESHOLD,
  );
  if (duplicate) {
    anomalies.push({
      type: 'duplicate',
      message: `Looks like a possible duplicate of "${duplicate.title}" (${formatAmount(duplicate.amount)}) added recently.`,
    });
  }

  // ── Unusually large: ≥ LARGE_MULTIPLE × the typical (median) amount ──
  const amounts = others
    .map((e) => Number(e.amount))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (amounts.length >= MIN_HISTORY_FOR_LARGE) {
    const typical = median(amounts);
    if (typical > 0 && amount >= typical * LARGE_MULTIPLE) {
      anomalies.push({
        type: 'unusually_large',
        message: `This is much larger than usual for this group (typical is around ${formatAmount(typical)}). Double-check the amount.`,
      });
    }
  }

  return anomalies;
}
