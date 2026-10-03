import { useAuth } from '@/context/AuthContext';
import type {
  MonetizationBillingPeriod,
  MonetizationEnvironment,
  MonetizationSnapshot,
  PaidMonetizationPlanId,
} from '@/models/monetization';
import {
  applyVerifiedAppleResult,
  appleOwnedTransactionErrorMessage,
  applePurchaseErrorMessage,
  applePurchaseEnvironment,
  appleVerificationMatchesPurchase,
  buildAppleTransactionVerificationInput,
  findApplePurchaseDescriptor,
  finishVerifiedApplePurchase,
  inventoryContainsProduct,
  isApplePurchaseCancellation,
  isApplePurchasePending,
  loadAppleStoreInventory,
  normalizeAppleCommerceEnvironment,
  openAppleSubscriptionManagement,
  resolveAppleCommerceConfiguration,
  restoreApplePurchases,
  type AppleCommerceConfiguration,
  type AppleStoreInventory,
} from '@/services/monetizationPurchaseService';
import {
  getMonetizationSnapshot,
  refreshMonetizationIdentityToken,
  verifyAppleTransaction,
} from '@/services/monetizationService';
import type { ExpoPurchaseError, Purchase } from 'expo-iap';
import { requireOptionalNativeModule } from 'expo-modules-core';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform } from 'react-native';

export type AppleStoreState = 'not_available' | 'connecting' | 'ready' | 'error';

export interface PurchaseFeedback {
  kind: 'success' | 'pending' | 'error' | 'info';
  message: string;
}

interface MonetizationPurchaseContextValue {
  snapshot: MonetizationSnapshot | null;
  inventory: AppleStoreInventory;
  storeState: AppleStoreState;
  storeEnvironment: MonetizationEnvironment | null;
  loadingAccess: boolean;
  refreshing: boolean;
  restoring: boolean;
  busyProductId: string | null;
  feedback: PurchaseFeedback | null;
  commerceConfiguration: AppleCommerceConfiguration | null;
  refresh: () => Promise<void>;
  refreshAccountAccess: () => Promise<void>;
  retryStoreConnection: () => Promise<void>;
  purchaseSubscription: (
    planId: PaidMonetizationPlanId,
    billingPeriod: MonetizationBillingPeriod,
  ) => Promise<void>;
  purchaseCredits: (productId: string) => Promise<void>;
  restorePurchases: () => Promise<void>;
  manageSubscription: () => Promise<void>;
  clearFeedback: () => void;
}

const EMPTY_INVENTORY: AppleStoreInventory = {
  subscriptions: [],
  creditPacks: [],
  missingProductIds: [],
  storefrontCountryCode: null,
};

const MonetizationPurchaseContext = createContext<MonetizationPurchaseContextValue | undefined>(
  undefined,
);

class PurchaseFlowError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'PurchaseFlowError';
    this.code = code;
  }
}

const successMessage = (result: {
  purchaseKind: 'subscription' | 'consumable_credits';
  creditBalance: number;
  creditDebt?: number;
}): string =>
  result.purchaseKind === 'subscription'
    ? 'Your plan is active. Included access has been updated.'
    : result.creditDebt && result.creditDebt > 0
      ? `Purchase verified. After refund adjustments, your spendable balance is ${result.creditBalance.toLocaleString()} Mana Credits.`
      : `Purchase verified. Your spendable balance is ${result.creditBalance.toLocaleString()} Mana Credits.`;

export const MonetizationPurchaseProvider = ({ children }: React.PropsWithChildren) => {
  const { user, sessionAuthenticated } = useAuth();
  const [snapshot, setSnapshot] = useState<MonetizationSnapshot | null>(null);
  const [inventory, setInventory] = useState<AppleStoreInventory>(EMPTY_INVENTORY);
  const [storeState, setStoreState] = useState<AppleStoreState>('not_available');
  const [storeEnvironment, setStoreEnvironment] = useState<MonetizationEnvironment | null>(null);
  const [loadingAccess, setLoadingAccess] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [busyProductId, setBusyProductId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<PurchaseFeedback | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const snapshotRef = useRef<MonetizationSnapshot | null>(null);
  const snapshotAccountIdRef = useRef<string | null>(null);
  const configurationRef = useRef<AppleCommerceConfiguration | null>(null);
  const storeReadyRef = useRef(false);
  const storeEnvironmentRef = useRef<MonetizationEnvironment | null>(null);
  const mountedRef = useRef(true);
  const processingTransactionsRef = useRef(new Map<string, Promise<boolean>>());
  const activeAccountId = sessionAuthenticated && user ? user.userId : null;
  const activeAccountIdRef = useRef<string | null>(activeAccountId);
  activeAccountIdRef.current = activeAccountId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const adoptSnapshot = useCallback((next: MonetizationSnapshot, accountId: string) => {
    snapshotRef.current = next;
    snapshotAccountIdRef.current = accountId;
    configurationRef.current = resolveAppleCommerceConfiguration(next);
    if (mountedRef.current) setSnapshot(next);
    return next;
  }, []);

  const loadAccess = useCallback(async (
    expectedAccountId: string | null = activeAccountIdRef.current,
  ): Promise<MonetizationSnapshot> => {
    if (!expectedAccountId || activeAccountIdRef.current !== expectedAccountId) {
      throw new PurchaseFlowError('account-session-changed');
    }
    const next = await getMonetizationSnapshot();
    if (activeAccountIdRef.current !== expectedAccountId) {
      throw new PurchaseFlowError('account-session-changed');
    }
    return adoptSnapshot(next, expectedAccountId);
  }, [adoptSnapshot]);

  const loadFreshAccountAccess = useCallback(async (
    expectedAccountId: string | null = activeAccountIdRef.current,
  ): Promise<MonetizationSnapshot> => {
    if (!expectedAccountId || activeAccountIdRef.current !== expectedAccountId) {
      throw new PurchaseFlowError('account-session-changed');
    }
    await refreshMonetizationIdentityToken();
    if (activeAccountIdRef.current !== expectedAccountId) {
      throw new PurchaseFlowError('account-session-changed');
    }
    return loadAccess(expectedAccountId);
  }, [loadAccess]);

  const loadInventory = useCallback(async (nextSnapshot?: MonetizationSnapshot) => {
    const configuration = resolveAppleCommerceConfiguration(nextSnapshot ?? snapshotRef.current);
    configurationRef.current = configuration;
    if (!configuration || !storeReadyRef.current) {
      if (mountedRef.current) setInventory(EMPTY_INVENTORY);
      return;
    }
    const nextInventory = await loadAppleStoreInventory(configuration);
    if (mountedRef.current) setInventory(nextInventory);
  }, []);

  const processPurchase = useCallback(async (purchase: Purchase): Promise<boolean> => {
    const processingAccountId = activeAccountIdRef.current;
    const configuration = configurationRef.current;
    const currentSnapshot = snapshotRef.current;
    const transactionKey = purchase.transactionId ?? purchase.id;
    if (!processingAccountId
      || snapshotAccountIdRef.current !== processingAccountId
      || !configuration
      || !currentSnapshot
      || !transactionKey) {
      if (mountedRef.current && activeAccountIdRef.current === processingAccountId) {
        setBusyProductId(null);
        setFeedback({
          kind: 'error',
          message: 'Your purchase is waiting for a secure account check. Pull to refresh and try Restore Purchases.',
        });
      }
      return false;
    }
    const inFlight = processingTransactionsRef.current.get(transactionKey);
    if (inFlight) return inFlight;

    const transactionEnvironment = applePurchaseEnvironment(purchase);
    if (transactionEnvironment && transactionEnvironment !== currentSnapshot.account.environment) {
      if (mountedRef.current) {
        setBusyProductId(null);
        setFeedback({
          kind: 'error',
          message: transactionEnvironment === 'sandbox'
            ? 'This TestFlight purchase is waiting for sandbox access on your ManaSplit account. Do not buy it again. Open Purchase details, refresh account access, confirm Sandbox testing, then use Restore Purchases.'
            : 'This purchase came from the Live App Store, but this ManaSplit account is set to Sandbox testing. Refresh account access, then use Restore Purchases.',
        });
      }
      return false;
    }

    const verification = buildAppleTransactionVerificationInput(purchase, configuration);
    if (!verification) {
      if (mountedRef.current) {
        setBusyProductId(null);
        setFeedback({
          kind: 'error',
          message: 'The App Store returned a purchase that could not be securely matched to this account.',
        });
      }
      return false;
    }

    const processing = (async (): Promise<boolean> => {
      if (mountedRef.current) setBusyProductId(purchase.productId);
      try {
        if (activeAccountIdRef.current !== processingAccountId) return false;
        const result = await verifyAppleTransaction(verification.input);
        if (!appleVerificationMatchesPurchase({
          result,
          input: verification.input,
          descriptor: verification.descriptor,
          environment: currentSnapshot.account.environment,
        })) {
          throw new PurchaseFlowError('secure-verification-mismatch');
        }

        if (activeAccountIdRef.current === processingAccountId) {
          const updatedSnapshot = applyVerifiedAppleResult(snapshotRef.current ?? currentSnapshot, result);
          adoptSnapshot(updatedSnapshot, processingAccountId);
        }
        await finishVerifiedApplePurchase(purchase, verification.descriptor);
        if (mountedRef.current && activeAccountIdRef.current === processingAccountId) {
          setFeedback({ kind: 'success', message: successMessage(result) });
        }
        // Pull the full server projection after finishing. The optimistic update above
        // keeps the UI responsive if this refresh is briefly unavailable.
        if (activeAccountIdRef.current === processingAccountId) {
          void loadAccess(processingAccountId).catch(() => undefined);
        }
        return true;
      } catch (error) {
        if (mountedRef.current && activeAccountIdRef.current === processingAccountId) {
          setFeedback({ kind: 'error', message: appleOwnedTransactionErrorMessage(error) });
        }
        return false;
      } finally {
        if (mountedRef.current && activeAccountIdRef.current === processingAccountId) {
          setBusyProductId(null);
        }
      }
    })();
    processingTransactionsRef.current.set(transactionKey, processing);
    try {
      return await processing;
    } finally {
      if (processingTransactionsRef.current.get(transactionKey) === processing) {
        processingTransactionsRef.current.delete(transactionKey);
      }
    }
  }, [adoptSnapshot, loadAccess]);

  useEffect(() => {
    if (!user || !sessionAuthenticated) {
      snapshotRef.current = null;
      snapshotAccountIdRef.current = null;
      configurationRef.current = null;
      storeReadyRef.current = false;
      storeEnvironmentRef.current = null;
      processingTransactionsRef.current.clear();
      setSnapshot(null);
      setInventory(EMPTY_INVENTORY);
      setStoreState('not_available');
      setStoreEnvironment(null);
      setBusyProductId(null);
      setFeedback(null);
      return;
    }

    let active = true;
    let purchaseSubscription: { remove: () => void } | null = null;
    let errorSubscription: { remove: () => void } | null = null;
    let billingIssueSubscription: { remove: () => void } | null = null;
    let connected = false;
    let disconnect: (() => Promise<boolean>) | null = null;

    setLoadingAccess(true);
    storeEnvironmentRef.current = null;
    setStoreEnvironment(null);
    setStoreState(Platform.OS === 'ios' ? 'connecting' : 'not_available');
    void (async () => {
      try {
        if (Platform.OS !== 'ios') {
          await loadAccess();
          return;
        }

        // Existing development/simulator binaries may predate the expo-iap
        // native pod. Probe before importing the JS package because Hermes can
        // terminate the process when a package eagerly requires a missing
        // native module.
        if (!requireOptionalNativeModule('ExpoIap')) {
          throw new PurchaseFlowError('native-build-outdated');
        }
        const iap = await import('expo-iap');
        disconnect = iap.endConnection;
        if (!active) return;
        // StoreKit can publish unfinished transactions as soon as the connection
        // opens, so both listeners must exist before initConnection.
        purchaseSubscription = iap.purchaseUpdatedListener((purchase) => {
          void processPurchase(purchase);
        });
        errorSubscription = iap.purchaseErrorListener((error: ExpoPurchaseError) => {
          if (!mountedRef.current) return;
          setBusyProductId(null);
          if (isApplePurchaseCancellation(error)) {
            setFeedback({ kind: 'info', message: 'Purchase cancelled. Nothing was charged.' });
          } else if (isApplePurchasePending(error)) {
            setFeedback({
              kind: 'pending',
              message: 'Apple is still approving this purchase. Access will update when approval finishes.',
            });
          } else {
            setFeedback({ kind: 'error', message: applePurchaseErrorMessage(error) });
          }
        });
        billingIssueSubscription = iap.subscriptionBillingIssueListener(() => {
          if (!mountedRef.current || activeAccountIdRef.current !== user.userId) return;
          setFeedback({
            kind: 'pending',
            message: 'Apple could not renew this subscription. Open Manage subscription and update your payment method to keep access.',
          });
        });

        const nextSnapshot = await loadAccess(user.userId);
        connected = await iap.initConnection();
        if (!active) {
          if (connected) await iap.endConnection();
          return;
        }
        if (!connected) throw new PurchaseFlowError('store-unavailable');
        const appTransaction = await iap.getAppTransactionIOS().catch(() => null);
        if (!active) return;
        const nextStoreEnvironment = normalizeAppleCommerceEnvironment(appTransaction?.environment);
        storeEnvironmentRef.current = nextStoreEnvironment;
        setStoreEnvironment(nextStoreEnvironment);
        storeReadyRef.current = true;
        setStoreState('ready');
        if (nextStoreEnvironment && nextStoreEnvironment !== nextSnapshot.account.environment) {
          setFeedback({
            kind: 'error',
            message: nextStoreEnvironment === 'sandbox'
              ? 'This TestFlight build uses Apple’s sandbox, but this ManaSplit account is set to Live App Store. Refresh account access and confirm Sandbox testing before purchasing or restoring.'
              : 'This App Store build uses live purchases, but this ManaSplit account is set to Sandbox testing. Refresh account access before purchasing or restoring.',
          });
        }
        await loadInventory(nextSnapshot);
      } catch (error) {
        if (!active || !mountedRef.current) return;
        storeReadyRef.current = false;
        setStoreState('error');
        setFeedback({ kind: 'error', message: applePurchaseErrorMessage(error) });
        // Access details are useful even when StoreKit itself is unavailable.
        if (!snapshotRef.current) void loadAccess().catch(() => undefined);
      } finally {
        if (active && mountedRef.current) setLoadingAccess(false);
      }
    })();

    return () => {
      active = false;
      storeReadyRef.current = false;
      storeEnvironmentRef.current = null;
      purchaseSubscription?.remove();
      errorSubscription?.remove();
      billingIssueSubscription?.remove();
      if (connected && disconnect) {
        void disconnect().catch(() => undefined);
      }
    };
  }, [connectionAttempt, loadAccess, loadInventory, processPurchase, sessionAuthenticated, user?.userId]);

  const retryStoreConnection = useCallback(async () => {
    if (!user || !sessionAuthenticated || Platform.OS !== 'ios' || storeState === 'connecting') return;
    setFeedback(null);
    setStoreState('connecting');
    setConnectionAttempt((attempt) => attempt + 1);
  }, [sessionAuthenticated, storeState, user]);

  const refresh = useCallback(async () => {
    if (!user || !sessionAuthenticated) return;
    const refreshingAccountId = user.userId;
    setRefreshing(true);
    try {
      const next = await loadAccess(refreshingAccountId);
      if (activeAccountIdRef.current !== refreshingAccountId) return;
      if (storeState === 'error') {
        await retryStoreConnection();
      } else {
        await loadInventory(next);
      }
    } catch (error) {
      if (mountedRef.current && activeAccountIdRef.current === refreshingAccountId) {
        setFeedback({ kind: 'error', message: applePurchaseErrorMessage(error) });
      }
    } finally {
      if (mountedRef.current && activeAccountIdRef.current === refreshingAccountId) {
        setRefreshing(false);
      }
    }
  }, [loadAccess, loadInventory, retryStoreConnection, sessionAuthenticated, storeState, user]);

  const refreshAccountAccess = useCallback(async () => {
    if (!user || !sessionAuthenticated) return;
    const refreshingAccountId = user.userId;
    setRefreshing(true);
    setFeedback(null);
    try {
      const next = await loadFreshAccountAccess(refreshingAccountId);
      if (activeAccountIdRef.current !== refreshingAccountId) return;
      if (storeState === 'error') {
        await retryStoreConnection();
      } else {
        await loadInventory(next);
      }
      if (mountedRef.current && activeAccountIdRef.current === refreshingAccountId) {
        const knownStoreEnvironment = storeEnvironmentRef.current;
        if (knownStoreEnvironment && knownStoreEnvironment !== next.account.environment) {
          setFeedback({
            kind: 'error',
            message: knownStoreEnvironment === 'sandbox'
              ? 'Account access refreshed, but this TestFlight build still needs Sandbox testing access before purchasing or restoring.'
              : 'Account access refreshed, but this App Store build still needs Live App Store access before purchasing or restoring.',
          });
        } else {
          setFeedback({
            kind: 'success',
            message: next.account.environment === 'sandbox'
              ? 'Account access refreshed. Sandbox purchase verification is active.'
              : 'Account purchase access refreshed.',
          });
        }
      }
    } catch (error) {
      if (mountedRef.current && activeAccountIdRef.current === refreshingAccountId) {
        setFeedback({ kind: 'error', message: applePurchaseErrorMessage(error) });
      }
    } finally {
      if (mountedRef.current && activeAccountIdRef.current === refreshingAccountId) {
        setRefreshing(false);
      }
    }
  }, [loadFreshAccountAccess, loadInventory, retryStoreConnection, sessionAuthenticated, storeState, user]);

  const requestProduct = useCallback(async (productId: string) => {
    const requestingAccountId = activeAccountIdRef.current;
    if (!configurationRef.current || !storeReadyRef.current) {
      setFeedback({ kind: 'error', message: 'The App Store is not ready. Pull to refresh and try again.' });
      return;
    }

    setBusyProductId(productId);
    setFeedback(null);
    try {
      // The sandbox-commerce claim can be granted while this app session is
      // already open. Refresh it before Apple shows a confirmation sheet so a
      // sandbox transaction is never sent to the production verifier merely
      // because Firebase had cached the older token.
      await loadFreshAccountAccess(requestingAccountId);
      if (!requestingAccountId || activeAccountIdRef.current !== requestingAccountId) return;
      const accountEnvironment = snapshotRef.current?.account.environment;
      const knownStoreEnvironment = storeEnvironmentRef.current;
      if (knownStoreEnvironment && accountEnvironment && knownStoreEnvironment !== accountEnvironment) {
        setBusyProductId(null);
        setFeedback({
          kind: 'error',
          message: knownStoreEnvironment === 'sandbox'
            ? 'This TestFlight build uses Apple’s sandbox. Refresh account access and confirm Sandbox testing before purchasing.'
            : 'This App Store build uses live purchases. Refresh account access before purchasing.',
        });
        return;
      }
      const configuration = configurationRef.current;
      const descriptor = configuration
        ? findApplePurchaseDescriptor(configuration, productId)
        : null;
      if (!descriptor || !inventoryContainsProduct(inventory, descriptor)) {
        setBusyProductId(null);
        setFeedback({ kind: 'error', message: 'This product is not available in your App Store region.' });
        return;
      }
      const { requestPurchase } = await import('expo-iap');
      await requestPurchase({
        request: {
          apple: {
            sku: productId,
            appAccountToken: configuration.appAccountToken,
            quantity: 1,
            andDangerouslyFinishTransactionAutomatically: false,
          },
        },
        type: descriptor.kind === 'subscription' ? 'subs' : 'in-app',
      });
    } catch (error) {
      if (activeAccountIdRef.current !== requestingAccountId) return;
      setBusyProductId(null);
      if (isApplePurchaseCancellation(error)) {
        setFeedback({ kind: 'info', message: 'Purchase cancelled. Nothing was charged.' });
      } else if (isApplePurchasePending(error)) {
        setFeedback({
          kind: 'pending',
          message: 'Apple is still approving this purchase. Access will update when approval finishes.',
        });
      } else {
        setFeedback({ kind: 'error', message: applePurchaseErrorMessage(error) });
      }
    }
  }, [inventory, loadFreshAccountAccess]);

  const purchaseSubscription = useCallback(async (
    planId: PaidMonetizationPlanId,
    billingPeriod: MonetizationBillingPeriod,
  ) => {
    const descriptor = configurationRef.current?.subscriptions.find(
      (candidate) => candidate.planId === planId && candidate.billingPeriod === billingPeriod,
    );
    if (!descriptor) {
      setFeedback({ kind: 'error', message: 'This plan is not available for this app version.' });
      return;
    }
    await requestProduct(descriptor.productId);
  }, [requestProduct]);

  const purchaseCredits = useCallback(async (productId: string) => {
    const descriptor = configurationRef.current?.creditPacks.find(
      (candidate) => candidate.productId === productId,
    );
    if (!descriptor) {
      setFeedback({ kind: 'error', message: 'This Mana Credit pack is not available for this app version.' });
      return;
    }
    await requestProduct(descriptor.productId);
  }, [requestProduct]);

  const restorePurchases = useCallback(async () => {
    if (!configurationRef.current || !storeReadyRef.current || restoring) {
      if (!storeReadyRef.current) {
        setFeedback({ kind: 'error', message: 'The App Store is not ready. Pull to refresh and try again.' });
      }
      return;
    }
    const restoringAccountId = activeAccountIdRef.current;
    setRestoring(true);
    setFeedback(null);
    try {
      await loadFreshAccountAccess(restoringAccountId);
      const accountEnvironment = snapshotRef.current?.account.environment;
      const knownStoreEnvironment = storeEnvironmentRef.current;
      if (knownStoreEnvironment && accountEnvironment && knownStoreEnvironment !== accountEnvironment) {
        if (mountedRef.current && activeAccountIdRef.current === restoringAccountId) {
          setFeedback({
            kind: 'error',
            message: knownStoreEnvironment === 'sandbox'
              ? 'This TestFlight build uses Apple’s sandbox. Refresh account access and confirm Sandbox testing before restoring.'
              : 'This App Store build uses live purchases. Refresh account access before restoring.',
          });
        }
        return;
      }
      const purchases = await restoreApplePurchases();
      if (!restoringAccountId || activeAccountIdRef.current !== restoringAccountId) return;
      let restored = 0;
      let failed = 0;
      for (const purchase of purchases) {
        if (await processPurchase(purchase)) restored += 1;
        else failed += 1;
      }
      await loadAccess(restoringAccountId);
      if (mountedRef.current && activeAccountIdRef.current === restoringAccountId) {
        // processPurchase already supplied the precise safe recovery message.
        // Do not replace it with a false success when any returned transaction
        // could not be matched, verified, or finished.
        if (failed > 0) return;
        setFeedback({
          kind: 'success',
          message: restored > 0
            ? 'Purchases restored and access updated.'
            : 'Your App Store purchases are already up to date.',
        });
      }
    } catch (error) {
      if (mountedRef.current && activeAccountIdRef.current === restoringAccountId) {
        setFeedback({ kind: 'error', message: applePurchaseErrorMessage(error) });
      }
    } finally {
      if (mountedRef.current && activeAccountIdRef.current === restoringAccountId) {
        setRestoring(false);
      }
    }
  }, [loadAccess, loadFreshAccountAccess, processPurchase, restoring]);

  const manageSubscription = useCallback(async () => {
    try {
      await openAppleSubscriptionManagement();
    } catch (error) {
      setFeedback({ kind: 'error', message: applePurchaseErrorMessage(error) });
    }
  }, []);

  const value = useMemo<MonetizationPurchaseContextValue>(() => ({
    snapshot,
    inventory,
    storeState,
    storeEnvironment,
    loadingAccess,
    refreshing,
    restoring,
    busyProductId,
    feedback,
    commerceConfiguration: resolveAppleCommerceConfiguration(snapshot),
    refresh,
    refreshAccountAccess,
    retryStoreConnection,
    purchaseSubscription,
    purchaseCredits,
    restorePurchases,
    manageSubscription,
    clearFeedback: () => setFeedback(null),
  }), [
    busyProductId,
    feedback,
    inventory,
    loadingAccess,
    manageSubscription,
    purchaseCredits,
    purchaseSubscription,
    refresh,
    refreshAccountAccess,
    retryStoreConnection,
    restoring,
    restorePurchases,
    snapshot,
    storeState,
    storeEnvironment,
    refreshing,
  ]);

  return (
    <MonetizationPurchaseContext.Provider value={value}>
      {children}
    </MonetizationPurchaseContext.Provider>
  );
};

export const useMonetizationPurchases = (): MonetizationPurchaseContextValue => {
  const value = useContext(MonetizationPurchaseContext);
  if (!value) throw new Error('useMonetizationPurchases must be used inside MonetizationPurchaseProvider.');
  return value;
};
