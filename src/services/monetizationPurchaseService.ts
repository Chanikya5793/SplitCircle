import type {
  Product,
  ProductSubscription,
  Purchase,
  ExpoPurchaseError,
} from 'expo-iap';
import type {
  MonetizationBillingPeriod,
  MonetizationPlanId,
  MonetizationSnapshot,
  PaidMonetizationPlanId,
  VerifyAppleTransactionInput,
  VerifyAppleTransactionResult,
} from '@/models/monetization';
import { PAID_MONETIZATION_PLAN_IDS } from '@/models/monetization';

export const APPLE_MONETIZATION_PRODUCT_IDS = {
  subscriptions: {
    essential: {
      monthly: 'com.splitcircle.app.subscription.essential.monthly.v1',
      annual: 'com.splitcircle.app.subscription.essential.annual.v1',
    },
    plus: {
      monthly: 'com.splitcircle.app.subscription.plus.monthly.v1',
      annual: 'com.splitcircle.app.subscription.plus.annual.v1',
    },
    pro: {
      monthly: 'com.splitcircle.app.subscription.pro.monthly.v1',
      annual: 'com.splitcircle.app.subscription.pro.annual.v1',
    },
    power: {
      monthly: 'com.splitcircle.app.subscription.power.monthly.v1',
      annual: 'com.splitcircle.app.subscription.power.annual.v1',
    },
    max: {
      monthly: 'com.splitcircle.app.subscription.max.monthly.v1',
      annual: 'com.splitcircle.app.subscription.max.annual.v1',
    },
  },
  creditPacks: [
    { productId: 'com.splitcircle.app.credits.25.v1', credits: 25 },
    { productId: 'com.splitcircle.app.credits.80.v1', credits: 80 },
    { productId: 'com.splitcircle.app.credits.200.v1', credits: 200 },
    { productId: 'com.splitcircle.app.credits.500.v1', credits: 500 },
  ],
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface AppleSubscriptionPurchaseDescriptor {
  kind: 'subscription';
  productId: string;
  planId: PaidMonetizationPlanId;
  billingPeriod: MonetizationBillingPeriod;
}

export interface AppleCreditPurchaseDescriptor {
  kind: 'consumable_credits';
  productId: string;
  credits: number;
}

export type ApplePurchaseDescriptor =
  | AppleSubscriptionPurchaseDescriptor
  | AppleCreditPurchaseDescriptor;

export interface AppleCommerceConfiguration {
  appAccountToken: string;
  subscriptions: AppleSubscriptionPurchaseDescriptor[];
  creditPacks: AppleCreditPurchaseDescriptor[];
}

export interface AppleStoreInventory {
  subscriptions: ProductSubscription[];
  creditPacks: Product[];
  missingProductIds: string[];
  storefrontCountryCode: string | null;
}

const normalizeUuid = (value: string): string => value.trim().toLowerCase();

/**
 * Resolves a server-authorized storefront only when its complete product map
 * exactly matches the immutable IDs compiled into this app version.
 */
export const resolveAppleCommerceConfiguration = (
  snapshot: MonetizationSnapshot | null,
): AppleCommerceConfiguration | null => {
  if (!snapshot
    || snapshot.capabilities.appleVerification !== true
    || snapshot.capabilities.creditPurchases !== true
    || snapshot.capabilities.creditSpending !== true
    || snapshot.enforcement.commercial !== 'server_enforced'
    || snapshot.enforcement.blocksFeatures !== true
    || snapshot.catalog.status !== 'active'
    || snapshot.catalog.enforcementMode !== 'enforced'
    || snapshot.catalog.pricing.checkoutDisplayAllowed !== true
    || snapshot.catalog.exclusions.purchasedCreditChargingEnabled !== true
    || snapshot.commerce?.enabled !== true
    || snapshot.commerce.platform !== 'ios'
    || snapshot.commerce.verificationCallable !== 'verifyAppleTransaction'
    || typeof snapshot.account.appAccountToken !== 'string'
    || !UUID_PATTERN.test(snapshot.account.appAccountToken.trim())) {
    return null;
  }

  const subscriptions: AppleSubscriptionPurchaseDescriptor[] = [];
  for (const planId of PAID_MONETIZATION_PLAN_IDS) {
    const actual = snapshot.commerce.products.subscriptions[planId];
    const expected = APPLE_MONETIZATION_PRODUCT_IDS.subscriptions[planId];
    if (actual?.monthly !== expected.monthly || actual?.annual !== expected.annual) {
      return null;
    }
    subscriptions.push(
      { kind: 'subscription', productId: actual.monthly, planId, billingPeriod: 'monthly' },
      { kind: 'subscription', productId: actual.annual, planId, billingPeriod: 'annual' },
    );
  }

  const expectedCredits = new Map<string, number>(
    APPLE_MONETIZATION_PRODUCT_IDS.creditPacks.map((pack) => [pack.productId, pack.credits]),
  );
  const seenCreditProducts = new Set<string>();
  const creditPacks: AppleCreditPurchaseDescriptor[] = [];
  for (const pack of snapshot.commerce.products.creditPacks) {
    if (expectedCredits.get(pack.productId) !== pack.credits || seenCreditProducts.has(pack.productId)) {
      return null;
    }
    seenCreditProducts.add(pack.productId);
    creditPacks.push({ kind: 'consumable_credits', ...pack });
  }
  if (seenCreditProducts.size !== expectedCredits.size) return null;

  const allIds = [...subscriptions.map((product) => product.productId), ...seenCreditProducts];
  if (new Set(allIds).size !== allIds.length) return null;

  return {
    appAccountToken: normalizeUuid(snapshot.account.appAccountToken),
    subscriptions,
    creditPacks,
  };
};

export const findApplePurchaseDescriptor = (
  configuration: AppleCommerceConfiguration,
  productId: string,
): ApplePurchaseDescriptor | null => configuration.subscriptions.find(
  (product) => product.productId === productId,
) ?? configuration.creditPacks.find((product) => product.productId === productId) ?? null;

export const buildAppleTransactionVerificationInput = (
  purchase: Purchase,
  configuration: AppleCommerceConfiguration,
): { input: VerifyAppleTransactionInput; descriptor: ApplePurchaseDescriptor } | null => {
  const descriptor = findApplePurchaseDescriptor(configuration, purchase.productId);
  if (!descriptor
    || purchase.store !== 'apple'
    || purchase.purchaseState !== 'purchased'
    || purchase.quantity !== 1
    || typeof purchase.transactionId !== 'string'
    || purchase.transactionId.trim().length === 0
    || typeof purchase.purchaseToken !== 'string'
    || purchase.purchaseToken.length > 100_000
    || !COMPACT_JWS_PATTERN.test(purchase.purchaseToken)) {
    return null;
  }

  if ('appAccountToken' in purchase
    && typeof purchase.appAccountToken === 'string'
    && normalizeUuid(purchase.appAccountToken) !== configuration.appAccountToken) {
    return null;
  }

  return {
    input: {
      productId: purchase.productId,
      transactionId: purchase.transactionId.trim(),
      signedTransactionInfo: purchase.purchaseToken,
      appAccountToken: configuration.appAccountToken,
    },
    descriptor,
  };
};

export const appleVerificationMatchesPurchase = ({
  result,
  input,
  descriptor,
  environment,
}: {
  result: VerifyAppleTransactionResult;
  input: VerifyAppleTransactionInput;
  descriptor: ApplePurchaseDescriptor;
  environment: MonetizationSnapshot['account']['environment'];
}): boolean => {
  if (result.verified !== true
    || result.accepted !== true
    || result.finishTransaction !== true
    || result.environment !== environment
    || result.productId !== input.productId
    || result.transactionId !== input.transactionId
    || result.purchaseKind !== descriptor.kind) {
    return false;
  }
  if (descriptor.kind === 'subscription') {
    return result.purchasedPlanId === descriptor.planId
      && result.planId !== null
      && typeof result.validUntil === 'number'
      && Number.isFinite(result.validUntil)
      && result.creditsGranted === 0;
  }
  // A consumable can return again when the server recorded it but StoreKit
  // finishing previously failed. The verifier reports that replay as an
  // accepted duplicate with zero newly granted credits so the client can
  // safely finish the already-credited transaction without granting twice.
  return result.duplicate
    ? result.purchasedPlanId === null && result.creditsGranted === 0
    : result.purchasedPlanId === null && result.creditsGranted === descriptor.credits;
};

export const applyVerifiedAppleResult = (
  snapshot: MonetizationSnapshot,
  result: VerifyAppleTransactionResult,
): MonetizationSnapshot => ({
  ...snapshot,
  serverTime: result.serverTime,
  account: {
    ...snapshot.account,
    planId: result.purchaseKind === 'subscription' && result.planId
      ? result.planId
      : snapshot.account.planId,
    planSource: result.purchaseKind === 'subscription' ? 'server_projection' : snapshot.account.planSource,
    validUntil: result.purchaseKind === 'subscription' ? result.validUntil : snapshot.account.validUntil,
    activeSubscriptionProductId: result.purchaseKind === 'subscription'
      ? result.activeSubscriptionProductId ?? snapshot.account.activeSubscriptionProductId
      : snapshot.account.activeSubscriptionProductId,
    creditBalance: result.creditBalance,
    creditDebt: result.creditDebt ?? snapshot.account.creditDebt,
  },
});

export const inventoryContainsProduct = (
  inventory: AppleStoreInventory,
  descriptor: ApplePurchaseDescriptor,
): boolean => descriptor.kind === 'subscription'
  ? inventory.subscriptions.some((product) => product.id === descriptor.productId)
  : inventory.creditPacks.some((product) => product.id === descriptor.productId);

export const storeDisplayPrice = (
  inventory: AppleStoreInventory,
  descriptor: ApplePurchaseDescriptor,
): string | null => {
  const products = descriptor.kind === 'subscription'
    ? inventory.subscriptions
    : inventory.creditPacks;
  const product = products.find((candidate) => candidate.id === descriptor.productId);
  return product && typeof product.displayPrice === 'string' && product.displayPrice.trim()
    ? product.displayPrice
    : null;
};

export const loadAppleStoreInventory = async (
  configuration: AppleCommerceConfiguration,
): Promise<AppleStoreInventory> => {
  const { fetchProducts, getStorefront } = await import('expo-iap');
  const [subscriptionResult, creditResult, storefrontResult] = await Promise.allSettled([
    fetchProducts({
      skus: configuration.subscriptions.map((product) => product.productId),
      type: 'subs',
    }),
    fetchProducts({
      skus: configuration.creditPacks.map((product) => product.productId),
      type: 'in-app',
    }),
    getStorefront(),
  ]);
  if (subscriptionResult.status === 'rejected' && creditResult.status === 'rejected') {
    throw subscriptionResult.reason;
  }
  const subscriptionProducts = subscriptionResult.status === 'fulfilled'
    ? subscriptionResult.value
    : [];
  const creditProducts = creditResult.status === 'fulfilled' ? creditResult.value : [];
  const storefrontCountryCode = storefrontResult.status === 'fulfilled'
    ? storefrontResult.value.trim().toUpperCase()
    : null;
  const subscriptionIds = new Set(configuration.subscriptions.map((product) => product.productId));
  const creditIds = new Set(configuration.creditPacks.map((product) => product.productId));
  const subscriptions = (subscriptionProducts ?? []).filter(
    (product): product is ProductSubscription => product.platform === 'ios'
      && product.type === 'subs'
      && subscriptionIds.has(product.id)
      && typeof product.displayPrice === 'string'
      && product.displayPrice.trim().length > 0,
  );
  const creditPacks = (creditProducts ?? []).filter(
    (product): product is Product => product.platform === 'ios'
      && product.type === 'in-app'
      && creditIds.has(product.id)
      && typeof product.displayPrice === 'string'
      && product.displayPrice.trim().length > 0,
  );
  const fetched = new Set([
    ...subscriptions.map((product) => product.id),
    ...creditPacks.map((product) => product.id),
  ]);
  return {
    subscriptions,
    creditPacks,
    missingProductIds: [
      ...configuration.subscriptions.map((product) => product.productId),
      ...configuration.creditPacks.map((product) => product.productId),
    ].filter((productId) => !fetched.has(productId)),
    storefrontCountryCode: storefrontCountryCode || null,
  };
};

export const restoreApplePurchases = async (): Promise<Purchase[]> => {
  const { getAvailablePurchases, restorePurchases } = await import('expo-iap');
  await restorePurchases();
  return getAvailablePurchases({
    alsoPublishToEventListenerIOS: false,
    onlyIncludeActiveItemsIOS: true,
  });
};

export const finishVerifiedApplePurchase = async (
  purchase: Purchase,
  descriptor: ApplePurchaseDescriptor,
): Promise<void> => {
  const { finishTransaction } = await import('expo-iap');
  await finishTransaction({
    purchase,
    isConsumable: descriptor.kind === 'consumable_credits',
  });
};

export const openAppleSubscriptionManagement = async (): Promise<void> => {
  const { deepLinkToSubscriptions } = await import('expo-iap');
  await deepLinkToSubscriptions();
};

const purchaseErrorCode = (error: unknown): string => {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') {
    return '';
  }
  return error.code.trim().toLowerCase().replace(/^(functions|auth)\//, '');
};

const purchaseErrorReasonCode = (error: unknown): string => {
  if (!error || typeof error !== 'object' || !('details' in error)) return '';
  const details = error.details;
  if (!details || typeof details !== 'object' || !('reasonCode' in details)) return '';
  return typeof details.reasonCode === 'string' ? details.reasonCode.trim().toUpperCase() : '';
};

export const applePurchaseEnvironment = (
  purchase: Purchase,
): MonetizationSnapshot['account']['environment'] | null => {
  if (!('environmentIOS' in purchase) || typeof purchase.environmentIOS !== 'string') return null;
  return normalizeAppleCommerceEnvironment(purchase.environmentIOS);
};

export const normalizeAppleCommerceEnvironment = (
  value: unknown,
): MonetizationSnapshot['account']['environment'] | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'sandbox') return 'sandbox';
  if (normalized === 'production') return 'production';
  return null;
};

export const isApplePurchaseCancellation = (error: unknown): boolean =>
  purchaseErrorCode(error) === 'user-cancelled';

export const isApplePurchasePending = (error: unknown): boolean => {
  const code = purchaseErrorCode(error);
  return code === 'pending' || code === 'deferred-payment';
};

export const applePurchaseErrorMessage = (error: unknown): string => {
  const code = purchaseErrorCode(error);
  const reasonCode = purchaseErrorReasonCode(error);
  if (code === 'network-error'
    || code === 'network-request-failed'
    || code === 'remote-error'
    || code === 'service-timeout'
    || code === 'service-error'
    || code === 'service-disconnected'
    || code === 'connection-closed'
    || code === 'init-connection'
    || code === 'interrupted') {
    return 'The App Store could not be reached. Check your connection, then try again.';
  }
  if (code === 'billing-unavailable'
    || code === 'iap-not-available'
    || code === 'feature-not-supported') {
    return 'Purchases are unavailable on this device or Apple Account. Check App Store sign-in and Screen Time purchase restrictions.';
  }
  if (code === 'sync-error') {
    return 'Apple could not finish restoring purchases. Check App Store sign-in and your connection, then try Restore Purchases again.';
  }
  if (code === 'unauthenticated'
    || code === 'not-authenticated'
    || code === 'user-token-expired'
    || code === 'user-disabled') {
    return 'Your ManaSplit sign-in needs to be refreshed before purchases can continue. Sign in again, then retry.';
  }
  if (code === 'permission-denied') {
    return 'This purchase is linked to a different ManaSplit account. Sign in to the account used for the purchase, then use Restore Purchases.';
  }
  if (code === 'invalid-argument') {
    return 'This purchase could not be matched by this version of ManaSplit. Update the app, then use Restore Purchases.';
  }
  if (code === 'item-unavailable' || code === 'sku-not-found' || code === 'query-product') {
    return 'This product is not available for the current App Store account or region.';
  }
  if (code === 'already-owned' || code === 'duplicate-purchase') {
    return 'This subscription may already belong to your App Store account. Use Restore Purchases instead of buying it again.';
  }
  if (code === 'failed-precondition'
    || code === 'purchase-verification-failed'
    || code === 'purchase-verification-finish-failed'
    || code === 'transaction-validation-failed'
    || code === 'secure-verification-mismatch') {
    if (reasonCode === 'APPLE_INVALID_ENVIRONMENT') {
      return 'This purchase came from Apple’s test environment, but this ManaSplit account is set to Live App Store. Do not buy it again. Open Purchase details, refresh account access, and confirm it says Sandbox testing before restoring.';
    }
    return 'Apple returned a purchase, but ManaSplit could not verify it for this account. Do not buy it again. Refresh, then use Restore Purchases.';
  }
  if (code === 'native-build-outdated') {
    return 'App Store purchases require the latest ManaSplit build.';
  }
  if (code === 'store-unavailable') {
    return 'The App Store connection is unavailable. Try connecting again.';
  }
  // Provider and callable messages can contain implementation details. Keep
  // those in diagnostics and give the person a stable recovery step here.
  return 'The purchase could not be completed. Please try again.';
};

/**
 * Recovery copy for errors that happen after StoreKit has already returned a
 * purchased transaction. At this point retrying the buy action is unsafe: the
 * transaction should stay unfinished so Restore Purchases can resume server
 * verification or StoreKit finishing without another charge attempt.
 */
export const appleOwnedTransactionErrorMessage = (error: unknown): string => {
  const code = purchaseErrorCode(error);
  const preciseRecoveryCodes = new Set([
    'unauthenticated',
    'not-authenticated',
    'user-token-expired',
    'user-disabled',
    'permission-denied',
    'invalid-argument',
    'failed-precondition',
    'purchase-verification-failed',
    'purchase-verification-finish-failed',
    'transaction-validation-failed',
    'secure-verification-mismatch',
  ]);
  const message = applePurchaseErrorMessage(error);
  if (message.toLowerCase().includes('do not buy it again')) return message;
  if (preciseRecoveryCodes.has(code)) {
    return `${message} Do not buy it again. After resolving this message, use Restore Purchases.`;
  }
  return 'Apple returned a purchase, but ManaSplit could not finish processing it. Do not buy it again. Check your connection, refresh account access, then use Restore Purchases.';
};

export const planForProductId = (
  configuration: AppleCommerceConfiguration,
  productId: string,
): MonetizationPlanId | null => {
  const descriptor = findApplePurchaseDescriptor(configuration, productId);
  return descriptor?.kind === 'subscription' ? descriptor.planId : null;
};
