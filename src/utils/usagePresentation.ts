/**
 * usagePresentation.ts — pure shaping for the Usage & Limits screen. No RN
 * imports, so it stays unit-testable.
 */
import type { Group } from '@/models';
import type {
  MonetizationCreditLedgerItem,
  MonetizationFeatureUsage,
  MonetizationUsageDay,
} from '@/models/monetization';
import { describeResetTime } from './monetizationPresentation';

export type MeterTone = 'normal' | 'nearLimit' | 'usedUp' | 'unlimited';

export interface MeterView {
  /** 0..1 share of the allowance used, or null when unlimited. */
  fraction: number | null;
  tone: MeterTone;
  /** "2 of 3 used", "14 used", "All 3 used". */
  headline: string;
  /** "Resets tomorrow", "Unlimited on your plan". */
  detail: string;
  /** What happens past the allowance. */
  overage: string | null;
}

const plural = (count: number, unit: { one: string; other: string }) =>
  `${count.toLocaleString()} ${count === 1 ? unit.one : unit.other}`;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const meterView = (
  feature: MonetizationFeatureUsage,
  nowMs = Date.now(),
): MeterView => {
  const consumed = feature.used + feature.reserved;
  if (feature.limit === null) {
    return {
      fraction: null,
      tone: 'unlimited',
      headline: `${plural(feature.used, feature.unit)} this period`,
      detail: 'Unlimited on your plan',
      overage: null,
    };
  }
  const fraction = feature.limit > 0 ? Math.min(1, consumed / feature.limit) : 1;
  const usedUp = feature.remaining === 0;
  const reset = feature.resetsAt ? `Resets ${describeResetTime(feature.resetsAt, nowMs)}` : 'Resets with your plan';
  return {
    fraction,
    tone: usedUp ? 'usedUp' : fraction >= 0.8 ? 'nearLimit' : 'normal',
    headline: usedUp
      ? `All ${feature.limit.toLocaleString()} used`
      : `${consumed.toLocaleString()} of ${feature.limit.toLocaleString()} used`,
    detail: reset,
    overage: feature.creditCost
      ? `Then ${feature.creditCost} ${feature.creditCost === 1 ? 'credit' : 'credits'} each, with your OK`
      : 'More with a higher plan',
  };
};

export interface DailySummary {
  totals: { day: string; total: number }[];
  max: number;
  totalUses: number;
  creditsSpent: number;
  activeDays: number;
  busiestDay: { day: string; total: number } | null;
  /** Totals per feature across the whole window, highest first. */
  byFeature: { featureId: string; total: number }[];
}

export const summarizeDaily = (daily: MonetizationUsageDay[]): DailySummary => {
  const byFeature = new Map<string, number>();
  const totals = daily.map((entry) => {
    let total = 0;
    for (const [featureId, count] of Object.entries(entry.counts)) {
      const value = count ?? 0;
      total += value;
      byFeature.set(featureId, (byFeature.get(featureId) ?? 0) + value);
    }
    return { day: entry.day, total };
  });
  const busiest = totals.reduce<{ day: string; total: number } | null>(
    (best, entry) => (entry.total > 0 && (!best || entry.total > best.total) ? entry : best),
    null,
  );
  return {
    totals,
    max: totals.reduce((max, entry) => Math.max(max, entry.total), 0),
    totalUses: totals.reduce((sum, entry) => sum + entry.total, 0),
    creditsSpent: daily.reduce((sum, entry) => sum + entry.creditsSpent, 0),
    activeDays: totals.filter((entry) => entry.total > 0).length,
    busiestDay: busiest,
    byFeature: [...byFeature.entries()]
      .map(([featureId, total]) => ({ featureId, total }))
      .filter((entry) => entry.total > 0)
      .sort((a, b) => b.total - a.total),
  };
};

/** "Oct 3" for a UTC day key, without shifting it into the local zone. */
export const formatUsageDay = (day: string): string => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
};

export interface LedgerView {
  title: string;
  /** "+80", "−2", or "—" for an entry that moved nothing. */
  amount: string;
  direction: 'credit' | 'debit' | 'none';
  note: string | null;
}

export const describeLedgerItem = (
  item: MonetizationCreditLedgerItem,
  featureLabels: Record<string, string>,
): LedgerView => {
  const amount = item.creditDelta > 0
    ? `+${item.creditDelta}`
    : item.creditDelta < 0 ? `−${Math.abs(item.creditDelta)}` : '—';
  const direction = item.creditDelta > 0 ? 'credit' : item.creditDelta < 0 ? 'debit' : 'none';
  const feature = item.featureId ? featureLabels[item.featureId] ?? 'A feature' : null;
  switch (item.type) {
    case 'apple_credit_purchase':
      return { title: 'Bought Mana Credits', amount, direction, note: 'App Store purchase' };
    case 'apple_credit_refund':
      return { title: 'Credits refunded by Apple', amount, direction, note: null };
    case 'support_courtesy_credit':
      return { title: 'Courtesy credits', amount, direction, note: 'From ManaSplit support' };
    case 'operation_reservation':
      if (item.status === 'released') {
        return { title: feature ?? 'Credit hold', amount, direction, note: 'Not charged — it didn’t complete' };
      }
      if (item.status === 'reserved') {
        return { title: feature ?? 'Credit hold', amount, direction, note: 'In progress' };
      }
      return { title: feature ?? 'Credits used', amount, direction, note: null };
    default:
      return {
        title: capitalize(item.type.replace(/_/g, ' ')),
        amount,
        direction,
        note: null,
      };
  }
};

export interface LocalActivity {
  expensesThisMonth: number;
  expensesLastMonth: number;
  settlementsThisMonth: number;
  activeGroups: number;
}

/**
 * The person's own activity, computed from groups already on the device —
 * no server call. "Added by you" means you paid; that's the authorship the
 * expense record carries.
 */
export const computeLocalActivity = (
  groups: Pick<Group, 'expenses' | 'settlements' | 'hidden' | 'updatedAt'>[],
  userId: string,
  nowMs = Date.now(),
): LocalActivity => {
  const now = new Date(nowMs);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  let expensesThisMonth = 0;
  let expensesLastMonth = 0;
  let settlementsThisMonth = 0;
  let activeGroups = 0;
  for (const group of groups) {
    if (group.hidden) continue;
    let active = false;
    for (const expense of group.expenses ?? []) {
      if (expense.paidBy !== userId) continue;
      if (expense.createdAt >= monthStart) {
        expensesThisMonth += 1;
        active = true;
      } else if (expense.createdAt >= lastMonthStart) {
        expensesLastMonth += 1;
      }
    }
    for (const settlement of group.settlements ?? []) {
      if (settlement.createdAt < monthStart) continue;
      if (settlement.fromUserId === userId || settlement.toUserId === userId) {
        settlementsThisMonth += 1;
        active = true;
      }
    }
    if (active) activeGroups += 1;
  }
  return { expensesThisMonth, expensesLastMonth, settlementsThisMonth, activeGroups };
};
