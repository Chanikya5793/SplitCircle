/**
 * aggregate.ts — Pure spending-analytics helpers for splitcircle-insights.
 *
 * All functions are pure and unit-tested. In production the rows come from the
 * BigQuery `splitcircle_ml.expenses` table; in tests they come from fixtures.
 * "Spend" is attributed to a user as their SHARE of an expense (not the full
 * amount), matching how balances work in the app.
 */

export interface ExpenseRow {
  expenseId: string;
  groupId: string;
  title: string;
  category: string | null;
  amount: number;        // full expense amount
  userShare: number;     // this user's share
  currency: string;
  paidBy: string;
  createdAtMs: number;
}

export type Period = 'week' | 'month' | 'quarter' | 'year';

export function periodWindow(period: Period, now: number = Date.now()): { start: number; end: number } {
  const day = 86_400_000;
  const spans: Record<Period, number> = { week: 7 * day, month: 30 * day, quarter: 91 * day, year: 365 * day };
  return { start: now - spans[period], end: now };
}

export interface SpendingSummary {
  total: number;
  byCategory: Record<string, number>;
  topExpenses: ExpenseRow[];
  count: number;
}

export function summarize(rows: ExpenseRow[]): SpendingSummary {
  const byCategory: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    total += r.userShare;
    const cat = r.category ?? 'uncategorized';
    byCategory[cat] = (byCategory[cat] ?? 0) + r.userShare;
  }
  const topExpenses = [...rows].sort((a, b) => b.userShare - a.userShare).slice(0, 5);
  return { total: round(total), byCategory: roundMap(byCategory), topExpenses, count: rows.length };
}

export interface PeriodComparison {
  total1: number;
  total2: number;
  delta: number;
  deltaPercent: number;
  trend: 'up' | 'down' | 'stable';
  categoryBreakdown: Record<string, { p1: number; p2: number; delta: number }>;
}

export function comparePeriods(rows1: ExpenseRow[], rows2: ExpenseRow[]): PeriodComparison {
  const s1 = summarize(rows1);
  const s2 = summarize(rows2);
  const delta = round(s2.total - s1.total);
  const deltaPercent = s1.total === 0 ? (s2.total === 0 ? 0 : 100) : round((delta / s1.total) * 100);
  const cats = new Set([...Object.keys(s1.byCategory), ...Object.keys(s2.byCategory)]);
  const categoryBreakdown: PeriodComparison['categoryBreakdown'] = {};
  for (const c of cats) {
    const p1 = s1.byCategory[c] ?? 0;
    const p2 = s2.byCategory[c] ?? 0;
    categoryBreakdown[c] = { p1, p2, delta: round(p2 - p1) };
  }
  return {
    total1: s1.total, total2: s2.total, delta, deltaPercent,
    trend: Math.abs(deltaPercent) < 5 ? 'stable' : delta > 0 ? 'up' : 'down',
    categoryBreakdown,
  };
}

export interface Anomaly { expense: ExpenseRow; reason: string; anomalyScore: number }

/**
 * Statistical anomaly detection (MODEL-03 v1): flag expenses whose userShare is
 * > zThreshold standard deviations above the user's usual spend in that category.
 *
 * Uses a LEAVE-ONE-OUT z-score (each expense is scored against the OTHER expenses
 * in its category). This is both more correct — an outlier shouldn't inflate its
 * own baseline — and necessary: with the in-sample population std and few points,
 * the max possible z is (n-1)/√n, which can't reach a useful threshold for small
 * categories. Needs >= 4 samples per category (>= 3 others) to avoid noise.
 */
export function findAnomalies(rows: ExpenseRow[], zThreshold = 2.5): Anomaly[] {
  const byCat: Record<string, ExpenseRow[]> = {};
  for (const r of rows) (byCat[r.category ?? 'uncategorized'] ??= []).push(r);

  const anomalies: Anomaly[] = [];
  for (const [cat, list] of Object.entries(byCat)) {
    if (list.length < 4) continue;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const others = list.filter((_, j) => j !== i).map((o) => o.userShare);
      const mean = others.reduce((a, b) => a + b, 0) / others.length;
      const variance = others.reduce((a, b) => a + (b - mean) ** 2, 0) / others.length;
      const sd = Math.sqrt(variance);

      if (sd === 0) {
        // Peers are identical — z-score is undefined. Flag only a meaningful jump
        // (> 25% above the perfectly-stable baseline) so we don't fire on noise.
        if (r.userShare > mean * 1.25) {
          anomalies.push({
            expense: r,
            anomalyScore: round(zThreshold + r.userShare / Math.max(mean, 0.01)),
            reason: `${r.currency}${r.userShare.toFixed(2)} is unusual — every prior "${cat}" expense was ${r.currency}${mean.toFixed(2)}.`,
          });
        }
        continue;
      }

      const z = (r.userShare - mean) / sd;
      if (z >= zThreshold) {
        anomalies.push({
          expense: r,
          anomalyScore: round(z),
          reason: `${r.currency}${r.userShare.toFixed(2)} is well above your usual "${cat}" spend (avg ${r.currency}${mean.toFixed(2)}, ${z.toFixed(1)}σ).`,
        });
      }
    }
  }
  return anomalies.sort((a, b) => b.anomalyScore - a.anomalyScore);
}

export interface GroupExpense {
  expenseId: string;
  amount: number;
  paidBy: string;
  participants: { userId: string; share: number }[];
}

export interface ContributionRow {
  userId: string;
  totalPaid: number;   // full amounts this member fronted
  totalOwed: number;   // sum of this member's shares (what they consumed)
  fairShare: number;   // equal split of total group spend
  delta: number;       // totalPaid - totalOwed (positive = creditor)
}

/**
 * Per-member contribution analysis for a group: how much each member paid (fronted)
 * vs. what they actually consumed (sum of their shares), vs. an equal fair share.
 */
export function contributionAnalysis(expenses: GroupExpense[], memberIds: string[]): ContributionRow[] {
  const paid: Record<string, number> = {};
  const owed: Record<string, number> = {};
  let totalSpend = 0;

  for (const e of expenses) {
    totalSpend += e.amount;
    paid[e.paidBy] = (paid[e.paidBy] ?? 0) + e.amount;
    for (const p of e.participants) {
      owed[p.userId] = (owed[p.userId] ?? 0) + p.share;
    }
  }

  const fair = memberIds.length > 0 ? totalSpend / memberIds.length : 0;
  return memberIds.map((uid) => {
    const totalPaid = round(paid[uid] ?? 0);
    const totalOwed = round(owed[uid] ?? 0);
    return { userId: uid, totalPaid, totalOwed, fairShare: round(fair), delta: round(totalPaid - totalOwed) };
  });
}

function round(n: number): number { return Math.round(n * 100) / 100; }
function roundMap(m: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v)]));
}

// ── Forecast (MODEL-02 surface) ───────────────────────────────────────────────

export interface ForecastPoint {
  month: string; // YYYY-MM
  predicted: number;
  lower: number;
  upper: number;
}

/** PURE: a one-line, friendly headline for a spending forecast. */
export function forecastHeadline(points: ForecastPoint[]): string {
  if (!points || points.length === 0) return 'Not enough history yet to forecast your spending.';
  const next = points[0];
  return `Projected spending for ${next.month}: ~${next.predicted} (range ${next.lower}–${next.upper}).`;
}
