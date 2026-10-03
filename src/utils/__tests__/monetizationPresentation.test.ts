import { describe, expect, it } from 'vitest';
import type { MonetizationCatalog } from '@/models/monetization';
import {
  buildPrimaryPlanPresentations,
  describeAdvancedSplitAccess,
  describeFreeAdvancedSplitAccess,
  describeQuota,
} from '../monetizationPresentation';

const catalog = {
  plans: {
    free: { label: 'Free' },
    essential: { label: 'Essential' },
    plus: { label: 'Plus' },
    pro: { label: 'Pro' },
    power: { label: 'Power' },
    max: { label: 'Max' },
  },
  features: {
    'advanced_split.completion': {
      freePreview: { kind: 'per_variant_lifetime', count: 1 },
      quotaByPlan: {
        free: { kind: 'metered', limit: 3, cadence: 'week' },
        plus: { kind: 'metered', limit: 75, cadence: 'month' },
        pro: { kind: 'metered', limit: 250, cadence: 'month' },
        max: { kind: 'unlimited_local' },
      },
    },
    'insights.advanced_report': {
      quotaByPlan: {
        plus: { kind: 'metered', limit: 75, cadence: 'month' },
        pro: { kind: 'metered', limit: 250, cadence: 'month' },
        max: { kind: 'unlimited_local' },
      },
    },
    'provider.ai_or_ocr_job': {
      quotaByPlan: {
        plus: { kind: 'metered', limit: 20, cadence: 'month' },
        pro: { kind: 'metered', limit: 75, cadence: 'month' },
        max: { kind: 'measure_only', cadence: 'month' },
      },
    },
  },
  capacities: {
    premiumSavedLooks: { plus: 10, pro: 25, max: null },
  },
} as unknown as MonetizationCatalog;

describe('monetization plan presentation', () => {
  it('keeps the initial paywall focused on three distinct plans', () => {
    const plans = buildPrimaryPlanPresentations(catalog);
    expect(plans.map((plan) => plan.id)).toEqual(['plus', 'pro', 'max']);
    expect(plans.find((plan) => plan.recommended)?.id).toBe('pro');
  });

  it('advertises only the advanced-split entitlement that is enforced at launch', () => {
    const max = buildPrimaryPlanPresentations(catalog).find((plan) => plan.id === 'max');
    expect(max?.advancedSplits).toBe('Unlimited local use');
    expect(Object.keys(max ?? {}).sort()).toEqual([
      'advancedSplits',
      'id',
      'label',
      'recommended',
    ]);
  });

  it('does not flatten per-mode previews into the shared free pool', () => {
    expect(describeFreeAdvancedSplitAccess(catalog))
      .toBe('First completion in each eligible mode, then 3/week');
  });

  it('shows the active paid plan allowance instead of free preview copy', () => {
    expect(describeAdvancedSplitAccess(catalog, 'pro')).toBe('250/month');
    expect(describeAdvancedSplitAccess(catalog, 'max')).toBe('Unlimited local use');
  });

  it('formats each cadence without inventing daily mega-limits', () => {
    expect(describeQuota({ kind: 'metered', limit: 3, cadence: 'day' })).toBe('3/day');
    expect(describeQuota({ kind: 'metered', limit: 20, cadence: 'month' })).toBe('20/month');
  });
});
