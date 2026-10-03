import type {
  MonetizationCatalog,
  MonetizationFeatureDefinition,
  MonetizationPlanId,
  PaidMonetizationPlanId,
  MonetizationQuotaRule,
} from '@/models/monetization';
import { PAID_MONETIZATION_PLAN_IDS } from '@/models/monetization';

export const PRIMARY_PLAN_IDS = ['plus', 'pro', 'max'] as const satisfies readonly MonetizationPlanId[];

export interface PlanPresentation {
  id: PaidMonetizationPlanId;
  label: string;
  recommended: boolean;
  advancedSplits: string;
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
