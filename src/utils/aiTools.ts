/**
 * aiTools.ts — graph-tier tool registry for the agentic AI pipeline (doc 24 §4).
 *
 * Pure module (type-only alias imports, relative runtime imports) so the whole
 * registry is vitest-testable. Each tool wraps the deterministic engines
 * (expenseAnalytics / statsInsights) and returns EXACT, capped numbers as
 * compact JSON — the model quotes tool results, it never computes.
 *
 * The router model fills a flat ToolRequest (guided generation can't do open
 * dicts); resolvers here turn fuzzy args ("april", "walmart", a first name)
 * into exact windows/entities. Ambiguity is DATA, not an error: a member arg
 * matching two people returns the candidates so the pipeline can ask back.
 *
 * Local-tier tools (chat_search / call_stats) use injected providers and are
 * constrained by the same declarative contracts and on-device pinning rule.
 */

import type { Expense } from '@/models/expense';
import type { GroupMember, Settlement } from '@/models/group';
import { resolveDisplayName } from './identity';
import {
  calendarWindow,
  cents,
  getGroupAnalytics,
  isSpend,
  pairwiseNet,
  userShareOf,
  type Timeframe,
} from './expenseAnalytics';
import {
  aggregateRange,
  buildForecast,
  buildPersonalStats,
  budgetStatus,
  detectAnomalies,
  memberBreakdown,
  merchantAggregate,
  type StatsRange,
} from './statsInsights';

// ── Types ────────────────────────────────────────────────────────────────────

/** Flat request shape mirroring the native @Generable struct ('' / 0 = unset). */
export interface ToolRequest {
  tool: string;
  /** Month/period: "april 2026", "2026-04", "last month", "2025", "this year". */
  month?: string;
  /** Second period for compare_ranges. */
  monthB?: string;
  category?: string;
  member?: string;
  merchant?: string;
  query?: string;
  /** Row count for top_expenses (0 = default). */
  n?: number;
  /** Months of history for category_trail (0 = default). */
  months?: number;
}

export interface ToolResult {
  tool: string;
  /** Short human label ("April 2026 totals") — headers + status lines. */
  label: string;
  /** Compact JSON payload; every number is final. */
  json: string;
  /** Set when args didn't resolve — the model should adjust, not invent. */
  error?: string;
  /** Machine-readable outcome. Optional only for old persisted traces. */
  status?: 'ok' | 'error';
  code?: 'invalid_args' | 'forbidden' | 'timeout' | 'cancelled' | 'unavailable' | 'internal' | 'invalid_output' | 'result_too_large';
  /** Safe execution metadata — never includes request text or returned data. */
  durationMs?: number;
  dataClasses?: AiDataClass[];
}

export type AiDataClass = 'persistent_money' | 'local_chat' | 'local_calls';
export type AiSurface = 'assistant' | 'insights' | 'search' | 'siri';

export interface AiToolContract {
  name: string;
  version: 1;
  title: string;
  dataClasses: AiDataClass[];
  effects: readonly ['read'];
  timeoutMs: number;
  maxResultBytes: number;
}

/** Content-free provenance safe to persist with a local conversation. */
export interface AiToolEvidence {
  kind: 'capability';
  tool: string;
  version: 1;
  title: string;
  dataClasses: AiDataClass[];
}

interface GroupCtx {
  groupId: string;
  name: string;
  currency: string;
  members: Pick<GroupMember, 'userId' | 'displayName'>[];
  expenses: Expense[];
  settlements: Settlement[];
  budgets?: Record<string, number>;
  updatedAt?: number;
}

interface PersonalGroupCtx {
  groupId: string;
  name: string;
  currency: string;
  expenses?: Expense[];
}

export interface ChatSearchResult {
  matches: number;
  rows: { text: string; from: string; date: string }[];
}

export interface CallStatsResult {
  calls: number;
  totalMinutes: number;
  missed: number;
  /** Human date of the most recent call, null when none. */
  lastCall: string | null;
}

export interface ToolCtx {
  now: number;
  currentUserId: string;
  /** Present for group scope — enables all group tools. */
  group?: GroupCtx;
  /** Present for personal scope — enables the cross-group tools. */
  personalGroups?: PersonalGroupCtx[];
  /** Injected (async source): approximate monthly recurring commitment. */
  recurringMonthly?: number;
  /** Injected recurring bill rows for the `recurring` tool. */
  recurringBills?: { title: string; amount: number; frequency?: string }[];
  /**
   * LOCAL-TIER providers (doc 24 P5) — injected by the service layer because
   * this module stays pure. Their tools are ON-DEVICE-ONLY: any request to one
   * pins the whole turn to the on-device engine, and they are never offered
   * when the user picked Private Cloud. Absent provider ⇒ tool unavailable.
   */
  chatSearch?: (query: string, tf: Timeframe | null, signal?: AbortSignal) => Promise<ChatSearchResult>;
  callStats?: (member: string | undefined, tf: Timeframe | null, signal?: AbortSignal) => Promise<CallStatsResult>;
  /** Cooperative cancellation propagated into local providers. */
  signal?: AbortSignal;
  /** Doc 25 Q2 — learned alias → display-name fixes ("sam" → "Sam Lee"),
   * applied to member args BEFORE resolution so fixed names never re-clarify. */
  entityFixes?: Record<string, string>;
}

// ── Period resolution ("april", "2026-04", "last month", "2025") ─────────────

const MONTHS_FULL = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface ResolvedPeriod {
  tf: Timeframe;
  /** Concrete label the model can echo ("April 2026", "2025"). */
  label: string;
  kind: 'month' | 'year';
}

const monthWindow = (year: number, monthIdx: number): Timeframe => ({
  startMs: new Date(year, monthIdx, 1).getTime(),
  endMs: new Date(year, monthIdx + 1, 1).getTime() - 1,
  label: `${MONTH_LABELS[monthIdx]} ${year}`,
});

/**
 * Resolve a fuzzy period string to a concrete calendar window. Month names
 * without a year pick the most recent occurrence not in the future — this is
 * the doc-17 symptom-#3 fix ("Aprils total?") living at the tool layer.
 * Returns null for ''/unparseable (callers treat as all-time or error per tool).
 */
export function resolvePeriod(raw: string | undefined, now: number): ResolvedPeriod | null {
  const q = (raw ?? '').trim().toLowerCase().replace(/[’']s\b/, '');
  if (!q) return null;
  const d = new Date(now);

  if (/^(this|current) month$/.test(q)) {
    const tf = calendarWindow(now, 'month', 0);
    return { tf, label: `${MONTH_LABELS[d.getMonth()]} ${d.getFullYear()}`, kind: 'month' };
  }
  if (/^(last|previous) month$/.test(q)) {
    const tf = calendarWindow(now, 'month', -1);
    const p = new Date(tf.startMs);
    return { tf, label: `${MONTH_LABELS[p.getMonth()]} ${p.getFullYear()}`, kind: 'month' };
  }
  const ago = q.match(/^(\d{1,2}) months? ago$/);
  if (ago) {
    const tf = calendarWindow(now, 'month', -Number(ago[1]));
    const p = new Date(tf.startMs);
    return { tf, label: `${MONTH_LABELS[p.getMonth()]} ${p.getFullYear()}`, kind: 'month' };
  }
  if (/^(this|current) year$/.test(q)) {
    return { tf: calendarWindow(now, 'year', 0), label: String(d.getFullYear()), kind: 'year' };
  }
  if (/^(last|previous) year$/.test(q)) {
    return { tf: calendarWindow(now, 'year', -1), label: String(d.getFullYear() - 1), kind: 'year' };
  }

  // "2026-04" / "2026/04"
  const iso = q.match(/^(\d{4})[-/](\d{1,2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]) - 1;
    if (m >= 0 && m <= 11) return { tf: monthWindow(y, m), label: `${MONTH_LABELS[m]} ${y}`, kind: 'month' };
  }

  // Bare year "2025"
  const yearOnly = q.match(/^(20\d{2})$/);
  if (yearOnly) {
    const y = Number(yearOnly[1]);
    return {
      tf: { startMs: new Date(y, 0, 1).getTime(), endMs: new Date(y + 1, 0, 1).getTime() - 1, label: String(y) },
      label: String(y),
      kind: 'year',
    };
  }

  // Month name, optional year: "april", "april 2025", "apr 25"
  const nameMatch = q.match(/^([a-z]+)\.?\s*(\d{4}|\d{2})?$/);
  if (nameMatch) {
    const name = nameMatch[1];
    let idx = MONTHS_FULL.indexOf(name);
    if (idx < 0) idx = MONTHS_SHORT.indexOf(name.slice(0, 3));
    if (idx >= 0) {
      let year: number;
      if (nameMatch[2]) {
        year = Number(nameMatch[2]);
        if (year < 100) year += 2000;
      } else {
        // Most recent occurrence not in the future.
        year = idx > d.getMonth() ? d.getFullYear() - 1 : d.getFullYear();
      }
      return { tf: monthWindow(year, idx), label: `${MONTH_LABELS[idx]} ${year}`, kind: 'month' };
    }
  }
  return null;
}

// ── Entity resolution (members / merchants / categories) ─────────────────────

const norm = (s: string): string => (s ?? '').trim().toLowerCase();

export interface MemberMatch {
  matched: Pick<GroupMember, 'userId' | 'displayName'> | null;
  /** 2+ names ⇒ ambiguous — the pipeline can ask back with these as chips. */
  candidates: string[];
}

/** Exact name → first-name/prefix → substring; ambiguity returned as data. */
export function resolveMember(
  raw: string | undefined,
  members: readonly Pick<GroupMember, 'userId' | 'displayName'>[],
): MemberMatch {
  const q = norm(raw ?? '');
  if (!q) return { matched: null, candidates: [] };
  const exact = members.filter((m) => norm(m.displayName) === q);
  if (exact.length === 1) return { matched: exact[0], candidates: [] };
  if (exact.length > 1) return { matched: null, candidates: exact.map((m) => resolveDisplayName(m)) };
  const prefix = members.filter((m) => {
    const first = norm(m.displayName).split(/\s+/)[0];
    return first.startsWith(q) || q.startsWith(first);
  });
  if (prefix.length === 1) return { matched: prefix[0], candidates: [] };
  if (prefix.length > 1) return { matched: null, candidates: prefix.map((m) => resolveDisplayName(m)) };
  const sub = members.filter((m) => norm(m.displayName).includes(q));
  if (sub.length === 1) return { matched: sub[0], candidates: [] };
  return { matched: null, candidates: sub.map((m) => resolveDisplayName(m)) };
}

/** Fuzzy merchant (expense-title) match: substring either direction, ranked by spend. */
function resolveMerchant(raw: string, expenses: readonly Expense[], tf: Timeframe | null) {
  const q = norm(raw);
  const { merchants } = merchantAggregate(expenses, tf);
  if (!q) return { matched: null, others: [] as string[] };
  const hits = merchants.filter((m) => {
    const n = norm(m.name);
    return n.includes(q) || q.includes(n);
  });
  return { matched: hits[0] ?? null, others: hits.slice(1, 4).map((m) => m.name) };
}

/** Case-insensitive category match against categories present in the data. */
function resolveCategory(raw: string, expenses: readonly Expense[]): string | null {
  const q = norm(raw);
  if (!q) return null;
  const present = [...new Set(expenses.filter(isSpend).map((e) => ((e.category ?? 'General').trim() || 'General')))];
  return (
    present.find((c) => norm(c) === q) ??
    present.find((c) => norm(c).includes(q) || q.includes(norm(c))) ??
    null
  );
}

// ── Shared row shapers ───────────────────────────────────────────────────────

const dateLabel = (ms: number): string => {
  const d = new Date(ms);
  return `${MONTH_LABELS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
};

const expenseRow = (e: Expense, members: readonly Pick<GroupMember, 'userId' | 'displayName'>[]) => ({
  title: e.title,
  amount: cents(Number(e.amount) || 0),
  category: (e.category ?? 'General').trim() || 'General',
  paidBy: resolveDisplayName(members.find((m) => m.userId === e.paidBy), 'someone'),
  date: dateLabel(e.createdAt),
});

const spendIn = (expenses: readonly Expense[], tf: Timeframe | null): Expense[] =>
  expenses.filter(isSpend).filter((e) => !tf || (e.createdAt >= tf.startMs && e.createdAt <= tf.endMs));

const periodLabel = (p: ResolvedPeriod | null): string => (p ? p.label : 'all time');

/** Map a resolved period (or null) onto the StatsRange the personal engine takes. */
const personalRange = (p: ResolvedPeriod | null): StatsRange =>
  p == null ? 'all' : p.kind === 'year' ? 'year' : 'month';

// ── Tool implementations ─────────────────────────────────────────────────────

type ToolRun = (req: ToolRequest, ctx: ToolCtx) => ToolResult | Promise<ToolResult>;

const err = (tool: string, label: string, error: string): ToolResult => ({
  tool,
  label,
  json: JSON.stringify({ error }),
  error,
  status: 'error',
});

const ok = (tool: string, label: string, payload: unknown): ToolResult => ({
  tool,
  label,
  json: JSON.stringify(payload),
  status: 'ok',
});

const needGroup = (ctx: ToolCtx): GroupCtx | null => ctx.group ?? null;

const TOOLS: Record<
  string,
  { tier: 'graph' | 'local'; needs: 'group' | 'personal' | 'any'; doc: string; run: ToolRun }
> = {
  range_totals: {
    tier: 'graph',
    needs: 'group',
    doc: "range_totals(month?) — totals, count, your share, and per-member paid/share for a period ('april 2026', 'last month', '2025'; omit for all time).",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('range_totals', 'totals', 'no group in scope');
      const p = resolvePeriod(req.month, ctx.now);
      const tf = p?.tf ?? null;
      const agg = aggregateRange(g.expenses, tf, ctx.currentUserId);
      const { rows } = memberBreakdown(g.expenses, g.members, tf);
      return ok('range_totals', `${periodLabel(p)} totals`, {
        period: periodLabel(p),
        currency: g.currency,
        total: agg.total,
        count: agg.count,
        yourShare: agg.userShare,
        perMember: rows.map((r) => ({ name: r.name, paid: r.paid, share: r.share })),
      });
    },
  },

  month_summary: {
    tier: 'graph',
    needs: 'group',
    doc: "month_summary(month) — one month in depth: total, top categories, biggest expenses, and the change vs the month before it.",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('month_summary', 'month summary', 'no group in scope');
      const p = resolvePeriod(req.month, ctx.now);
      if (!p || p.kind !== 'month') {
        return err('month_summary', 'month summary', `could not resolve month "${req.month ?? ''}" — say e.g. 'april 2026'`);
      }
      const agg = aggregateRange(g.expenses, p.tf, ctx.currentUserId);
      const prevTf = calendarWindow(p.tf.startMs, 'month', -1);
      const prev = aggregateRange(g.expenses, prevTf, ctx.currentUserId);
      const top = spendIn(g.expenses, p.tf)
        .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
        .slice(0, 3)
        .map((e) => expenseRow(e, g.members));
      const pd = new Date(prevTf.startMs);
      return ok('month_summary', `${p.label} summary`, {
        month: p.label,
        currency: g.currency,
        total: agg.total,
        count: agg.count,
        yourShare: agg.userShare,
        topCategories: agg.byCategory.slice(0, 5).map((c) => ({ c: c.category, t: c.total })),
        topExpenses: top,
        prevMonth: {
          month: `${MONTH_LABELS[pd.getMonth()]} ${pd.getFullYear()}`,
          total: prev.total,
          deltaPct: prev.total > 0 ? Math.round(((agg.total - prev.total) / prev.total) * 100) : null,
        },
      });
    },
  },

  compare_ranges: {
    tier: 'graph',
    needs: 'group',
    doc: "compare_ranges(month, monthB) — side-by-side totals and the biggest per-category movers between two periods. The 'why did spending change' workhorse.",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('compare_ranges', 'comparison', 'no group in scope');
      const a = resolvePeriod(req.month, ctx.now);
      const b = resolvePeriod(req.monthB, ctx.now);
      if (!a || !b) {
        return err('compare_ranges', 'comparison', `need two resolvable periods (got "${req.month ?? ''}" and "${req.monthB ?? ''}")`);
      }
      const aggA = aggregateRange(g.expenses, a.tf, ctx.currentUserId);
      const aggB = aggregateRange(g.expenses, b.tf, ctx.currentUserId);
      const cats = new Map<string, { a: number; b: number }>();
      for (const c of aggA.byCategory) cats.set(c.category, { a: c.total, b: 0 });
      for (const c of aggB.byCategory) {
        const row = cats.get(c.category) ?? { a: 0, b: 0 };
        row.b = c.total;
        cats.set(c.category, row);
      }
      const movers = [...cats.entries()]
        .map(([category, v]) => ({ category, [a.label]: v.a, [b.label]: v.b, delta: cents(v.a - v.b) }))
        .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
        .slice(0, 5);
      return ok('compare_ranges', `${a.label} vs ${b.label}`, {
        currency: g.currency,
        [a.label]: { total: aggA.total, count: aggA.count },
        [b.label]: { total: aggB.total, count: aggB.count },
        deltaTotal: cents(aggA.total - aggB.total),
        topMovers: movers,
      });
    },
  },

  category_breakdown: {
    tier: 'graph',
    needs: 'group',
    doc: "category_breakdown(month?) — every category's total, count, and your share for a period (omit for all time).",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('category_breakdown', 'categories', 'no group in scope');
      const p = resolvePeriod(req.month, ctx.now);
      const agg = aggregateRange(g.expenses, p?.tf ?? null, ctx.currentUserId);
      return ok('category_breakdown', `${periodLabel(p)} categories`, {
        period: periodLabel(p),
        currency: g.currency,
        categories: agg.byCategory.slice(0, 8).map((c) => ({
          c: c.category, total: c.total, count: c.count, yourShare: c.userShare,
        })),
      });
    },
  },

  category_trail: {
    tier: 'graph',
    needs: 'group',
    doc: "category_trail(category, months?) — one category's monthly totals over recent months (default 6). Use to explain a category's history.",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('category_trail', 'category trail', 'no group in scope');
      const cat = resolveCategory(req.category ?? '', g.expenses);
      if (!cat) return err('category_trail', 'category trail', `no category matching "${req.category ?? ''}" in this group`);
      const span = Math.min(12, Math.max(3, req.months || 6));
      const trail: { month: string; total: number; count: number }[] = [];
      for (let shift = 0; shift > -span; shift--) {
        const tf = calendarWindow(ctx.now, 'month', shift);
        const rows = spendIn(g.expenses, tf).filter(
          (e) => ((e.category ?? 'General').trim() || 'General') === cat,
        );
        const d = new Date(tf.startMs);
        trail.unshift({
          month: `${MONTH_LABELS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`,
          total: cents(rows.reduce((s, e) => s + (Number(e.amount) || 0), 0)),
          count: rows.length,
        });
      }
      return ok('category_trail', `${cat} trail`, { category: cat, currency: g.currency, byMonth: trail });
    },
  },

  member_stats: {
    tier: 'graph',
    needs: 'group',
    doc: "member_stats(member, month?) — one member's paid vs consumed, their balance, what they owe you / you owe them, and their top categories.",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('member_stats', 'member stats', 'no group in scope');
      const m = resolveMember(req.member, g.members);
      if (!m.matched) {
        return m.candidates.length
          ? ok('member_stats', 'member stats', { ambiguous: m.candidates })
          : err('member_stats', 'member stats', `no member matching "${req.member ?? ''}" — members: ${g.members.map((x) => resolveDisplayName(x)).join(', ')}`);
      }
      const p = resolvePeriod(req.month, ctx.now);
      const tf = p?.tf ?? null;
      const { rows } = memberBreakdown(g.expenses, [m.matched], tf);
      const row = rows[0];
      const analytics = getGroupAnalytics(
        { groupId: g.groupId, expenses: g.expenses, settlements: g.settlements, updatedAt: g.updatedAt },
        ctx.currentUserId,
      );
      const net = pairwiseNet(g.expenses, g.settlements, ctx.currentUserId, m.matched.userId);
      const catTotals = new Map<string, number>();
      for (const e of spendIn(g.expenses, tf)) {
        const share = userShareOf(e, m.matched.userId);
        if (share > 0) {
          const c = (e.category ?? 'General').trim() || 'General';
          catTotals.set(c, (catTotals.get(c) ?? 0) + share);
        }
      }
      return ok('member_stats', `${resolveDisplayName(m.matched)} stats`, {
        name: resolveDisplayName(m.matched),
        period: periodLabel(p),
        currency: g.currency,
        paid: row?.paid ?? 0,
        share: row?.share ?? 0,
        groupBalance: cents(analytics.balances[m.matched.userId] ?? 0),
        // From YOUR perspective: positive = you owe them.
        youOweThem: net > 0 ? net : 0,
        theyOweYou: net < 0 ? cents(-net) : 0,
        topCategories: [...catTotals.entries()]
          .map(([c, t]) => ({ c, t: cents(t) }))
          .sort((x, y) => y.t - x.t)
          .slice(0, 3),
      });
    },
  },

  merchant_stats: {
    tier: 'graph',
    needs: 'group',
    doc: "merchant_stats(merchant, month?) — fuzzy merchant match: visits, total, average, receipt savings, and recent purchases there.",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('merchant_stats', 'merchant stats', 'no group in scope');
      const p = resolvePeriod(req.month, ctx.now);
      const tf = p?.tf ?? null;
      const { matched, others } = resolveMerchant(req.merchant ?? '', g.expenses, tf);
      if (!matched) return err('merchant_stats', 'merchant stats', `nothing matching "${req.merchant ?? ''}" in expense titles`);
      // Exact-title match — the SAME key merchantAggregate grouped matched.total
      // /matched.count by. A substring match here (e.g. "Walmart" vs "Walmart
      // Groceries") would pull rows from a different, unaggregated title group
      // into "recent" while total/visits stay computed from just the matched
      // group, so the two would silently disagree.
      const rows = spendIn(g.expenses, tf)
        .filter((e) => norm(e.title) === norm(matched.name))
        .sort((a, b) => b.createdAt - a.createdAt);
      return ok('merchant_stats', `${matched.name} stats`, {
        merchant: matched.name,
        period: periodLabel(p),
        currency: g.currency,
        total: matched.total,
        visits: matched.count,
        avg: matched.count > 0 ? cents(matched.total / matched.count) : 0,
        savings: matched.savings,
        recent: rows.slice(0, 3).map((e) => expenseRow(e, g.members)),
        ...(others.length ? { alsoMatched: others } : {}),
      });
    },
  },

  top_expenses: {
    tier: 'graph',
    needs: 'group',
    doc: "top_expenses(month?, n?, category?) — the biggest expenses in a period, optionally within one category.",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('top_expenses', 'top expenses', 'no group in scope');
      const p = resolvePeriod(req.month, ctx.now);
      const cat = req.category ? resolveCategory(req.category, g.expenses) : null;
      const rows = spendIn(g.expenses, p?.tf ?? null)
        .filter((e) => !cat || ((e.category ?? 'General').trim() || 'General') === cat)
        .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
        .slice(0, Math.min(8, Math.max(1, req.n || 5)));
      return ok('top_expenses', `top expenses ${periodLabel(p)}`, {
        period: periodLabel(p),
        ...(cat ? { category: cat } : {}),
        currency: g.currency,
        rows: rows.map((e) => expenseRow(e, g.members)),
      });
    },
  },

  search_expenses: {
    tier: 'graph',
    needs: 'group',
    doc: "search_expenses(query, month?) — fuzzy search of expense titles for a word or phrase; returns matching rows and their sum.",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('search_expenses', 'expense search', 'no group in scope');
      const q = norm(req.query ?? '');
      if (!q) return err('search_expenses', 'expense search', 'empty query');
      const p = resolvePeriod(req.month, ctx.now);
      const terms = q.split(/\s+/).filter((t) => t.length >= 2);
      const rows = spendIn(g.expenses, p?.tf ?? null)
        .filter((e) => {
          const hay = norm(`${e.title} ${(e.category ?? '')}`);
          return terms.some((t) => hay.includes(t));
        })
        .sort((a, b) => b.createdAt - a.createdAt);
      return ok('search_expenses', `search "${req.query}"`, {
        query: req.query,
        period: periodLabel(p),
        currency: g.currency,
        matches: rows.length,
        sum: cents(rows.reduce((s, e) => s + (Number(e.amount) || 0), 0)),
        rows: rows.slice(0, 8).map((e) => expenseRow(e, g.members)),
      });
    },
  },

  balances: {
    tier: 'graph',
    needs: 'group',
    doc: "balances() — every member's current net balance (positive = owed money) and yours.",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('balances', 'balances', 'no group in scope');
      const a = getGroupAnalytics(
        { groupId: g.groupId, expenses: g.expenses, settlements: g.settlements, updatedAt: g.updatedAt },
        ctx.currentUserId,
      );
      return ok('balances', 'balances', {
        currency: g.currency,
        perMember: g.members.map((m) => ({
          name: resolveDisplayName(m),
          net: cents(a.balances[m.userId] ?? 0),
        })),
        yourBalance: a.userBalance,
      });
    },
  },

  settle_plan: {
    tier: 'graph',
    needs: 'group',
    doc: "settle_plan() — the minimal set of payments that settles the whole group.",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('settle_plan', 'settle-up plan', 'no group in scope');
      const a = getGroupAnalytics(
        { groupId: g.groupId, expenses: g.expenses, settlements: g.settlements, updatedAt: g.updatedAt },
        ctx.currentUserId,
      );
      const nameOf = new Map(g.members.map((m) => [m.userId, resolveDisplayName(m, 'someone')]));
      return ok('settle_plan', 'settle-up plan', {
        currency: g.currency,
        transfers: a.debts.map((dbt) => ({
          from: nameOf.get(dbt.from) ?? 'someone',
          to: nameOf.get(dbt.to) ?? 'someone',
          amount: cents(dbt.amount),
        })),
      });
    },
  },

  budgets: {
    tier: 'graph',
    needs: 'group',
    doc: "budgets() — this month's spend vs every category budget the group has set.",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('budgets', 'budgets', 'no group in scope');
      const rows = budgetStatus(g.budgets, g.expenses, ctx.now);
      if (rows.length === 0) return ok('budgets', 'budgets', { note: 'this group has no budgets set' });
      return ok('budgets', 'budgets', {
        currency: g.currency,
        month: `${MONTH_LABELS[new Date(ctx.now).getMonth()]} ${new Date(ctx.now).getFullYear()}`,
        rows,
      });
    },
  },

  budget_status: {
    tier: 'graph',
    needs: 'group',
    doc: "budget_status(category) — one category's budget vs spend this month plus its recent monthly trail.",
    run: async (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('budget_status', 'budget status', 'no group in scope');
      const rows = budgetStatus(g.budgets, g.expenses, ctx.now);
      const cat = resolveCategory(req.category ?? '', g.expenses);
      const row = rows.find((r) => norm(r.category) === norm(cat ?? req.category ?? ''));
      if (!row) {
        return rows.length
          ? err('budget_status', 'budget status', `no budget for "${req.category ?? ''}" — budgeted: ${rows.map((r) => r.category).join(', ')}`)
          : ok('budget_status', 'budget status', { note: 'this group has no budgets set' });
      }
      const trailReq: ToolRequest = { tool: 'category_trail', category: row.category, months: 4 };
      const trail = await TOOLS.category_trail.run(trailReq, ctx);
      return ok('budget_status', `${row.category} budget`, {
        ...row,
        currency: g.currency,
        trail: trail.error ? undefined : JSON.parse(trail.json).byMonth,
      });
    },
  },

  recurring: {
    tier: 'graph',
    needs: 'group',
    doc: "recurring() — the group's recurring bills and their approximate monthly commitment.",
    run: (req, ctx) => {
      const bills = ctx.recurringBills ?? [];
      if (bills.length === 0 && !ctx.recurringMonthly) {
        return ok('recurring', 'recurring bills', { note: 'no recurring bills set up' });
      }
      return ok('recurring', 'recurring bills', {
        currency: ctx.group?.currency,
        monthlyCommitment: cents(ctx.recurringMonthly ?? 0),
        bills: bills.slice(0, 8),
      });
    },
  },

  forecast: {
    tier: 'graph',
    needs: 'group',
    doc: "forecast() — month-to-date spend, the straight-line month-end projection, and last month's anchor.",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('forecast', 'forecast', 'no group in scope');
      const f = buildForecast(g.expenses, ctx.now, ctx.recurringMonthly ?? 0);
      return ok('forecast', 'forecast', { currency: g.currency, ...f });
    },
  },

  anomalies: {
    tier: 'graph',
    needs: 'group',
    doc: "anomalies() — recent expenses that run far above their category's usual level.",
    run: (req, ctx) => {
      const g = needGroup(ctx);
      if (!g) return err('anomalies', 'anomalies', 'no group in scope');
      const rows = detectAnomalies(g.expenses, ctx.now).slice(0, 5);
      return ok('anomalies', 'anomalies', rows.length
        ? { currency: g.currency, rows: rows.map((a) => ({ title: a.title, category: a.category, amount: a.amount, usual: a.baseline, times: a.ratio })) }
        : { note: 'nothing unusual in the recent expenses' });
    },
  },

  personal_overview: {
    tier: 'graph',
    needs: 'personal',
    doc: "personal_overview(month?) — YOUR share across all groups for a period, per group and per category (per currency — never summed across currencies).",
    run: (req, ctx) => {
      if (!ctx.personalGroups?.length) return err('personal_overview', 'personal overview', 'no groups');
      const p = resolvePeriod(req.month, ctx.now);
      const bundle = buildPersonalStats(ctx.personalGroups, ctx.currentUserId, personalRange(p), ctx.now);
      return ok('personal_overview', `personal ${periodLabel(p)}`, {
        period: periodLabel(p),
        groups: bundle.groups.slice(0, 8),
        categoriesByCurrency: bundle.categoriesByCurrency,
      });
    },
  },

  entity_lookup: {
    tier: 'graph',
    needs: 'any',
    doc: "entity_lookup(query) — fuzzy-resolve a name you're unsure about: members, groups, and merchants that match. Use BEFORE guessing when a name doesn't resolve.",
    run: (req, ctx) => {
      const q = norm(req.query ?? req.member ?? req.merchant ?? '');
      if (!q) return err('entity_lookup', 'entity lookup', 'empty query');
      const rows: { type: string; name: string; detail: string }[] = [];
      const push = (type: string, name: string, detail: string) => {
        if (rows.length < 8 && (norm(name).includes(q) || q.includes(norm(name)))) {
          rows.push({ type, name, detail });
        }
      };
      for (const m of ctx.group?.members ?? []) push('member', resolveDisplayName(m), `member of ${ctx.group?.name}`);
      for (const g of ctx.personalGroups ?? []) {
        push('group', g.name, `${g.expenses?.length ?? 0} expenses`);
        for (const m0 of new Set((g.expenses ?? []).filter(isSpend).map((e) => e.title))) {
          push('merchant', m0, `in ${g.name}`);
        }
      }
      for (const m1 of merchantAggregate(ctx.group?.expenses ?? [], null).merchants.slice(0, 50)) {
        push('merchant', m1.name, `${m1.count} purchases`);
      }
      return rows.length
        ? ok('entity_lookup', `lookup "${req.query ?? q}"`, { rows })
        : ok('entity_lookup', `lookup "${req.query ?? q}"`, { note: `nothing matching "${q}"` });
    },
  },

  chat_search: {
    tier: 'local',
    needs: 'group',
    doc: 'chat_search(query, month?) — search this group\'s chat messages for what people SAID about something ("what did we decide about the hotel?"). On-device only.',
    run: async (req, ctx) => {
      if (!ctx.chatSearch) return err('chat_search', 'chat search', 'chat search is not available here');
      const q = (req.query ?? '').trim();
      if (!q) return err('chat_search', 'chat search', 'empty query');
      const p = resolvePeriod(req.month, ctx.now);
      const result = await ctx.chatSearch(q, p?.tf ?? null, ctx.signal);
      return ok('chat_search', `chat search "${q}"`, {
        query: q,
        period: periodLabel(p),
        matches: result.matches,
        rows: result.rows.slice(0, 5),
      });
    },
  },

  call_stats: {
    tier: 'local',
    needs: 'any',
    doc: 'call_stats(member?, month?) — call counts, total minutes, missed calls, and the last call. On-device only.',
    run: async (req, ctx) => {
      if (!ctx.callStats) return err('call_stats', 'call stats', 'call history is not available here');
      const p = resolvePeriod(req.month, ctx.now);
      const result = await ctx.callStats(req.member?.trim() || undefined, p?.tf ?? null, ctx.signal);
      return ok('call_stats', 'call stats', {
        ...(req.member ? { member: req.member } : {}),
        period: periodLabel(p),
        ...result,
      });
    },
  },

  group_compare: {
    tier: 'graph',
    needs: 'personal',
    doc: "group_compare(month?) — which groups cost YOU the most in a period (each in its own currency).",
    run: (req, ctx) => {
      if (!ctx.personalGroups?.length) return err('group_compare', 'group comparison', 'no groups');
      const p = resolvePeriod(req.month, ctx.now);
      const bundle = buildPersonalStats(ctx.personalGroups, ctx.currentUserId, personalRange(p), ctx.now);
      return ok('group_compare', `groups ${periodLabel(p)}`, {
        period: periodLabel(p),
        groups: bundle.groups.map((g) => ({ name: g.name, yourShare: g.yourShare, currency: g.currency, count: g.count })),
      });
    },
  },
};

// ── Public registry API ──────────────────────────────────────────────────────

const contract = (
  name: string,
  title: string,
  dataClasses: AiDataClass[] = ['persistent_money'],
  timeoutMs = 2_000,
): AiToolContract => Object.freeze({
  name,
  version: 1,
  title,
  dataClasses: Object.freeze([...dataClasses]) as unknown as AiDataClass[],
  effects: Object.freeze(['read'] as const),
  timeoutMs,
  maxResultBytes: 16_384,
});

/**
 * Auditable, versioned execution policy. Keep this separate from prompt copy:
 * changing a description must never silently change privacy or runtime limits.
 */
export const AI_TOOL_CONTRACTS: Record<string, AiToolContract> = Object.freeze({
  range_totals: contract('range_totals', 'Range totals'),
  month_summary: contract('month_summary', 'Month summary'),
  compare_ranges: contract('compare_ranges', 'Compare periods'),
  category_breakdown: contract('category_breakdown', 'Category breakdown'),
  category_trail: contract('category_trail', 'Category history'),
  member_stats: contract('member_stats', 'Member statistics'),
  merchant_stats: contract('merchant_stats', 'Merchant statistics'),
  top_expenses: contract('top_expenses', 'Top expenses'),
  search_expenses: contract('search_expenses', 'Expense search'),
  balances: contract('balances', 'Balances'),
  settle_plan: contract('settle_plan', 'Settlement plan'),
  budgets: contract('budgets', 'Budgets'),
  budget_status: contract('budget_status', 'Budget status'),
  recurring: contract('recurring', 'Recurring expenses'),
  forecast: contract('forecast', 'Spending forecast'),
  anomalies: contract('anomalies', 'Spending anomalies'),
  personal_overview: contract('personal_overview', 'Personal overview'),
  entity_lookup: contract('entity_lookup', 'Entity lookup'),
  chat_search: contract('chat_search', 'Chat search', ['local_chat'], 3_000),
  call_stats: contract('call_stats', 'Call statistics', ['local_calls'], 3_000),
  group_compare: contract('group_compare', 'Group comparison'),
});

const SURFACE_PACKS: Record<AiSurface, ReadonlySet<string>> = {
  assistant: new Set(Object.keys(AI_TOOL_CONTRACTS)),
  insights: new Set(Object.keys(AI_TOOL_CONTRACTS).filter((name) => AI_TOOL_CONTRACTS[name].dataClasses.every((kind) => kind === 'persistent_money'))),
  search: new Set(['entity_lookup', 'search_expenses', 'top_expenses']),
  siri: new Set(['range_totals', 'month_summary', 'balances', 'settle_plan', 'budget_status']),
};

export function getToolContract(name: string): AiToolContract | null {
  return AI_TOOL_CONTRACTS[name] ?? null;
}

export function evidenceForToolResults(results: readonly ToolResult[]): AiToolEvidence[] {
  const seen = new Set<string>();
  const evidence: AiToolEvidence[] = [];
  for (const result of results) {
    if (result.error || seen.has(result.tool)) continue;
    const policy = AI_TOOL_CONTRACTS[result.tool];
    if (!policy) continue;
    seen.add(result.tool);
    evidence.push({
      kind: 'capability',
      tool: policy.name,
      version: policy.version,
      title: policy.title,
      dataClasses: [...policy.dataClasses],
    });
  }
  return evidence;
}

export const MAX_REQUESTS_PER_HOP = 3;
export const MAX_TOTAL_REQUESTS = 8;

/** 'local' tools never leave the device (doc 24 privacy-tier rule). */
export function toolTier(name: string): 'graph' | 'local' | null {
  return TOOLS[name]?.tier ?? null;
}

export interface ToolFilter {
  /** False when the turn runs on PCC — local-tier tools must not be offered. */
  includeLocal?: boolean;
  /** Product surface allowlist. Omit only for low-level tests/legacy callers. */
  surface?: AiSurface | string;
  /** Absolute wall-clock cutoff shared by the whole data-gathering loop. */
  deadlineAt?: number;
  signal?: AbortSignal;
}

/** Tools runnable with the given ctx (scope + providers + tier filter). */
export function availableTools(ctx: ToolCtx, filter: ToolFilter = {}): string[] {
  return Object.entries(TOOLS)
    .filter(([name, t]) => {
      const hasKnownSurface =
        !!filter.surface && Object.prototype.hasOwnProperty.call(SURFACE_PACKS, filter.surface);
      const pack = hasKnownSurface ? SURFACE_PACKS[filter.surface as AiSurface] : null;
      // A supplied but unknown surface is a policy/configuration error. Fail
      // closed rather than exposing the assistant's broad capability pack.
      if (filter.surface && !hasKnownSurface) return false;
      if (pack && !pack.has(name)) return false;
      const scoped =
        t.needs === 'any'
          ? !!ctx.group || !!ctx.personalGroups?.length
          : t.needs === 'group'
            ? !!ctx.group
            : !!ctx.personalGroups?.length;
      if (!scoped) return false;
      if (t.tier === 'local') {
        if (filter.includeLocal === false) return false;
        if (name === 'chat_search' && !ctx.chatSearch) return false;
        if (name === 'call_stats' && !ctx.callStats) return false;
      }
      return true;
    })
    .map(([name]) => name);
}

/** One line per available tool — embedded in the router instructions. */
export function toolCatalog(ctx: ToolCtx, filter: ToolFilter = {}): string {
  return availableTools(ctx, filter)
    .map((name) => `- ${TOOLS[name].doc}`)
    .join('\n');
}

/** Stable dedupe key for a request (resolved args included). */
export function requestKey(req: ToolRequest): string {
  return [req.tool, req.month, req.monthB, req.category, req.member, req.merchant, req.query, req.n, req.months]
    .map((v) => norm(String(v ?? '')))
    .join('|');
}

/** "Pulling April 2026 totals…" — deterministic status line for a request (P2 UI). */
export function statusLineFor(req: ToolRequest, ctx: ToolCtx): string {
  const t = TOOLS[req.tool];
  if (!t) return 'Looking that up…';
  const verbs: Record<string, string> = {
    compare_ranges: 'Comparing', settle_plan: 'Working out', forecast: 'Projecting',
    chat_search: 'Searching the chat for', call_stats: 'Checking calls for', entity_lookup: 'Looking up',
  };
  const result = verbs[req.tool] ?? 'Pulling';
  const p = resolvePeriod(req.month, ctx.now);
  const subject =
    req.tool === 'compare_ranges' && p && resolvePeriod(req.monthB, ctx.now)
      ? `${p.label} vs ${resolvePeriod(req.monthB, ctx.now)?.label}`
      : req.category || req.member || req.merchant || req.query || (p ? p.label : req.tool.replace(/_/g, ' '));
  return `${result} ${subject}…`;
}

/**
 * Execute one hop's requests: validate, dedupe against `seenKeys`, cap, run
 * each guarded. Unknown tools and throwing tools become error results — the
 * model adjusts course from the error text; the pipeline never crashes on a
 * bad request.
 */
export async function executeToolRequests(
  requests: readonly ToolRequest[],
  ctx: ToolCtx,
  seenKeys: Set<string>,
  filter: ToolFilter = {},
): Promise<ToolResult[]> {
  const available = new Set(availableTools(ctx, filter));
  const out: ToolResult[] = [];
  for (let req of requests) {
    if (out.length >= MAX_REQUESTS_PER_HOP) break;
    if (seenKeys.size + out.length >= MAX_TOTAL_REQUESTS) break;
    // Learned entity fixes rewrite member args before anything else (doc 25 Q2)
    // — a fixed alias resolves deterministically and never re-clarifies.
    if (req.member && ctx.entityFixes) {
      const fix = ctx.entityFixes[norm(req.member)];
      if (fix) req = { ...req, member: fix };
    }
    const key = requestKey(req);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (!available.has(req.tool)) {
      out.push({
        ...err(req.tool || 'unknown', 'unavailable tool', 'That capability is not available in this context.'),
        code: 'forbidden',
        durationMs: 0,
        dataClasses: [],
      });
      continue;
    }
    const tool = TOOLS[req.tool];
    const policy = AI_TOOL_CONTRACTS[req.tool];
    const started = Date.now();
    const remaining = filter.deadlineAt == null ? policy.timeoutMs : Math.min(policy.timeoutMs, filter.deadlineAt - started);
    if (filter.signal?.aborted || remaining <= 0) {
      out.push({
        ...err(req.tool, policy.title, filter.signal?.aborted ? 'The request was cancelled.' : 'The capability timed out.'),
        code: filter.signal?.aborted ? 'cancelled' : 'timeout',
        durationMs: 0,
        dataClasses: [...policy.dataClasses],
      });
      continue;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    filter.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), remaining);
    try {
      const result = await Promise.race([
        Promise.resolve(tool.run(req, { ...ctx, signal: controller.signal })),
        new Promise<ToolResult>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
        }),
      ]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.json);
      } catch {
        parsed = null;
      }
      if (parsed == null || typeof parsed !== 'object') {
        out.push({
          ...err(req.tool, policy.title, 'The capability returned an invalid result.'),
          code: 'invalid_output',
          durationMs: Date.now() - started,
          dataClasses: [...policy.dataClasses],
        });
      } else if (result.json.length * 2 > policy.maxResultBytes) {
        out.push({
          ...err(req.tool, policy.title, 'The capability returned too much data.'),
          code: 'result_too_large',
          durationMs: Date.now() - started,
          dataClasses: [...policy.dataClasses],
        });
      } else {
        out.push({
          ...result,
          status: result.error ? 'error' : 'ok',
          code: result.error ? result.code ?? 'invalid_args' : undefined,
          durationMs: Date.now() - started,
          dataClasses: [...policy.dataClasses],
        });
      }
    } catch {
      const cancelled = filter.signal?.aborted === true;
      out.push({
        ...err(req.tool, policy.title, cancelled ? 'The request was cancelled.' : controller.signal.aborted ? 'The capability timed out.' : 'The capability could not be completed.'),
        code: cancelled ? 'cancelled' : controller.signal.aborted ? 'timeout' : 'internal',
        durationMs: Date.now() - started,
        dataClasses: [...policy.dataClasses],
      });
    } finally {
      clearTimeout(timeout);
      filter.signal?.removeEventListener('abort', onAbort);
    }
  }
  return out;
}

/** TOOL RESULTS block for prompts: numbered, labeled, compact JSON. */
export function toolResultsBlock(results: readonly ToolResult[]): string {
  return results.map((r, i) => `T${i + 1} ${r.label}:\n${r.json}`).join('\n');
}
