/**
 * statsInsights.ts — deterministic stats/insights engine (ai_layer/docs/22).
 *
 * Pure module (no RN/native imports, fully unit-testable) built on top of
 * expenseAnalytics. Produces everything the upgraded stats surfaces render:
 * range aggregates, month-over-month category trends, member/fairness
 * breakdowns, merchant + receipt-savings aggregation, burn-rate forecasts,
 * anomaly detection, settle velocity, budget status — and HEURISTIC insight
 * cards, which double as the no-AI fallback tier of the insights engine
 * (on-device model → PCC → these).
 *
 * Money values are plain numbers in the group currency; rendering goes through
 * the guard/lens funnels (useMoneyDisplay/MoneyText) — never format here.
 */

import type { Expense } from '@/models/expense';
import type { GroupMember, Settlement } from '@/models/group';
import { calendarWindow, cents, isSpend, userShareOf, type Timeframe } from './expenseAnalytics';

export type StatsRange = 'month' | 'quarter' | 'year' | 'all';

// Short enough that all four chips fit one row on a 375pt screen.
export const RANGE_LABELS: Record<StatsRange, string> = {
  month: 'Month',
  quarter: '3 months',
  year: 'Year',
  all: 'All time',
};

/** Calendar window for a stats range; null = all time. */
export function rangeWindow(range: StatsRange, now: number): Timeframe | null {
  if (range === 'all') return null;
  if (range === 'month') return calendarWindow(now, 'month', 0);
  if (range === 'year') return calendarWindow(now, 'year', 0);
  // quarter = current + previous 2 calendar months.
  const start = calendarWindow(now, 'month', -2);
  const end = calendarWindow(now, 'month', 0);
  return { startMs: start.startMs, endMs: end.endMs, label: 'the last 3 months' };
}

const inWindow = (e: Expense, tf: Timeframe | null): boolean =>
  !tf || (e.createdAt >= tf.startMs && e.createdAt <= tf.endMs);

// ── Range aggregate ──────────────────────────────────────────────────────────

export interface RangeAggregate {
  total: number;
  userShare: number;
  count: number;
  byCategory: { category: string; total: number; userShare: number; count: number }[];
}

export function aggregateRange(
  expenses: readonly Expense[],
  tf: Timeframe | null,
  userId: string,
): RangeAggregate {
  const rows = (expenses ?? []).filter(isSpend).filter((e) => inWindow(e, tf));
  const catMap = new Map<string, { category: string; total: number; userShare: number; count: number }>();
  let total = 0;
  let userShare = 0;
  for (const e of rows) {
    const amount = Number(e.amount) || 0;
    const share = userShareOf(e, userId);
    total += amount;
    userShare += share;
    const cat = (e.category ?? 'General').trim() || 'General';
    const agg = catMap.get(cat) ?? { category: cat, total: 0, userShare: 0, count: 0 };
    agg.total += amount;
    agg.userShare += share;
    agg.count += 1;
    catMap.set(cat, agg);
  }
  return {
    total: cents(total),
    userShare: cents(userShare),
    count: rows.length,
    byCategory: [...catMap.values()]
      .map((c) => ({ ...c, total: cents(c.total), userShare: cents(c.userShare) }))
      .sort((a, b) => b.total - a.total),
  };
}

// ── Category trends (current vs previous comparable window) ──────────────────

export interface TrendRow {
  category: string;
  current: number;
  previous: number;
  /** Percent change vs previous; null when previous was 0 (new category). */
  deltaPct: number | null;
}

export function categoryTrends(expenses: readonly Expense[], now: number): TrendRow[] {
  const cur = calendarWindow(now, 'month', 0);
  const prev = calendarWindow(now, 'month', -1);
  const sumBy = (tf: Timeframe): Map<string, number> => {
    const m = new Map<string, number>();
    for (const e of (expenses ?? []).filter(isSpend).filter((x) => inWindow(x, tf))) {
      const cat = (e.category ?? 'General').trim() || 'General';
      m.set(cat, (m.get(cat) ?? 0) + (Number(e.amount) || 0));
    }
    return m;
  };
  const curMap = sumBy(cur);
  const prevMap = sumBy(prev);
  const cats = new Set([...curMap.keys(), ...prevMap.keys()]);
  return [...cats]
    .map((category) => {
      const current = cents(curMap.get(category) ?? 0);
      const previous = cents(prevMap.get(category) ?? 0);
      return {
        category,
        current,
        previous,
        deltaPct: previous > 0 ? Math.round(((current - previous) / previous) * 100) : null,
      };
    })
    .sort((a, b) => b.current - a.current);
}

// ── Member breakdown + fairness ──────────────────────────────────────────────

export interface MemberRow {
  userId: string;
  name: string;
  /** Total they fronted (paidBy). */
  paid: number;
  /** Total consumption (their shares). */
  share: number;
}

export interface FairnessInfo {
  topPayerId: string;
  topPayerName: string;
  /** Share of all spend fronted by the top payer, 0–100. */
  topPayerPct: number;
}

export function memberBreakdown(
  expenses: readonly Expense[],
  members: readonly Pick<GroupMember, 'userId' | 'displayName'>[],
  tf: Timeframe | null,
): { rows: MemberRow[]; fairness: FairnessInfo | null } {
  const spend = (expenses ?? []).filter(isSpend).filter((e) => inWindow(e, tf));
  const rows: MemberRow[] = members.map((m) => ({
    userId: m.userId,
    name: m.displayName,
    paid: 0,
    share: 0,
  }));
  const byId = new Map(rows.map((r) => [r.userId, r]));
  let total = 0;
  for (const e of spend) {
    const amount = Number(e.amount) || 0;
    total += amount;
    const payer = byId.get(e.paidBy);
    if (payer) payer.paid += amount;
    for (const p of e.participants ?? []) {
      const row = byId.get(p.userId);
      if (row) row.share += Number(p.share) || 0;
    }
  }
  for (const r of rows) {
    r.paid = cents(r.paid);
    r.share = cents(r.share);
  }
  rows.sort((a, b) => b.paid - a.paid);
  const top = rows[0];
  const fairness =
    total > 0 && top && top.paid > 0
      ? {
          topPayerId: top.userId,
          topPayerName: top.name,
          topPayerPct: Math.round((top.paid / total) * 100),
        }
      : null;
  return { rows, fairness };
}

// ── Merchants & receipt savings ──────────────────────────────────────────────

export interface MerchantRow {
  name: string;
  total: number;
  count: number;
  savings: number;
}

/** Merchant ≈ normalized expense title; savings come from receipt OCR insights. */
export function merchantAggregate(expenses: readonly Expense[], tf: Timeframe | null): {
  merchants: MerchantRow[];
  totalSavings: number;
} {
  const map = new Map<string, MerchantRow>();
  let totalSavings = 0;
  for (const e of (expenses ?? []).filter(isSpend).filter((x) => inWindow(x, tf))) {
    const name = (e.title ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const row = map.get(key) ?? { name, total: 0, count: 0, savings: 0 };
    row.total += Number(e.amount) || 0;
    row.count += 1;
    const savings = Number(e.receipt?.insights?.savings) || 0;
    row.savings += savings;
    totalSavings += savings;
    map.set(key, row);
  }
  return {
    merchants: [...map.values()]
      .map((r) => ({ ...r, total: cents(r.total), savings: cents(r.savings) }))
      .sort((a, b) => b.total - a.total),
    totalSavings: cents(totalSavings),
  };
}

// ── Forecast: burn rate + recurring commitments ──────────────────────────────

export interface ForecastInfo {
  monthToDate: number;
  daysElapsed: number;
  daysInMonth: number;
  /** Straight-line month-end projection from the burn rate. */
  projectedTotal: number;
  /** Previous full calendar month total (comparison anchor). */
  previousMonthTotal: number;
  /** Sum of recurring bills expected to bill next month (0 when unknown). */
  recurringCommitted: number;
}

export function buildForecast(
  expenses: readonly Expense[],
  now: number,
  recurringMonthly: number = 0,
): ForecastInfo {
  const cur = calendarWindow(now, 'month', 0);
  const prev = calendarWindow(now, 'month', -1);
  const d = new Date(now);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const daysElapsed = Math.max(1, d.getDate());
  const mtd = aggregateRange(expenses, cur, '').total;
  const prevTotal = aggregateRange(expenses, prev, '').total;
  return {
    monthToDate: mtd,
    daysElapsed,
    daysInMonth,
    projectedTotal: cents((mtd / daysElapsed) * daysInMonth),
    previousMonthTotal: prevTotal,
    recurringCommitted: cents(recurringMonthly),
  };
}

/** Approximate a recurring bill's monthly commitment from its rule. */
export function monthlyCommitment(
  bills: readonly { amount: number; recurrenceRule?: { frequency?: string; interval?: number } }[],
): number {
  let total = 0;
  for (const b of bills ?? []) {
    const amount = Number(b.amount) || 0;
    const interval = Math.max(1, Number(b.recurrenceRule?.interval) || 1);
    switch (b.recurrenceRule?.frequency) {
      case 'daily':
        total += (amount * 30.4) / interval;
        break;
      case 'weekly':
        total += (amount * 4.33) / interval;
        break;
      case 'yearly':
        total += amount / (12 * interval);
        break;
      case 'monthly':
      default:
        total += amount / interval;
        break;
    }
  }
  return cents(total);
}

// ── Anomalies: recent spends far above the category baseline ─────────────────

export interface AnomalyInfo {
  expenseId: string;
  title: string;
  category: string;
  amount: number;
  /** Category average over the baseline window (excluding this expense). */
  baseline: number;
  /** amount / baseline, rounded to 1 decimal. */
  ratio: number;
}

const DAY = 86400000;

export function detectAnomalies(
  expenses: readonly Expense[],
  now: number,
  opts: { recentDays?: number; baselineDays?: number; minBaselineCount?: number; minRatio?: number } = {},
): AnomalyInfo[] {
  const recentDays = opts.recentDays ?? 14;
  const baselineDays = opts.baselineDays ?? 90;
  const minBaselineCount = opts.minBaselineCount ?? 3;
  const minRatio = opts.minRatio ?? 2;

  const spend = (expenses ?? []).filter(isSpend);
  const recent = spend.filter((e) => now - e.createdAt <= recentDays * DAY);
  const out: AnomalyInfo[] = [];
  for (const e of recent) {
    const cat = (e.category ?? 'General').trim() || 'General';
    const baselineRows = spend.filter(
      (x) =>
        x.expenseId !== e.expenseId &&
        ((x.category ?? 'General').trim() || 'General') === cat &&
        e.createdAt - x.createdAt > 0 &&
        e.createdAt - x.createdAt <= baselineDays * DAY,
    );
    if (baselineRows.length < minBaselineCount) continue;
    const baseline = baselineRows.reduce((s, x) => s + (Number(x.amount) || 0), 0) / baselineRows.length;
    if (baseline <= 0) continue;
    const ratio = (Number(e.amount) || 0) / baseline;
    if (ratio >= minRatio) {
      out.push({
        expenseId: e.expenseId,
        title: e.title,
        category: cat,
        amount: cents(e.amount),
        baseline: cents(baseline),
        ratio: Math.round(ratio * 10) / 10,
      });
    }
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

// ── Daily rhythm heatmap (weekday × week grid, GitHub-style) ─────────────────

export interface HeatmapData {
  /** grid[week][weekday] — weekday 0 = Sunday; weeks oldest → newest. */
  grid: number[][];
  /** Largest single-day total (0 when the whole window is empty). */
  max: number;
  /** Cell address of "today" so renderers can blank out future cells. */
  todayWeek: number;
  todayDay: number;
  /** Short month label per week column ('' when the column starts no new month). */
  monthLabels: string[];
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const startOfDayMs = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/**
 * Aggregate spend into a weekday × week grid covering the trailing `weeks`
 * weeks (Sunday-aligned, ending in the week containing `now`). Day indexing
 * uses Math.round over local midnights so DST shifts can't skew a cell.
 */
export function dailyHeatmap(expenses: readonly Expense[], now: number, weeks = 12): HeatmapData {
  const today = new Date(now);
  const todayMid = startOfDayMs(now);
  const origin = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - today.getDay() - (weeks - 1) * 7,
  );
  const originMid = origin.getTime();

  const grid: number[][] = Array.from({ length: weeks }, () => Array(7).fill(0));
  let max = 0;
  for (const e of (expenses ?? []).filter(isSpend)) {
    if (e.createdAt > now) continue;
    const idx = Math.round((startOfDayMs(e.createdAt) - originMid) / DAY);
    if (idx < 0) continue;
    const week = Math.floor(idx / 7);
    const day = idx % 7;
    if (week >= weeks) continue;
    const next = cents(grid[week][day] + (Number(e.amount) || 0));
    grid[week][day] = next;
    if (next > max) max = next;
  }

  const monthLabels: string[] = [];
  let lastMonth = -1;
  let lastLabeledCol = -Infinity;
  for (let w = 0; w < weeks; w++) {
    const colStart = new Date(origin.getFullYear(), origin.getMonth(), origin.getDate() + w * 7);
    const m = colStart.getMonth();
    // A label needs ~3 columns of room to render without colliding with the
    // previous one, so a month change hard on the heels of another stays blank.
    if (m !== lastMonth && w - lastLabeledCol >= 3) {
      monthLabels.push(MONTHS_SHORT[m]);
      lastLabeledCol = w;
    } else {
      monthLabels.push('');
    }
    lastMonth = m;
  }

  const todayIdx = Math.round((todayMid - originMid) / DAY);
  return {
    grid,
    max,
    todayWeek: Math.floor(todayIdx / 7),
    todayDay: todayIdx % 7,
    monthLabels,
  };
}

// ── Settle velocity ──────────────────────────────────────────────────────────

export interface SettleVelocityInfo {
  /** Days since the most recent settlement (null when none recorded). */
  daysSinceLastSettlement: number | null;
  /** True when the group currently has open debts. */
  hasOpenDebts: boolean;
}

export function settleVelocity(
  settlements: readonly Settlement[],
  balances: Readonly<Record<string, number>>,
  now: number,
): SettleVelocityInfo {
  const last = (settlements ?? []).reduce<number | null>(
    (max, s) => (max == null || s.createdAt > max ? s.createdAt : max),
    null,
  );
  const hasOpenDebts = Object.values(balances ?? {}).some((b) => Math.abs(b) >= 0.005);
  return {
    daysSinceLastSettlement: last == null ? null : Math.floor((now - last) / DAY),
    hasOpenDebts,
  };
}

// ── Budgets ──────────────────────────────────────────────────────────────────

/** category → monthly budget amount (group currency). */
export type BudgetMap = Record<string, number>;

export interface BudgetStatusRow {
  category: string;
  budget: number;
  spent: number;
  /** 0–100+ (may exceed 100). */
  pct: number;
}

export function budgetStatus(
  budgets: BudgetMap | undefined,
  expenses: readonly Expense[],
  now: number,
  /** When set, measure the USER's share against the budget instead of group total. */
  userId?: string,
): BudgetStatusRow[] {
  if (!budgets) return [];
  const cur = calendarWindow(now, 'month', 0);
  const agg = aggregateRange(expenses, cur, userId ?? '');
  const byCat = new Map(agg.byCategory.map((c) => [c.category.toLowerCase(), c]));
  return Object.entries(budgets)
    .filter(([, amount]) => Number(amount) > 0)
    .map(([category, amount]) => {
      const row = byCat.get(category.toLowerCase());
      const spent = userId ? row?.userShare ?? 0 : row?.total ?? 0;
      return {
        category,
        budget: cents(Number(amount)),
        spent: cents(spent),
        pct: Math.round((spent / Number(amount)) * 100),
      };
    })
    .sort((a, b) => b.pct - a.pct);
}

// ── Heuristic insight cards (the no-AI fallback tier) ────────────────────────

export interface InsightCard {
  id: string;
  kind: 'trend' | 'anomaly' | 'forecast' | 'fairness' | 'savings' | 'budget' | 'velocity' | 'recurring';
  severity: 'info' | 'warn' | 'good';
  title: string;
  body: string;
  /** Money value the card headline refers to (rendered via the money funnels). */
  amount?: number;
}

export interface HeuristicInputs {
  trends: TrendRow[];
  anomalies: AnomalyInfo[];
  forecast: ForecastInfo;
  fairness: FairnessInfo | null;
  totalSavings: number;
  budgets: BudgetStatusRow[];
  velocity: SettleVelocityInfo;
  staleDays: number;
  /** Detected recurring-looking pattern not yet set up as a bill (doc 26). */
  recurringSuggestion?: { title: string; medianAmount: number; cadence: 'weekly' | 'monthly'; occurrenceCount: number } | null;
}

export function buildHeuristicCards(inputs: HeuristicInputs): InsightCard[] {
  const cards: InsightCard[] = [];

  const mover = inputs.trends
    .filter((t) => t.deltaPct != null && t.previous > 0 && Math.abs(t.deltaPct) >= 25)
    .sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0))[0];
  if (mover && mover.deltaPct != null) {
    const up = mover.deltaPct > 0;
    cards.push({
      id: `trend-${mover.category}`,
      kind: 'trend',
      severity: up ? 'warn' : 'good',
      title: `${mover.category} ${up ? 'up' : 'down'} ${Math.abs(mover.deltaPct)}%`,
      body: `${mover.category} is ${up ? 'above' : 'below'} last month's pace.`,
      amount: mover.current,
    });
  }

  const anomaly = inputs.anomalies[0];
  if (anomaly) {
    cards.push({
      id: `anomaly-${anomaly.expenseId}`,
      kind: 'anomaly',
      severity: 'warn',
      title: `${anomaly.title}: ${anomaly.ratio}× the usual`,
      body: `Typical ${anomaly.category} in this group runs much lower — worth a look.`,
      amount: anomaly.amount,
    });
  }

  const over = inputs.budgets.find((b) => b.pct >= 80);
  if (over) {
    cards.push({
      id: `budget-${over.category}`,
      kind: 'budget',
      severity: over.pct >= 100 ? 'warn' : 'info',
      title:
        over.pct >= 100
          ? `${over.category} budget exceeded (${over.pct}%)`
          : `${over.category} at ${over.pct}% of budget`,
      body: `Monthly ${over.category} budget is nearly used up.`,
      amount: over.spent,
    });
  }

  const f = inputs.forecast;
  if (f.previousMonthTotal > 0 && f.projectedTotal > f.previousMonthTotal * 1.15 && f.daysElapsed >= 7) {
    cards.push({
      id: 'forecast-over',
      kind: 'forecast',
      severity: 'info',
      title: 'Trending over last month',
      body: `At the current pace this month projects ${Math.round(
        ((f.projectedTotal - f.previousMonthTotal) / f.previousMonthTotal) * 100,
      )}% above last month.`,
      amount: f.projectedTotal,
    });
  }

  if (inputs.fairness && inputs.fairness.topPayerPct >= 60) {
    cards.push({
      id: 'fairness-top',
      kind: 'fairness',
      severity: 'info',
      title: `${inputs.fairness.topPayerName} fronts ${inputs.fairness.topPayerPct}% of spend`,
      body: 'One person is covering most bills — a settle-up would even things out.',
    });
  }

  if (inputs.totalSavings > 0) {
    cards.push({
      id: 'savings-total',
      kind: 'savings',
      severity: 'good',
      title: 'Receipt savings captured',
      body: 'Discounts and coupons caught on scanned receipts in this range.',
      amount: inputs.totalSavings,
    });
  }

  const rec = inputs.recurringSuggestion;
  if (rec) {
    cards.push({
      id: `recurring-${rec.title}`,
      kind: 'recurring',
      severity: 'info',
      title: `${rec.title} looks recurring`,
      body: `Added ${rec.occurrenceCount} times on a ${rec.cadence} rhythm — set it up as a recurring bill and it handles itself.`,
      amount: rec.medianAmount,
    });
  }

  if (
    inputs.velocity.hasOpenDebts &&
    inputs.velocity.daysSinceLastSettlement != null &&
    inputs.velocity.daysSinceLastSettlement >= inputs.staleDays
  ) {
    cards.push({
      id: 'velocity-stale',
      kind: 'velocity',
      severity: 'info',
      title: `No settle-up in ${inputs.velocity.daysSinceLastSettlement} days`,
      body: 'Debts are open — settling now keeps balances easy.',
    });
  }

  return cards;
}

// ── Question-driven extra context (doc 23 chat enrichment) ───────────────────

const MONTHS_FULL = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * Targeted extra facts for ONE chat question: when the user names a month, a
 * category, a member, or a merchant, aggregate exactly that and nothing more.
 * The base facts blob stays compact; this rides along per-turn. Deterministic
 * and pure — the model still only narrates. Returns null when the question
 * names nothing we can enrich.
 */
export function questionContext(
  question: string,
  expenses: readonly Expense[],
  members: readonly Pick<GroupMember, 'userId' | 'displayName'>[],
  now: number,
): string | null {
  const q = (question ?? '').toLowerCase();
  if (!q) return null;
  const rows = (expenses ?? []).filter(isSpend);
  const out: Record<string, unknown> = {};

  // Named calendar months (last 12) — "what about April?"
  const monthHits: { month: string; total: number; top: { c: string; t: number }[] }[] = [];
  for (let shift = 0; shift > -12 && monthHits.length < 3; shift--) {
    const tf = calendarWindow(now, 'month', shift);
    const d = new Date(tf.startMs);
    const name = MONTHS_FULL[d.getMonth()];
    if (!q.includes(name)) continue;
    const agg = aggregateRange(rows, tf, '');
    monthHits.push({
      month: `${name[0].toUpperCase()}${name.slice(1)} ${d.getFullYear()}`,
      total: agg.total,
      top: agg.byCategory.slice(0, 3).map((c) => ({ c: c.category, t: c.total })),
    });
  }
  if (monthHits.length) out.months = monthHits;

  // Named categories — monthly trail so "why did X change" has history.
  const cats = [...new Set(rows.map((e) => ((e.category ?? 'General').trim() || 'General')))];
  const catHits: { category: string; total: number; count: number; byMonth: { m: string; t: number }[] }[] = [];
  for (const cat of cats) {
    if (catHits.length >= 2) break;
    if (cat.length < 3 || !q.includes(cat.toLowerCase())) continue;
    const catRows = rows.filter((e) => ((e.category ?? 'General').trim() || 'General') === cat);
    const byMonth: { m: string; t: number }[] = [];
    for (let shift = 0; shift > -6; shift--) {
      const tf = calendarWindow(now, 'month', shift);
      const total = cents(
        catRows.filter((e) => inWindow(e, tf)).reduce((s, e) => s + (Number(e.amount) || 0), 0),
      );
      if (total > 0) byMonth.push({ m: MONTHS_SHORT[new Date(tf.startMs).getMonth()], t: total });
    }
    catHits.push({
      category: cat,
      total: cents(catRows.reduce((s, e) => s + (Number(e.amount) || 0), 0)),
      count: catRows.length,
      byMonth,
    });
  }
  if (catHits.length) out.categories = catHits;

  // Named members — paid vs consumed, all time (same data the members card shows).
  const memberHits: { name: string; paid: number; share: number }[] = [];
  for (const m of members ?? []) {
    if (memberHits.length >= 2) break;
    const first = (m.displayName ?? '').split(/\s+/)[0];
    if (first.length < 3 || !q.includes(first.toLowerCase())) continue;
    const b = memberBreakdown(rows, [m], null).rows[0];
    if (b) memberHits.push({ name: m.displayName, paid: b.paid, share: b.share });
  }
  if (memberHits.length) out.members = memberHits;

  // Named merchants (expense titles) — "how much at Walmart?"
  const merchantHits: { name: string; total: number; count: number }[] = [];
  for (const m of merchantAggregate(rows, null).merchants) {
    if (merchantHits.length >= 2) break;
    if (m.name.length < 4 || !q.includes(m.name.toLowerCase())) continue;
    merchantHits.push({ name: m.name, total: m.total, count: m.count });
  }
  if (merchantHits.length) out.merchants = merchantHits;

  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// ── Compact facts blob for the AI narrative tier ─────────────────────────────

/**
 * Serialize the deterministic numbers into a compact facts object for the AI
 * layer (on-device or PCC). The model NARRATES these facts — it never does
 * arithmetic — so numbers here are final and rounded.
 */
export function buildStatsFacts(args: {
  groupName: string;
  currency: string;
  range: StatsRange;
  aggregate: RangeAggregate;
  trends: TrendRow[];
  members: MemberRow[];
  fairness: FairnessInfo | null;
  forecast: ForecastInfo;
  anomalies: AnomalyInfo[];
  budgets: BudgetStatusRow[];
  totalSavings: number;
  /** Pre-written heuristic insight headlines — substance for the chat model. */
  headlines?: { t: string; b: string }[];
}): string {
  const { aggregate } = args;
  return JSON.stringify({
    ...(args.headlines?.length ? { insights: args.headlines } : {}),
    group: args.groupName,
    currency: args.currency,
    range: args.range,
    total: aggregate.total,
    count: aggregate.count,
    topCategories: aggregate.byCategory.slice(0, 5).map((c) => ({ c: c.category, t: c.total })),
    trends: args.trends.slice(0, 5).map((t) => ({ c: t.category, cur: t.current, prev: t.previous, d: t.deltaPct })),
    members: args.members.map((m) => ({ n: m.name, paid: m.paid, share: m.share })),
    topPayerPct: args.fairness?.topPayerPct ?? null,
    forecast: {
      mtd: args.forecast.monthToDate,
      projected: args.forecast.projectedTotal,
      prevMonth: args.forecast.previousMonthTotal,
      recurring: args.forecast.recurringCommitted,
    },
    anomalies: args.anomalies.slice(0, 3).map((a) => ({ t: a.title, amt: a.amount, x: a.ratio })),
    budgets: args.budgets.map((b) => ({ c: b.category, pct: b.pct })),
    savings: args.totalSavings,
  });
}

// ── Personal (cross-group) aggregation ───────────────────────────────────────

interface PersonalGroupLike {
  groupId: string;
  name: string;
  currency: string;
  expenses?: Expense[];
}

export interface PersonalGroupRow {
  groupId: string;
  name: string;
  currency: string;
  /** The user's summed share in this group for the range. */
  yourShare: number;
  count: number;
}

export interface PersonalStatsBundle {
  range: StatsRange;
  /** Per-group rows (amounts stay in EACH group's own currency — no cross-currency summing). */
  groups: PersonalGroupRow[];
  /** Top categories of the user's own share, per currency bucket. */
  categoriesByCurrency: Record<string, { category: string; yourShare: number }[]>;
}

export function buildPersonalStats(
  groups: readonly PersonalGroupLike[],
  userId: string,
  range: StatsRange,
  now: number,
): PersonalStatsBundle {
  const tf = rangeWindow(range, now);
  const rows: PersonalGroupRow[] = [];
  const catBuckets = new Map<string, Map<string, number>>();
  for (const g of groups ?? []) {
    const agg = aggregateRange(g.expenses ?? [], tf, userId);
    if (agg.count === 0 && agg.userShare === 0) continue;
    rows.push({
      groupId: g.groupId,
      name: g.name,
      currency: (g.currency ?? 'USD').toUpperCase(),
      yourShare: agg.userShare,
      count: agg.count,
    });
    const bucket = catBuckets.get((g.currency ?? 'USD').toUpperCase()) ?? new Map<string, number>();
    for (const c of agg.byCategory) {
      if (c.userShare > 0) bucket.set(c.category, (bucket.get(c.category) ?? 0) + c.userShare);
    }
    catBuckets.set((g.currency ?? 'USD').toUpperCase(), bucket);
  }
  rows.sort((a, b) => b.yourShare - a.yourShare);
  const categoriesByCurrency: PersonalStatsBundle['categoriesByCurrency'] = {};
  for (const [currency, bucket] of catBuckets) {
    categoriesByCurrency[currency] = [...bucket.entries()]
      .map(([category, yourShare]) => ({ category, yourShare: cents(yourShare) }))
      .sort((a, b) => b.yourShare - a.yourShare)
      .slice(0, 8);
  }
  return { range, groups: rows, categoriesByCurrency };
}
