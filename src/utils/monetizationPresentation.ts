import type {
  MonetizationCatalog,
  MonetizationFeatureDefinition,
  MonetizationPlanId,
  PaidMonetizationPlanId,
  MonetizationQuotaRule,
} from '@/models/monetization';
import { PAID_MONETIZATION_PLAN_IDS } from '@/models/monetization';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * When an allowance comes back, in words a person would use: "in 40 minutes",
 * "in 5 hours", "tomorrow", "on Monday", "on Nov 1".
 */
export const describeResetTime = (resetsAt: number, nowMs = Date.now()): string => {
  const delta = resetsAt - nowMs;
  if (delta <= MINUTE_MS) return 'in a moment';
  if (delta < HOUR_MS) {
    const minutes = Math.round(delta / MINUTE_MS);
    return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  if (delta < 12 * HOUR_MS) {
    const hours = Math.round(delta / HOUR_MS);
    return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const now = new Date(nowMs);
  const reset = new Date(resetsAt);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayOffset = Math.floor((resetsAt - startOfToday) / DAY_MS);
  if (dayOffset <= 0) return `at ${reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (dayOffset === 1) return 'tomorrow';
  if (dayOffset < 7) return `on ${reset.toLocaleDateString([], { weekday: 'long' })}`;
  return `on ${reset.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
};

const CADENCE_WORD: Record<string, string> = { day: 'day', week: 'week', month: 'month' };

/** "3 a day", "75 a month", "Unlimited". Readable in a plan comparison row. */
export const describeAllowance = (quota: MonetizationQuotaRule | undefined): string => {
  if (!quota) return 'Not included';
  if (quota.kind === 'unlimited_local') return 'Unlimited';
  if (quota.kind === 'measure_only') return 'Fair use';
  return `${quota.limit.toLocaleString()} a ${CADENCE_WORD[quota.cadence] ?? 'month'}`;
};

/** Published metered features, in the order the catalog lists them. */
export const catalogFeatures = (catalog: MonetizationCatalog): MonetizationFeatureDefinition[] =>
  Object.values(catalog.features);

export const PRIMARY_PLAN_IDS = ['plus', 'pro', 'max'] as const satisfies readonly MonetizationPlanId[];

export interface PlanPresentation {
  id: PaidMonetizationPlanId;
  label: string;
  recommended: boolean;
  advancedSplits: string;
  /** One row per published metered feature: what this plan includes. */
  allowances: { featureId: string; label: string; value: string }[];
}

const sentenceCadence = (cadence: string): string => {
  if (cadence === 'day') return 'day';
  if (cadence === 'week') return 'week';
  return 'month';
};

export const describeQuota = (quota: MonetizationQuotaRule | undefined): string => {
  if (!quota) return 'Not included';
  if (quota.kind === 'unlimited_local') return 'Unlimited local use';
  if (quota.kind === 'measure_only') return 'High fair-use allowance';
  return `${quota.limit.toLocaleString()}/${sentenceCadence(quota.cadence)}`;
};

const feature = (
  catalog: MonetizationCatalog,
  featureId: string,
): MonetizationFeatureDefinition | undefined => catalog.features[featureId];

const buildPlanPresentation = (
  catalog: MonetizationCatalog,
  id: PaidMonetizationPlanId,
): PlanPresentation => ({
  id,
  label: catalog.plans[id].label,
  recommended: id === 'pro',
  advancedSplits: describeQuota(feature(catalog, 'advanced_split.completion')?.quotaByPlan[id]),
  allowances: catalogFeatures(catalog).map((definition) => ({
    featureId: definition.id,
    label: definition.label,
    value: describeAllowance(definition.quotaByPlan[id]),
  })),
});

export const buildPrimaryPlanPresentations = (
  catalog: MonetizationCatalog,
): PlanPresentation[] => PRIMARY_PLAN_IDS.map((id) => buildPlanPresentation(catalog, id));

export const buildAllPlanPresentations = (
  catalog: MonetizationCatalog,
): PlanPresentation[] => PAID_MONETIZATION_PLAN_IDS.map((id) => buildPlanPresentation(catalog, id));

export const describeFreeAdvancedSplitAccess = (catalog: MonetizationCatalog): string => {
  const advanced = feature(catalog, 'advanced_split.completion');
  const pool = describeQuota(advanced?.quotaByPlan.free);
  return advanced?.freePreview
    ? `First completion in each eligible mode, then ${pool}`
    : pool;
};

export const describeAdvancedSplitAccess = (
  catalog: MonetizationCatalog,
  planId: MonetizationPlanId,
): string => planId === 'free'
  ? describeFreeAdvancedSplitAccess(catalog)
  : describeQuota(feature(catalog, 'advanced_split.completion')?.quotaByPlan[planId]);
