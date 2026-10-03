import { describe, expect, it } from 'vitest';
import { isMonetizationSnapshot } from '@/models/monetization';
import { APPLE_MONETIZATION_PRODUCT_IDS } from '@/services/monetizationPurchaseService';

const planIds = ['free', 'essential', 'plus', 'pro', 'power', 'max'] as const;

describe('active monetization snapshot validation', () => {
  it('accepts the enforced storefront contract returned by production', () => {
    const plans = Object.fromEntries(planIds.map((id) => [id, {
      label: id === 'free' ? 'Free' : `${id[0].toUpperCase()}${id.slice(1)}`,
      storefrontStatus: id === 'free' ? 'not_for_sale' : 'storefront',
    }]));
    const premiumSavedLooks = Object.fromEntries(planIds.map((id) => [id, id === 'max' ? null : 3]));
    const premiumAppearanceCollections = Object.fromEntries(planIds.map((id) => [
      id,
      id === 'max' ? 'all_current_and_future_while_subscribed' : 2,
    ]));

    expect(isMonetizationSnapshot({
      schemaVersion: 1,
      serverTime: Date.now(),
      catalog: {
        schemaVersion: 1,
        version: 'commerce-v1',
        status: 'active',
        enforcementMode: 'enforced',
        plans,
        features: {
          'advanced_split.completion': {
            id: 'advanced_split.completion',
            label: 'Advanced split',
            quotaKey: 'advanced_split.completion',
            costClass: 'deterministic_local',
            allowedExecutionRoutes: ['local_deterministic'],
            quotaByPlan: Object.fromEntries(planIds.map((id) => [id, {
              kind: 'metered', limit: 3, cadence: 'week',
            }])),
            creditCost: 1,
          },
        },
        capacities: { premiumSavedLooks, premiumAppearanceCollections },
        pricing: {
          status: 'storefront',
          currency: 'USD',
          checkoutDisplayAllowed: true,
          localizedStorefrontPriceRequired: true,
          subscriptions: {},
          creditPacks: [],
          permanentUnlockResearchRanges: {},
        },
        exclusions: {
          permanentlyFreeSplitMethods: ['equal'],
          randomizedOrUnclearedSplitMethods: ['roulette'],
          purchasedCreditChargingEnabled: true,
        },
      },
      account: {
        environment: 'sandbox',
        planId: 'free',
        planSource: 'default_free',
        creditBalance: 0,
        appAccountToken: '123e4567-e89b-42d3-a456-426614174000',
        access: {
          kind: 'standard',
          commercialQuotaBypass: false,
          providerSafetyBypass: false,
          grantExpiresAt: null,
          grantId: null,
        },
      },
      commerce: {
        enabled: true,
        platform: 'ios',
        bundleId: 'com.splitcircle.app',
        appAppleId: 6760814898,
        verificationCallable: 'verifyAppleTransaction',
        products: APPLE_MONETIZATION_PRODUCT_IDS,
      },
      capabilities: {
        appleVerification: true,
        creditPurchases: true,
        creditSpending: true,
        offlineLeases: false,
        friendGifting: false,
      },
      enforcement: { commercial: 'server_enforced', blocksFeatures: true },
    })).toBe(true);
  });

  it('rejects a server-enforced contract that claims it does not block features', () => {
    expect(isMonetizationSnapshot({
      schemaVersion: 1,
      serverTime: Date.now(),
      enforcement: { commercial: 'server_enforced', blocksFeatures: false },
    })).toBe(false);
  });
});
