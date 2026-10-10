import { describe, expect, it } from 'vitest';
import type { MonetizationCatalog } from '@/models/monetization';
import {
  buildPrimaryPlanPresentations,
  describeAllowance,
  describeResetTime,
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
      id: 'advanced_split.completion',
      label: 'Advanced splits',
      freePreview: { kind: 'per_variant_lifetime', count: 1 },
      quotaByPlan: {
        free: { kind: 'metered', limit: 3, cadence: 'week' },
        plus: { kind: 'metered', limit: 75, cadence: 'month' },
        pro: { kind: 'metered', limit: 250, cadence: 'month' },
        max: { kind: 'unlimited_local' },
      },
    },
    'insights.advanced_report': {
      id: 'insights.advanced_report',
      label: 'AI insight reports',
      quotaByPlan: {
        plus: { kind: 'metered', limit: 75, cadence: 'month' },
        pro: { kind: 'metered', limit: 250, cadence: 'month' },
        max: { kind: 'unlimited_local' },
      },
    },
    'provider.ai_or_ocr_job': {
      id: 'provider.ai_or_ocr_job',
      label: 'Cloud AI jobs',
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

  it('advertises exactly the features the server publishes as enforced', () => {
    const max = buildPrimaryPlanPresentations(catalog).find((plan) => plan.id === 'max');
    expect(max?.advancedSplits).toBe('Unlimited local use');
    // The server only publishes features with a live, enforced call path, so
    // the plan card lists precisely those — never an unpublished hypothesis.
    expect(max?.allowances.map((row) => row.featureId)).toEqual(Object.keys(catalog.features));
    expect(max?.allowances.find((row) => row.featureId === 'advanced_split.completion')?.value)
      .toBe('Unlimited');
    const plus = buildPrimaryPlanPresentations(catalog).find((plan) => plan.id === 'plus');
    expect(plus?.allowances.find((row) => row.featureId === 'insights.advanced_report')?.value)
      .toBe('75 a month');
  });

  it('says when an allowance comes back in plain words', () => {
    const now = new Date(2026, 9, 9, 10, 0).getTime();
    expect(describeResetTime(now + 40 * 60_000, now)).toBe('in 40 minutes');
    expect(describeResetTime(now + 5 * 3_600_000, now)).toBe('in 5 hours');
    expect(describeResetTime(new Date(2026, 9, 10, 0, 0).getTime(), now)).toBe('tomorrow');
    expect(describeResetTime(new Date(2026, 9, 12, 0, 0).getTime(), now)).toMatch(/^on [A-Z][a-z]+day$/);
    expect(describeResetTime(new Date(2026, 10, 1).getTime(), now)).toMatch(/^on Nov 1$/);
  });

  it('reads allowances as a person would say them', () => {
    expect(describeAllowance({ kind: 'metered', limit: 3, cadence: 'day' })).toBe('3 a day');
    expect(describeAllowance({ kind: 'metered', limit: 1_000, cadence: 'month' })).toBe('1,000 a month');
    expect(describeAllowance({ kind: 'unlimited_local' })).toBe('Unlimited');
    expect(describeAllowance(undefined)).toBe('Not included');
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
