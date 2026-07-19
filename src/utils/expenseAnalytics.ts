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

// ── Persistent, incremental index (cache) ────────────────────────────────────
//
// The group's expenses already live in memory (GroupContext's live snapshot), so
// this caches the *derived* index and recomputes only when the group's data
// actually changes. Two layers back the cache:
//   1. a session Map (hot path — same reference for repeated asks), and
//   2. a persistent SQLite store (survives app restarts) plugged in via
//      `setIndexPersistence` by `services/aiIndexStore`.
// This module stays PURE (no native/expo-sqlite import) so it remains fully
// unit-testable — the SQLite layer is injected as a dependency instead.

interface GroupLike {
  groupId: string;
  expenses?: Expense[];
  settlements?: Settlement[];
  updatedAt?: number;
}

/**
 * Index schema/analytics-shape version. Bump when `ExpenseAnalytics` or the way
 * it's computed changes so persisted rows from an older app build are treated as
 * stale and rebuilt lazily (see `isIndexFresh` + the store's version sweep).
 */
export const INDEX_VERSION = 1;

/** The staleness fingerprint persisted alongside each group's analytics. */
export interface IndexMeta {
  version: number;
  /** Newest change timestamp across the group, its expenses, and settlements. */
  updatedAt: number;
  expenseCount: number;
}

/** A persisted group index: staleness fingerprint + the computed analytics. */
export interface StoredGroupIndex extends IndexMeta {
  analytics: ExpenseAnalytics;
}

/**
 * Persistence provider for the on-device index. Implemented by the SQLite-backed
 * `aiIndexStore` and injected here so this module needs no native import. Null
 * on web / before registration ⇒ memory-only behavior (exactly as before the
 * persistent layer existed). Implementations must never throw across this
 * boundary in a way that breaks the AI path — callers guard, but keep it safe.
 */
export interface IndexPersistence {
  read(groupId: string, userId: string): StoredGroupIndex | null;
  write(groupId: string, userId: string, entry: StoredGroupIndex): void;
  clear(): void;
}

let persistence: IndexPersistence | null = null;

/** Wire in (or clear) the persistent SQLite index layer. */
export function setIndexPersistence(p: IndexPersistence | null): void {
  persistence = p;
}

/**
 * Compute the current staleness fingerprint for a group. This is the SINGLE
 * source of truth for "did the group change since we indexed it": both the
 * memory cache and the SQLite store compare against it via `isIndexFresh`.
 * `updatedAt` folds in expense edits and settlement additions (their
 * `createdAt`) so recorded payments also invalidate the persisted balances.
 */
export function computeIndexMeta(group: GroupLike): IndexMeta {
  const ex = group.expenses ?? [];
  const st = group.settlements ?? [];
  let updatedAt = group.updatedAt ?? 0;
  for (const e of ex) updatedAt = Math.max(updatedAt, e.updatedAt ?? 0);
  for (const s of st) updatedAt = Math.max(updatedAt, s.createdAt ?? 0);
  return { version: INDEX_VERSION, updatedAt, expenseCount: ex.length };
}

/** True when a stored fingerprint still matches the group's current state. */
export function isIndexFresh(stored: IndexMeta | null | undefined, current: IndexMeta): boolean {
  return (
    !!stored &&
    stored.version === current.version &&
    stored.updatedAt === current.updatedAt &&
    stored.expenseCount === current.expenseCount
  );
}

/**
 * Legacy cheap change-signature (string form of the fingerprint). Retained as a
 * public helper; staleness decisions now go through `computeIndexMeta` +
 * `isIndexFresh` so memory and disk agree.
 */
export function analyticsSignature(group: GroupLike): string {
  const ex = group.expenses ?? [];
  const st = group.settlements ?? [];
  let maxUpdated = 0;
  for (const e of ex) maxUpdated = Math.max(maxUpdated, e.updatedAt ?? 0);
  return `${ex.length}:${maxUpdated}:${st.length}:${group.updatedAt ?? 0}`;
}

const analyticsCache = new Map<string, { meta: IndexMeta; value: ExpenseAnalytics; indexedAt: number }>();

/**
 * Incremental `buildExpenseAnalytics` keyed by group + user. Resolution order:
 *   1) session memory (fresh) → return the same reference,
 *   2) persistent SQLite store (fresh) → hydrate memory + return,
 *   3) recompute → write back to BOTH layers.
 * Every persistence touch is guarded: a SQLite failure falls back to in-memory
 * compute so the AI path can never crash on a bad/locked/missing database.
 */
export function getGroupAnalytics(group: GroupLike, currentUserId: string): ExpenseAnalytics {
  const key = `${group.groupId}:${currentUserId}`;
  const meta = computeIndexMeta(group);

  // 1) Hot path — repeated asks in a session return the identical object.
  const hit = analyticsCache.get(key);
  if (hit && isIndexFresh(hit.meta, meta)) return hit.value;

  // 2) Persistent index (survives restarts). A fresh hit hydrates memory so the
  //    next ask is instant; any store error just falls through to recompute.
  if (persistence) {
    try {
      const stored = persistence.read(group.groupId, currentUserId);
      if (stored && isIndexFresh(stored, meta)) {
        analyticsCache.set(key, { meta, value: stored.analytics, indexedAt: Date.now() });
        return stored.analytics;
      }
    } catch {
      // Persistence must never break the AI path — recompute in memory instead.
    }
  }

  // 3) Recompute and write back to both layers.
  const value = buildExpenseAnalytics(group.expenses ?? [], group.settlements ?? [], currentUserId);
  analyticsCache.set(key, { meta, value, indexedAt: Date.now() });
  if (persistence) {
    try {
      persistence.write(group.groupId, currentUserId, { ...meta, analytics: value });
    } catch {
      // Best-effort persistence; a failed write just means we recompute later.
    }
  }
  return value;
}

/** Which group indexes are currently cached in session memory (Settings view). */
export function getAnalyticsCacheInfo(): { key: string; indexedAt: number }[] {
  return [...analyticsCache.entries()].map(([key, v]) => ({ key, indexedAt: v.indexedAt }));
}

/**
 * Clear the session cache AND the persistent store (best-effort). Backs the
 * AiIndexScreen "Rebuild index" action; the next `getGroupAnalytics` recomputes.
 */
export function clearAnalyticsCache(): void {
  analyticsCache.clear();
  try {
    persistence?.clear();
  } catch {
    // Clearing the persistent store is best-effort — ignore failures.
  }
}

// ── Filters for the query engine (pure) ──────────────────────────────────────

export interface Timeframe {
  startMs: number;
  endMs: number;
  label: string;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

// Matches a month name or 3-letter abbreviation, an optional possessive
// ("Aprils total?" / "April's total"), and an optional 4-digit year.
const MONTH_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)('?s)?\b(?:,?\s*(\d{4}))?/;

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Calendar-month window with an "in April [2025]" label (year shown when ≠ current). */
function monthWindow(year: number, month: number, currentYear: number): Timeframe {
  return {
    startMs: new Date(year, month, 1).getTime(),
    endMs: new Date(year, month + 1, 1).getTime() - 1,
    label: `in ${MONTH_LABELS[month]}${year === currentYear ? '' : ` ${year}`}`,
  };
}

function quarterWindow(year: number, quarter: number, currentYear: number): Timeframe {
  const m = (quarter - 1) * 3;
  return {
    startMs: new Date(year, m, 1).getTime(),
    endMs: new Date(year, m + 3, 1).getTime() - 1,
    label: `in Q${quarter}${year === currentYear ? '' : ` ${year}`}`,
  };
}

/**
 * Explicit month name → the most recent occurrence not in the future
 * ("April" asked in July 2026 ⇒ April 2026; "December" ⇒ December 2025),
 * unless a year is given. Bare "may" needs a possessive, year, or a leading
 * in/for/during/of so the modal verb ("may I ask") never reads as a month.
 */
function parseExplicitMonth(q: string, now: Date): Timeframe | null {
  const m = MONTH_RE.exec(q);
  if (!m) return null;
  const idx = MONTH_INDEX[m[1].slice(0, 3)];
  if (idx == null) return null;
  const possessive = Boolean(m[2]);
  const year = m[3] ? Number(m[3]) : null;
  if (m[1] === 'may' && !possessive && year == null) {
    const before = q.slice(0, m.index).trimEnd();
    if (!/\b(in|for|during|of|about)$/.test(before)) return null;
  }
  const currentYear = now.getFullYear();
  const resolvedYear = year ?? (idx > now.getMonth() ? currentYear - 1 : currentYear);
  return monthWindow(resolvedYear, idx, currentYear);
}

/**
 * Parse a timeframe from a question — relative words ("last month", "this
 * week"), explicit month names ("April", "Aprils total?", "April 2025"),
 * quarters ("Q2", "last quarter"), and explicit years ("in 2025").
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

  // Quarters — "Q2", "Q2 2025", "this quarter", "last quarter".
  const currentQuarter = Math.floor(m / 3) + 1;
  if (/\blast quarter\b/.test(q)) {
    return currentQuarter === 1 ? quarterWindow(y - 1, 4, y) : quarterWindow(y, currentQuarter - 1, y);
  }
  if (/\bthis quarter\b/.test(q)) {
    return quarterWindow(y, currentQuarter, y);
  }
  const quarter = /\bq([1-4])\b(?:\s*(\d{4}))?/.exec(q);
  if (quarter) {
    const qNum = Number(quarter[1]);
    const qYear = quarter[2] ? Number(quarter[2]) : qNum > currentQuarter ? y - 1 : y;
    return quarterWindow(qYear, qNum, y);
  }

  // Explicit month names ("April", "Aprils total?", "April 2025").
  const explicitMonth = parseExplicitMonth(q, d);
  if (explicitMonth) return explicitMonth;

  // Explicit year — preposition-gated ("in 2025") so amounts never read as years.
  const year = /\b(?:in|for|during|of)\s+(20\d\d)\b/.exec(q);
  if (year) {
    const yy = Number(year[1]);
    return {
      startMs: new Date(yy, 0, 1).getTime(),
      endMs: new Date(yy + 1, 0, 1).getTime() - 1,
      label: yy === y ? 'this year' : `in ${yy}`,
    };
  }

  return null;
}

/**
 * The comparable period immediately before `tf` — powers follow-ups like
 * "what about the month before that?". Granularity is inferred from the span:
 * calendar months step to the previous calendar month, years to the previous
 * year, anything else slides back by its own span.
 */
export function previousTimeframe(tf: Timeframe, now: number = Date.now()): Timeframe {
  const currentYear = new Date(now).getFullYear();
  const start = new Date(tf.startMs);
  const spanDays = (tf.endMs - tf.startMs) / 86400000;

  if (spanDays >= 27 && spanDays <= 32 && start.getDate() === 1) {
    return monthWindow(
      start.getMonth() === 0 ? start.getFullYear() - 1 : start.getFullYear(),
      start.getMonth() === 0 ? 11 : start.getMonth() - 1,
      currentYear,
    );
  }
  if (spanDays >= 88 && spanDays <= 93 && start.getDate() === 1) {
    const q = Math.floor(start.getMonth() / 3) + 1;
    return q === 1
      ? quarterWindow(start.getFullYear() - 1, 4, currentYear)
      : quarterWindow(start.getFullYear(), q - 1, currentYear);
  }
  const looksLikeYear =
    (spanDays >= 364 && spanDays <= 367) ||
    (start.getMonth() === 0 && start.getDate() === 1 && /\byear\b|^in 20\d\d$/.test(tf.label));
  if (looksLikeYear) {
    const yy = start.getFullYear() - 1;
    return {
      startMs: new Date(yy, 0, 1).getTime(),
      endMs: new Date(yy + 1, 0, 1).getTime() - 1,
      label: `in ${yy}`,
    };
  }
  const span = tf.endMs - tf.startMs + 1;
  return { startMs: tf.startMs - span, endMs: tf.startMs - 1, label: 'the period before that' };
}

export const inTimeframe = (e: Expense, tf: Timeframe | null): boolean =>
  !tf || (e.createdAt >= tf.startMs && e.createdAt <= tf.endMs);

export type PeriodUnit = 'week' | 'month' | 'year';

/** Calendar window for a month/year at `offset` (0 = current, -1 = previous). */
export function calendarWindow(now: number, unit: 'month' | 'year', offset: number): Timeframe {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = d.getMonth();
  if (unit === 'year') {
    return {
      startMs: new Date(y + offset, 0, 1).getTime(),
      endMs: new Date(y + offset + 1, 0, 1).getTime() - 1,
      label: offset === 0 ? 'this year' : offset === -1 ? 'last year' : `${y + offset}`,
    };
  }
  return {
    startMs: new Date(y, m + offset, 1).getTime(),
    endMs: new Date(y, m + offset + 1, 1).getTime() - 1,
    label: offset === 0 ? 'this month' : offset === -1 ? 'last month' : 'that month',
  };
}

/** Rolling N-day window ending `daysBack` days ago (for week comparisons). */
export function rollingWindow(now: number, daysBack: number, daysSpan: number, label: string): Timeframe {
  const day = 86400000;
  return { startMs: now - daysBack * day, endMs: now - (daysBack - daysSpan) * day, label };
}

/** Current + previous comparable windows for a unit. */
export function comparisonWindows(now: number, unit: PeriodUnit): { current: Timeframe; previous: Timeframe } {
  if (unit === 'week') {
    return {
      current: rollingWindow(now, 7, 7, 'this week'),
      previous: rollingWindow(now, 14, 7, 'last week'),
    };
  }
  return {
    current: calendarWindow(now, unit, 0),
    previous: calendarWindow(now, unit, -1),
  };
}
