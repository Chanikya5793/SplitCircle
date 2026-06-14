/**
 * expenseAnalytics.ts — deterministic, on-device analytics over a group's
 * expenses + settlements. This is the "index": exact precomputed numbers
 * (per-category, per-user, per-month totals, balances) so the AI assistant
 * NEVER has to do arithmetic — the #1 cause of wrong answers. Pure module, no
 * RN/native imports (fully unit-tested).
 *
 * Reuses the app's canonical balance math (`debtMinimizer`) so AI answers match
 * what the Balances/Settle-up UI shows exactly.
 */

import type { Expense } from '@/models/expense';
import type { Settlement } from '@/models/group';
import { calculateBalancesFromExpenses, minimizeDebts, type Debt } from './debtMinimizer';

// The app treats recorded settlements stored as expenses with this category as
// non-spend; exclude from spend aggregates (mirrors SpendingChart).
const NON_SPEND_CATEGORY = 'settlement';

export interface CategoryAgg {
  category: string;
  total: number;
  userShare: number;
  count: number;
}

export interface PeriodAgg {
  total: number;
  userShare: number;
  count: number;
}

export interface ExpenseAnalytics {
  count: number;
  totalSpend: number;
  /** Current user's summed share across all expenses. */
  userShareTotal: number;
  /** Total the current user paid (paidBy === user). */
  userPaidTotal: number;
  byCategory: CategoryAgg[]; // sorted desc by total
  byMonth: Record<string, PeriodAgg>; // key: YYYY-MM
  balances: Record<string, number>; // +ve owed to them, -ve they owe
  userBalance: number;
  debts: Debt[]; // minimized settle-up plan
  firstAt: number | null;
  lastAt: number | null;
}

export const cents = (n: number): number => Math.round(n * 100) / 100;

export const isSpend = (e: Expense): boolean =>
  (e.category ?? '').trim().toLowerCase() !== NON_SPEND_CATEGORY;

/** Current user's share of one expense (0 if not a participant). */
export const userShareOf = (e: Expense, userId: string): number =>
  e.participants?.find((p) => p.userId === userId)?.share ?? 0;

/** `YYYY-MM` bucket for an epoch-ms timestamp. */
export const monthKey = (ms: number): string => {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return 'unknown';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** Sum of every participant's share = the expense's split total. */
const splitTotal = (e: Expense): number =>
  (e.participants ?? []).reduce((s, p) => s + (Number(p.share) || 0), 0);

export const sumTotal = (expenses: readonly Expense[]): number =>
  cents(expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0));

export const sumUserShare = (expenses: readonly Expense[], userId: string): number =>
  cents(expenses.reduce((s, e) => s + userShareOf(e, userId), 0));

/**
 * Build the analytics index from the group's on-device expenses + settlements.
 * Spend aggregates exclude the synthetic "settlement" category; balances use the
 * canonical `debtMinimizer` math so they match the rest of the app.
 */
export function buildExpenseAnalytics(
  expenses: readonly Expense[],
  settlements: readonly Settlement[],
  currentUserId: string,
): ExpenseAnalytics {
  const spend = (expenses ?? []).filter(isSpend);

  const catMap = new Map<string, CategoryAgg>();
  const byMonth: Record<string, PeriodAgg> = {};
  let totalSpend = 0;
  let userShareTotal = 0;
  let userPaidTotal = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;

  for (const e of spend) {
    const amount = Number(e.amount) || 0;
    const share = userShareOf(e, currentUserId);
    totalSpend += amount;
    userShareTotal += share;
    if (e.paidBy === currentUserId) userPaidTotal += amount;

    const cat = (e.category ?? 'General').trim() || 'General';
    const agg = catMap.get(cat) ?? { category: cat, total: 0, userShare: 0, count: 0 };
    agg.total += amount;
    agg.userShare += share;
    agg.count += 1;
    catMap.set(cat, agg);

    const mk = monthKey(e.createdAt);
    const m = byMonth[mk] ?? { total: 0, userShare: 0, count: 0 };
    m.total += amount;
    m.userShare += share;
    m.count += 1;
    byMonth[mk] = m;

    if (Number.isFinite(e.createdAt)) {
      firstAt = firstAt == null ? e.createdAt : Math.min(firstAt, e.createdAt);
      lastAt = lastAt == null ? e.createdAt : Math.max(lastAt, e.createdAt);
    }
  }

  const byCategory = Array.from(catMap.values())
    .map((c) => ({ ...c, total: cents(c.total), userShare: cents(c.userShare) }))
    .sort((a, b) => b.total - a.total);

  for (const k of Object.keys(byMonth)) {
    byMonth[k] = { ...byMonth[k], total: cents(byMonth[k].total), userShare: cents(byMonth[k].userShare) };
  }

  // Balances: use ALL expenses (incl. recorded-as-expense settlements) + the
  // settlements list, exactly as the app's balance UI does.
  const balances = calculateBalancesFromExpenses(
    (expenses ?? []).map((e) => ({ paidBy: e.paidBy, participants: e.participants ?? [] })),
    (settlements ?? []).map((s) => ({ fromUserId: s.fromUserId, toUserId: s.toUserId, amount: s.amount })),
  );
  for (const k of Object.keys(balances)) balances[k] = cents(balances[k]);

  return {
    count: spend.length,
    totalSpend: cents(totalSpend),
    userShareTotal: cents(userShareTotal),
    userPaidTotal: cents(userPaidTotal),
    byCategory,
    byMonth,
    balances,
    userBalance: cents(balances[currentUserId] ?? 0),
    debts: minimizeDebts(balances),
    firstAt,
    lastAt,
  };
}

/**
 * Exact bilateral balance between two users from `a`'s perspective:
 *   > 0  ⇒ a owes b that much
 *   < 0  ⇒ b owes a that much
 * Counts each expense the other paid (your share) minus the ones you paid (their
 * share), then nets recorded settlements between the two. Unlike the group-wide
 * minimized plan, this is the true pairwise figure for "how much do I owe Bob".
 */
export function pairwiseNet(
  expenses: readonly Expense[],
  settlements: readonly Settlement[],
  a: string,
  b: string,
): number {
  let aOwesB = 0;
  for (const e of expenses ?? []) {
    if (e.paidBy === b) aOwesB += userShareOf(e, a); // b paid → a owes their share
    else if (e.paidBy === a) aOwesB -= userShareOf(e, b); // a paid → b owes their share
  }
  for (const s of settlements ?? []) {
    if (s.fromUserId === a && s.toUserId === b) aOwesB -= s.amount; // a already paid b
    else if (s.fromUserId === b && s.toUserId === a) aOwesB += s.amount; // b paid a
  }
  return cents(aOwesB);
}

// ── Memoized index (cache) ───────────────────────────────────────────────────
//
// The group's expenses already live in memory (GroupContext's live snapshot), so
// this caches the *derived* index and recomputes only when the group's data
// actually changes — keyed by a cheap signature. Reusable across Ask AI, Group
// Stats, etc. In-memory per session; a disk-persisted layer can build on this.

interface GroupLike {
  groupId: string;
  expenses?: Expense[];
  settlements?: Settlement[];
  updatedAt?: number;
}

/** Cheap change-signature: invalidates the cache when expenses/settlements change. */
export function analyticsSignature(group: GroupLike): string {
  const ex = group.expenses ?? [];
  const st = group.settlements ?? [];
  let maxUpdated = 0;
  for (const e of ex) maxUpdated = Math.max(maxUpdated, e.updatedAt ?? 0);
  return `${ex.length}:${maxUpdated}:${st.length}:${group.updatedAt ?? 0}`;
}

const analyticsCache = new Map<string, { sig: string; value: ExpenseAnalytics }>();

/** Memoized `buildExpenseAnalytics` keyed by group + user + change-signature. */
export function getGroupAnalytics(group: GroupLike, currentUserId: string): ExpenseAnalytics {
  const key = `${group.groupId}:${currentUserId}`;
  const sig = analyticsSignature(group);
  const hit = analyticsCache.get(key);
  if (hit && hit.sig === sig) return hit.value;
  const value = buildExpenseAnalytics(group.expenses ?? [], group.settlements ?? [], currentUserId);
  analyticsCache.set(key, { sig, value });
  return value;
}

/** Test/maintenance hook to clear the in-memory analytics cache. */
export function clearAnalyticsCache(): void {
  analyticsCache.clear();
}

// ── Filters for the query engine (pure) ──────────────────────────────────────

export interface Timeframe {
  startMs: number;
  endMs: number;
  label: string;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * Parse a relative timeframe from a question ("last month", "this week", …).
 * Returns null when none is mentioned (⇒ all-time). `now` is injectable for tests.
 */
export function parseTimeframe(question: string, now: number = Date.now()): Timeframe | null {
  const q = question.toLowerCase();
  const d = new Date(now);
  const y = d.getFullYear();
  const m = d.getMonth();

  if (/\blast month\b/.test(q)) {
    const start = new Date(y, m - 1, 1).getTime();
    const end = new Date(y, m, 1).getTime() - 1;
    return { startMs: start, endMs: end, label: 'last month' };
  }
  if (/\bthis month\b/.test(q)) {
    return { startMs: new Date(y, m, 1).getTime(), endMs: new Date(y, m + 1, 1).getTime() - 1, label: 'this month' };
  }
  if (/\blast week\b/.test(q)) {
    const end = startOfDay(d) - 7 * 86400000 + 7 * 86400000 - 1; // end of last week window
    const start = startOfDay(d) - 7 * 86400000;
    return { startMs: start, endMs: end, label: 'the last 7 days' };
  }
  if (/\bthis week\b|\bpast week\b/.test(q)) {
    return { startMs: startOfDay(d) - 7 * 86400000, endMs: now, label: 'the past week' };
  }
  if (/\blast year\b/.test(q)) {
    return { startMs: new Date(y - 1, 0, 1).getTime(), endMs: new Date(y, 0, 1).getTime() - 1, label: 'last year' };
  }
  if (/\bthis year\b/.test(q)) {
    return { startMs: new Date(y, 0, 1).getTime(), endMs: now, label: 'this year' };
  }
  if (/\btoday\b/.test(q)) {
    return { startMs: startOfDay(d), endMs: now, label: 'today' };
  }
  return null;
}

export const inTimeframe = (e: Expense, tf: Timeframe | null): boolean =>
  !tf || (e.createdAt >= tf.startMs && e.createdAt <= tf.endMs);
