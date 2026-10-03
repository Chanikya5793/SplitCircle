import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MonetizationSnapshot } from '@/models/monetization';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  requestPurchase: vi.fn(),
  endConnection: vi.fn(async () => true),
  initConnectionResults: [] as boolean[],
  availablePurchases: [] as any[],
  refreshIdentityToken: vi.fn(async () => undefined),
  verifyAppleTransaction: vi.fn(),
  finishTransaction: vi.fn(async () => true),
  purchaseUpdatedCallback: null as null | ((purchase: any) => void),
  billingIssueCallback: null as null | ((purchase: any) => void),
  sessionAuthenticated: true,
  userId: 'owner-a',
  snapshotEnvironment: 'sandbox' as 'sandbox' | 'production',
  appTransactionEnvironment: 'Sandbox' as 'Sandbox' | 'Production' | 'Xcode',
}));

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  return { ...actual, Platform: { ...actual.Platform, OS: 'ios' } };
});

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { userId: mocks.userId },
    sessionAuthenticated: mocks.sessionAuthenticated,
  }),
}));

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: vi.fn(() => ({})),
}));

vi.mock('expo-iap', () => ({
  purchaseUpdatedListener: vi.fn((callback: (purchase: any) => void) => {
    mocks.events.push('purchase-listener');
    mocks.purchaseUpdatedCallback = callback;
    return { remove: vi.fn() };
  }),
  purchaseErrorListener: vi.fn(() => {
    mocks.events.push('error-listener');
    return { remove: vi.fn() };
  }),
  subscriptionBillingIssueListener: vi.fn((callback: (purchase: any) => void) => {
    mocks.events.push('billing-issue-listener');
    mocks.billingIssueCallback = callback;
    return { remove: vi.fn() };
  }),
  initConnection: vi.fn(async () => {
    mocks.events.push('init-connection');
    return mocks.initConnectionResults.shift() ?? true;
  }),
  endConnection: mocks.endConnection,
  fetchProducts: vi.fn(async ({ skus, type }: { skus: string[]; type: string }) => skus.map((id) => ({
    id,
    platform: 'ios',
    type,
    displayPrice: '$1.00',
  }))),
  getStorefront: vi.fn(async () => 'US'),
  getAppTransactionIOS: vi.fn(async () => ({
    environment: mocks.appTransactionEnvironment,
  })),
  restorePurchases: vi.fn(async () => undefined),
  getAvailablePurchases: vi.fn(async () => mocks.availablePurchases),
  finishTransaction: mocks.finishTransaction,
  requestPurchase: mocks.requestPurchase,
}));

const productIds = {
  subscriptions: {
    essential: { monthly: 'com.splitcircle.app.subscription.essential.monthly.v1', annual: 'com.splitcircle.app.subscription.essential.annual.v1' },
    plus: { monthly: 'com.splitcircle.app.subscription.plus.monthly.v1', annual: 'com.splitcircle.app.subscription.plus.annual.v1' },
    pro: { monthly: 'com.splitcircle.app.subscription.pro.monthly.v1', annual: 'com.splitcircle.app.subscription.pro.annual.v1' },
    power: { monthly: 'com.splitcircle.app.subscription.power.monthly.v1', annual: 'com.splitcircle.app.subscription.power.annual.v1' },
    max: { monthly: 'com.splitcircle.app.subscription.max.monthly.v1', annual: 'com.splitcircle.app.subscription.max.annual.v1' },
  },
  creditPacks: [
    { productId: 'com.splitcircle.app.credits.25.v1', credits: 25 },
    { productId: 'com.splitcircle.app.credits.80.v1', credits: 80 },
    { productId: 'com.splitcircle.app.credits.200.v1', credits: 200 },
    { productId: 'com.splitcircle.app.credits.500.v1', credits: 500 },
  ],
};

const snapshot = {
  schemaVersion: 1,
  serverTime: 1,
  catalog: {
    status: 'active',
    enforcementMode: 'enforced',
    pricing: { checkoutDisplayAllowed: true },
    exclusions: { purchasedCreditChargingEnabled: true },
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
    products: productIds,
  },
  capabilities: {
    appleVerification: true,
    creditPurchases: true,
    creditSpending: true,
    offlineLeases: false,
    friendGifting: false,
  },
  enforcement: { commercial: 'server_enforced', blocksFeatures: true },
} as MonetizationSnapshot;

vi.mock('@/services/monetizationService', () => ({
  getMonetizationSnapshot: vi.fn(async () => {
    mocks.events.push('get-snapshot');
    return {
      ...snapshot,
      account: { ...snapshot.account, environment: mocks.snapshotEnvironment },
    };
  }),
  refreshMonetizationIdentityToken: mocks.refreshIdentityToken,
  verifyAppleTransaction: mocks.verifyAppleTransaction,
}));

import {
  MonetizationPurchaseProvider,
  useMonetizationPurchases,
} from '../MonetizationPurchaseContext';

const Consumer = () => {
  const {
    storeState,
    feedback,
    purchaseSubscription,
    retryStoreConnection,
    refreshAccountAccess,
    restorePurchases,
  } = useMonetizationPurchases();
  return (
    <>
      <button type="button" onClick={() => void purchaseSubscription('pro', 'monthly')}>
        {storeState}
      </button>
      <button type="button" onClick={() => void retryStoreConnection()}>
        Retry App Store
      </button>
      <button type="button" onClick={() => void refreshAccountAccess()}>
        Refresh account access
      </button>
      <button type="button" onClick={() => void restorePurchases()}>
        Restore Purchases
      </button>
      <span>{feedback?.message ?? ''}</span>
    </>
  );
};

describe('MonetizationPurchaseProvider', () => {
  afterEach(() => {
    cleanup();
    mocks.events.length = 0;
    mocks.requestPurchase.mockReset();
    mocks.endConnection.mockClear();
    mocks.initConnectionResults.length = 0;
    mocks.availablePurchases.length = 0;
    mocks.refreshIdentityToken.mockClear();
    mocks.verifyAppleTransaction.mockReset();
    mocks.finishTransaction.mockClear();
    mocks.purchaseUpdatedCallback = null;
    mocks.billingIssueCallback = null;
    mocks.sessionAuthenticated = true;
    mocks.userId = 'owner-a';
    mocks.snapshotEnvironment = 'sandbox';
    mocks.appTransactionEnvironment = 'Sandbox';
  });

  it('waits for Firebase Auth before connecting StoreKit for a cached profile', async () => {
    mocks.sessionAuthenticated = false;
    const view = render(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );

    expect(screen.getByRole('button', { name: 'not_available' })).toBeTruthy();
    expect(mocks.events).toEqual([]);

    mocks.sessionAuthenticated = true;
    view.rerender(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'ready' })).toBeTruthy());
    expect(mocks.events.slice(0, 5)).toEqual([
      'purchase-listener',
      'error-listener',
      'billing-issue-listener',
      'get-snapshot',
      'init-connection',
    ]);
  });

  it('installs both StoreKit listeners before connecting and binds purchases to the account token', async () => {
    const view = render(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'ready' })).toBeTruthy());
    expect(mocks.events.slice(0, 5)).toEqual([
      'purchase-listener',
      'error-listener',
      'billing-issue-listener',
      'get-snapshot',
      'init-connection',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'ready' }));
    await waitFor(() => expect(mocks.refreshIdentityToken).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.requestPurchase).toHaveBeenCalledWith({
      request: {
        apple: {
          sku: productIds.subscriptions.pro.monthly,
          appAccountToken: snapshot.account.appAccountToken,
          quantity: 1,
          andDangerouslyFinishTransactionAutomatically: false,
        },
      },
      type: 'subs',
    }));

    view.unmount();
    await waitFor(() => expect(mocks.endConnection).toHaveBeenCalledTimes(1));
  });

  it('refreshes Firebase claims before reloading account purchase access', async () => {
    render(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'ready' })).toBeTruthy());
    const snapshotLoadsBeforeRefresh = mocks.events.filter((event) => event === 'get-snapshot').length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh account access' }));

    await waitFor(() => expect(mocks.refreshIdentityToken).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(
      mocks.events.filter((event) => event === 'get-snapshot').length,
    ).toBeGreaterThan(snapshotLoadsBeforeRefresh));
    expect(await screen.findByText(
      'Account access refreshed. Sandbox purchase verification is active.',
    )).toBeTruthy();
  });

  it('reconnects StoreKit after the initial connection fails', async () => {
    mocks.initConnectionResults.push(false, true);
    const view = render(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'error' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Retry App Store' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'ready' })).toBeTruthy());
    expect(mocks.events.filter((event) => event === 'init-connection')).toHaveLength(2);

    view.unmount();
    await waitFor(() => expect(mocks.endConnection).toHaveBeenCalledTimes(1));
  });

  it('reports a synchronous Apple cancellation without calling it a failure', async () => {
    mocks.requestPurchase.mockRejectedValueOnce({ code: 'user-cancelled' });
    render(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'ready' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'ready' }));

    expect(await screen.findByText('Purchase cancelled. Nothing was charged.')).toBeTruthy();
  });

  it('explains how to recover when Apple reports a subscription billing issue', async () => {
    render(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'ready' })).toBeTruthy());
    mocks.billingIssueCallback?.({ productId: productIds.subscriptions.pro.monthly });

    expect(await screen.findByText(/update your payment method to keep access/)).toBeTruthy();
  });

  it('does not replace a failed restore with an up-to-date success message', async () => {
    mocks.availablePurchases.push({
      id: 'unknown-transaction',
      productId: 'unknown.product',
      purchaseState: 'purchased',
      purchaseToken: 'header.payload.signature',
      quantity: 1,
      store: 'apple',
      transactionId: 'unknown-transaction',
    });
    render(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'ready' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Restore Purchases' }));

    await waitFor(() => expect(mocks.refreshIdentityToken).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(
      'The App Store returned a purchase that could not be securely matched to this account.',
    )).toBeTruthy());
    expect(screen.queryByText('Your App Store purchases are already up to date.')).toBeNull();
  });

  it('preserves a sandbox transaction when the account is still set to production', async () => {
    mocks.snapshotEnvironment = 'production';
    mocks.availablePurchases.push({
      id: 'sandbox-transaction',
      productId: productIds.subscriptions.pro.monthly,
      purchaseState: 'purchased',
      purchaseToken: 'header.payload.signature',
      quantity: 1,
      store: 'apple',
      transactionId: 'sandbox-transaction',
      appAccountToken: snapshot.account.appAccountToken,
      environmentIOS: 'Sandbox',
    });
    render(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'ready' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Restore Purchases' }));

    expect(await screen.findByText(/uses Apple’s sandbox/)).toBeTruthy();
    expect(mocks.verifyAppleTransaction).not.toHaveBeenCalled();
    expect(mocks.finishTransaction).not.toHaveBeenCalled();
  });

  it('blocks a TestFlight purchase before Apple opens when account access is live', async () => {
    mocks.snapshotEnvironment = 'production';
    render(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'ready' })).toBeTruthy());
    expect(await screen.findByText(/TestFlight build uses Apple’s sandbox/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ready' }));

    await waitFor(() => expect(mocks.refreshIdentityToken).toHaveBeenCalledTimes(1));
    expect(mocks.requestPurchase).not.toHaveBeenCalled();
  });

  it('does not report a successful refresh while TestFlight access still mismatches', async () => {
    mocks.snapshotEnvironment = 'production';
    render(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'ready' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh account access' }));

    expect(await screen.findByText(/still needs Sandbox testing access/)).toBeTruthy();
    expect(screen.queryByText('Account purchase access refreshed.')).toBeNull();
  });

  it('shares one verification when the listener and restore return the same transaction', async () => {
    const purchase = {
      id: 'known-transaction',
      productId: productIds.subscriptions.pro.monthly,
      purchaseState: 'purchased',
      purchaseToken: 'header.payload.signature',
      quantity: 1,
      store: 'apple',
      transactionId: 'known-transaction',
      appAccountToken: snapshot.account.appAccountToken,
    };
    mocks.availablePurchases.push(purchase);
    const verificationDeferred: { resolve?: (value: unknown) => void } = {};
    mocks.verifyAppleTransaction.mockImplementation(() => new Promise((resolve) => {
      verificationDeferred.resolve = resolve;
    }));
    render(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'ready' })).toBeTruthy());
    mocks.purchaseUpdatedCallback?.(purchase);
    fireEvent.click(screen.getByRole('button', { name: 'Restore Purchases' }));
    await waitFor(() => expect(mocks.verifyAppleTransaction).toHaveBeenCalledTimes(1));

    verificationDeferred.resolve?.({
      verified: true,
      accepted: true,
      duplicate: false,
      finishTransaction: true,
      environment: 'sandbox',
      productId: purchase.productId,
      transactionId: purchase.transactionId,
      originalTransactionId: 'known-original-transaction',
      purchaseKind: 'subscription',
      planId: 'pro',
      purchasedPlanId: 'pro',
      validUntil: Date.now() + 86_400_000,
      creditsGranted: 0,
      creditBalance: 0,
      creditDebt: 0,
      serverTime: Date.now(),
    });

    await waitFor(() => expect(screen.getByText('Purchases restored and access updated.')).toBeTruthy());
    expect(mocks.verifyAppleTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.finishTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not publish purchase feedback from a previous signed-in account', async () => {
    const purchase = {
      id: 'account-switch-transaction',
      productId: productIds.subscriptions.pro.monthly,
      purchaseState: 'purchased',
      purchaseToken: 'header.payload.signature',
      quantity: 1,
      store: 'apple',
      transactionId: 'account-switch-transaction',
      appAccountToken: snapshot.account.appAccountToken,
    };
    const verificationDeferred: { resolve?: (value: unknown) => void } = {};
    mocks.verifyAppleTransaction.mockImplementation(() => new Promise((resolve) => {
      verificationDeferred.resolve = resolve;
    }));
    const view = render(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'ready' })).toBeTruthy());
    mocks.purchaseUpdatedCallback?.(purchase);
    await waitFor(() => expect(mocks.verifyAppleTransaction).toHaveBeenCalledTimes(1));

    mocks.userId = 'owner-b';
    view.rerender(
      <MonetizationPurchaseProvider>
        <Consumer />
      </MonetizationPurchaseProvider>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'ready' })).toBeTruthy());

    verificationDeferred.resolve?.({
      verified: true,
      accepted: true,
      duplicate: false,
      finishTransaction: true,
      environment: 'sandbox',
      productId: purchase.productId,
      transactionId: purchase.transactionId,
      originalTransactionId: 'account-switch-original',
      purchaseKind: 'subscription',
      planId: 'pro',
      purchasedPlanId: 'pro',
      validUntil: Date.now() + 86_400_000,
      creditsGranted: 0,
      creditBalance: 0,
      creditDebt: 0,
      serverTime: Date.now(),
    });

    await waitFor(() => expect(mocks.finishTransaction).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Your plan is active. Included access has been updated.')).toBeNull();
  });
});
