import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonetizationSnapshot, VerifyAppleTransactionResult } from '@/models/monetization';
import {
  APPLE_MONETIZATION_PRODUCT_IDS,
  applyVerifiedAppleResult,
  appleOwnedTransactionErrorMessage,
  applePurchaseEnvironment,
  applePurchaseErrorMessage,
  appleVerificationMatchesPurchase,
  buildAppleTransactionVerificationInput,
  loadAppleStoreInventory,
  normalizeAppleCommerceEnvironment,
  resolveAppleCommerceConfiguration,
} from '../monetizationPurchaseService';

const iapMocks = vi.hoisted(() => ({
  fetchProducts: vi.fn(),
  getStorefront: vi.fn(async () => 'US'),
}));

vi.mock('expo-iap', () => ({
  fetchProducts: iapMocks.fetchProducts,
  getStorefront: iapMocks.getStorefront,
}));

const appAccountToken = '123e4567-e89b-42d3-a456-426614174000';

const snapshot = (): MonetizationSnapshot => ({
  schemaVersion: 1,
  serverTime: 1,
  catalog: {
    status: 'active',
    enforcementMode: 'enforced',
    pricing: { checkoutDisplayAllowed: true },
    exclusions: { purchasedCreditChargingEnabled: true },
  } as MonetizationSnapshot['catalog'],
  account: {
    environment: 'sandbox',
    planId: 'free',
    planSource: 'default_free',
    creditBalance: 0,
    appAccountToken,
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
    products: JSON.parse(JSON.stringify(APPLE_MONETIZATION_PRODUCT_IDS)),
  },
  capabilities: {
    appleVerification: true,
    creditPurchases: true,
    creditSpending: true,
    offlineLeases: false,
    friendGifting: false,
  },
  enforcement: { commercial: 'server_enforced', blocksFeatures: true },
});

const purchase = (overrides: Record<string, unknown> = {}) => ({
  id: 'transaction-1',
  ids: null,
  isAutoRenewing: true,
  productId: APPLE_MONETIZATION_PRODUCT_IDS.subscriptions.pro.monthly,
  purchaseState: 'purchased',
  purchaseToken: 'eyJhbGciOiJFUzI1NiJ9.eyJ0cmFuc2FjdGlvbklkIjoiMSJ9.c2lnbmF0dXJl',
  quantity: 1,
  store: 'apple',
  transactionDate: 1,
  transactionId: 'transaction-1',
  appAccountToken,
  ...overrides,
} as any);

afterEach(() => {
  iapMocks.fetchProducts.mockReset();
  iapMocks.getStorefront.mockReset();
  iapMocks.getStorefront.mockResolvedValue('US');
});

describe('Apple monetization purchase contract', () => {
  it('enables checkout only for the complete immutable product map', () => {
    const configuration = resolveAppleCommerceConfiguration(snapshot());
    expect(configuration?.subscriptions).toHaveLength(10);
    expect(configuration?.creditPacks).toHaveLength(4);

    const changed = snapshot();
    changed.commerce!.products.subscriptions.pro.monthly = 'wrong.product';
    expect(resolveAppleCommerceConfiguration(changed)).toBeNull();
  });

  it('keeps available credit packs when the subscription catalog fetch fails', async () => {
    const configuration = resolveAppleCommerceConfiguration(snapshot());
    expect(configuration).not.toBeNull();
    const creditProductId = APPLE_MONETIZATION_PRODUCT_IDS.creditPacks[0].productId;
    iapMocks.fetchProducts.mockImplementation(async ({ type }: { type: string }) => {
      if (type === 'subs') throw new Error('subscription catalog unavailable');
      return [{
        id: creditProductId,
        platform: 'ios',
        type: 'in-app',
        displayPrice: '$1.99',
      }];
    });

    const inventory = await loadAppleStoreInventory(configuration!);

    expect(inventory.subscriptions).toEqual([]);
    expect(inventory.creditPacks).toHaveLength(1);
    expect(inventory.missingProductIds).not.toContain(creditProductId);
    expect(inventory.missingProductIds).toContain(
      APPLE_MONETIZATION_PRODUCT_IDS.subscriptions.pro.monthly,
    );
  });

  it('still fails inventory loading when every product category fails', async () => {
    const configuration = resolveAppleCommerceConfiguration(snapshot());
    iapMocks.fetchProducts.mockRejectedValue(new Error('store unavailable'));

    await expect(loadAppleStoreInventory(configuration!)).rejects.toThrow('store unavailable');
  });

  it('binds a StoreKit JWS to the server account token and known product', () => {
    const configuration = resolveAppleCommerceConfiguration(snapshot())!;
    const verification = buildAppleTransactionVerificationInput(purchase(), configuration);
    expect(verification).toEqual(expect.objectContaining({
      input: {
        productId: APPLE_MONETIZATION_PRODUCT_IDS.subscriptions.pro.monthly,
        transactionId: 'transaction-1',
        signedTransactionInfo: expect.stringContaining('.'),
        appAccountToken,
      },
      descriptor: expect.objectContaining({ kind: 'subscription', planId: 'pro' }),
    }));
  });

  it('refuses transaction-id fallbacks and another account token', () => {
    const configuration = resolveAppleCommerceConfiguration(snapshot())!;
    expect(buildAppleTransactionVerificationInput(
      purchase({ purchaseToken: 'transaction-1' }),
      configuration,
    )).toBeNull();
    expect(buildAppleTransactionVerificationInput(
      purchase({ appAccountToken: '123e4567-e89b-42d3-a456-426614174001' }),
      configuration,
    )).toBeNull();
  });

  it('finishes only an exact server-verified result', () => {
    const configuration = resolveAppleCommerceConfiguration(snapshot())!;
    const verification = buildAppleTransactionVerificationInput(purchase(), configuration)!;
    const result: VerifyAppleTransactionResult = {
      verified: true,
      accepted: true,
      duplicate: false,
      finishTransaction: true,
      environment: 'sandbox',
      productId: verification.input.productId,
      transactionId: verification.input.transactionId,
      originalTransactionId: 'original-1',
      purchaseKind: 'subscription',
      planId: 'pro',
      purchasedPlanId: 'pro',
      validUntil: Date.now() + 60_000,
      activeSubscriptionProductId: APPLE_MONETIZATION_PRODUCT_IDS.subscriptions.pro.monthly,
      creditsGranted: 0,
      creditBalance: 25,
      creditDebt: 0,
      serverTime: Date.now(),
    };
    expect(appleVerificationMatchesPurchase({
      result,
      input: verification.input,
      descriptor: verification.descriptor,
      environment: 'sandbox',
    })).toBe(true);
    expect(appleVerificationMatchesPurchase({
      result: { ...result, environment: 'production' },
      input: verification.input,
      descriptor: verification.descriptor,
      environment: 'sandbox',
    })).toBe(false);

    expect(appleVerificationMatchesPurchase({
      result: { ...result, planId: 'max' },
      input: verification.input,
      descriptor: verification.descriptor,
      environment: 'sandbox',
    })).toBe(true);
    expect(appleVerificationMatchesPurchase({
      result: { ...result, purchasedPlanId: 'essential' },
      input: verification.input,
      descriptor: verification.descriptor,
      environment: 'sandbox',
    })).toBe(false);
    const applied = applyVerifiedAppleResult(snapshot(), result);
    expect(applied.account.validUntil).toBe(result.validUntil);
    expect(applied.account.activeSubscriptionProductId).toBe(
      APPLE_MONETIZATION_PRODUCT_IDS.subscriptions.pro.monthly,
    );
    expect(applied.account.creditDebt).toBe(0);
  });

  it('finishes an already-recorded consumable without granting its credits twice', () => {
    const configuration = resolveAppleCommerceConfiguration(snapshot())!;
    const creditProduct = APPLE_MONETIZATION_PRODUCT_IDS.creditPacks[0];
    const verification = buildAppleTransactionVerificationInput(purchase({
      productId: creditProduct.productId,
      isAutoRenewing: false,
    }), configuration)!;
    const duplicate: VerifyAppleTransactionResult = {
      verified: true,
      accepted: true,
      duplicate: true,
      finishTransaction: true,
      environment: 'sandbox',
      productId: creditProduct.productId,
      transactionId: verification.input.transactionId,
      originalTransactionId: verification.input.transactionId,
      purchaseKind: 'consumable_credits',
      planId: null,
      purchasedPlanId: null,
      validUntil: null,
      creditsGranted: 0,
      creditBalance: creditProduct.credits,
      creditDebt: 0,
      serverTime: Date.now(),
    };

    expect(appleVerificationMatchesPurchase({
      result: duplicate,
      input: verification.input,
      descriptor: verification.descriptor,
      environment: 'sandbox',
    })).toBe(true);
    expect(appleVerificationMatchesPurchase({
      result: { ...duplicate, duplicate: false },
      input: verification.input,
      descriptor: verification.descriptor,
      environment: 'sandbox',
    })).toBe(false);
  });

  it('turns provider and verification failures into safe recovery guidance', () => {
    expect(applePurchaseErrorMessage({
      code: 'network-error',
      message: 'NSURLErrorDomain -1009 internal details',
    })).toBe('The App Store could not be reached. Check your connection, then try again.');
    expect(applePurchaseErrorMessage({
      code: 'functions/failed-precondition',
      message: 'invalid_environment account digest 123',
    })).toContain('Do not buy it again');
    expect(applePurchaseErrorMessage(new Error('private provider response')))
      .toBe('The purchase could not be completed. Please try again.');
    expect(applePurchaseErrorMessage({ code: 'sync-error', message: 'private native error' }))
      .toContain('try Restore Purchases again');
    expect(applePurchaseErrorMessage({ code: 'billing-unavailable' }))
      .toContain('Screen Time');
    expect(applePurchaseErrorMessage({ code: 'functions/permission-denied' }))
      .toContain('different ManaSplit account');
    expect(applePurchaseErrorMessage({ code: 'functions/invalid-argument' }))
      .toContain('Update the app');
    expect(applePurchaseErrorMessage({ code: 'functions/unauthenticated' }))
      .toContain('Sign in again');
    expect(applePurchaseErrorMessage({
      code: 'functions/failed-precondition',
      details: { reasonCode: 'APPLE_INVALID_ENVIRONMENT' },
    })).toContain('Sandbox testing');
  });

  it('never tells someone to buy again after Apple returned a transaction', () => {
    expect(appleOwnedTransactionErrorMessage({ code: 'functions/internal' }))
      .toContain('Do not buy it again');
    expect(appleOwnedTransactionErrorMessage({ code: 'network-error' }))
      .toContain('use Restore Purchases');
    expect(appleOwnedTransactionErrorMessage({ code: 'functions/unauthenticated' }))
      .toContain('Sign in again');
    expect(appleOwnedTransactionErrorMessage({
      code: 'functions/failed-precondition',
      details: { reasonCode: 'APPLE_INVALID_ENVIRONMENT' },
    })).toContain('Sandbox testing');
  });

  it('normalizes StoreKit transaction environments without guessing unknown values', () => {
    expect(applePurchaseEnvironment(purchase({ environmentIOS: 'Sandbox' }))).toBe('sandbox');
    expect(applePurchaseEnvironment(purchase({ environmentIOS: 'Production' }))).toBe('production');
    expect(applePurchaseEnvironment(purchase({ environmentIOS: 'Xcode' }))).toBeNull();
    expect(normalizeAppleCommerceEnvironment('Sandbox')).toBe('sandbox');
    expect(normalizeAppleCommerceEnvironment('Production')).toBe('production');
    expect(normalizeAppleCommerceEnvironment('Xcode')).toBeNull();
  });
});
