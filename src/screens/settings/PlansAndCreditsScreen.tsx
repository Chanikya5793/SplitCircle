import { DetailScreenScaffold } from '@/components/ui/DetailScreenScaffold';
import { LiquidBackground } from '@/components/LiquidBackground';
import {
  AppButton,
  GlassCard,
  SCREEN_GUTTER,
  SectionLabel,
} from '@/components/ui';
import { useMonetizationPurchases } from '@/context/MonetizationPurchaseContext';
import { useTheme } from '@/context/ThemeContext';
import type {
  MonetizationBillingPeriod,
  MonetizationPlanId,
  PaidMonetizationPlanId,
} from '@/models/monetization';
import {
  findApplePurchaseDescriptor,
  storeDisplayPrice,
} from '@/services/monetizationPurchaseService';
import {
  buildAllPlanPresentations,
  describeAdvancedSplitAccess,
  PRIMARY_PLAN_IDS,
  type PlanPresentation,
} from '@/utils/monetizationPresentation';
import { appAlert } from '@/utils/appAlert';
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  RefreshControl,

  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Icon, IconButton, Text } from 'react-native-paper';

const TERMS_URL = 'https://manasplit.pages.dev/terms/';
const PRIVACY_URL = 'https://manasplit.pages.dev/privacy/';

const expiryCopy = (expiresAt: number | null): string => {
  if (!expiresAt) return 'No expiration date';
  return `Expires ${new Date(expiresAt).toLocaleString()}`;
};

const accessThroughCopy = (validUntil: number | null | undefined): string | null => {
  if (!validUntil) return null;
  return `Current access through ${new Date(validUntil).toLocaleDateString()}`;
};

const BillingSelector = ({
  value,
  onChange,
}: {
  value: MonetizationBillingPeriod;
  onChange: (value: MonetizationBillingPeriod) => void;
}) => {
  const { theme } = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      style={[
        styles.billingSelector,
        {
          backgroundColor: theme.colors.surfaceVariant,
          borderRadius: theme.radius.pill,
        },
      ]}
    >
      {(['monthly', 'annual'] as const).map((period) => {
        const selected = value === period;
        return (
          <TouchableOpacity
            key={period}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            activeOpacity={0.82}
            onPress={() => onChange(period)}
            style={[
              styles.billingOption,
              {
                backgroundColor: selected ? theme.colors.primary : 'transparent',
                borderRadius: theme.radius.pill,
              },
            ]}
          >
            <Text
              style={{
                color: selected ? theme.colors.onPrimary : theme.colors.onSurfaceVariant,
                fontWeight: '700',
              }}
            >
              {period === 'monthly' ? 'Monthly' : 'Annual'}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

const PlanCard = ({
  plan,
  billingPeriod,
  displayPrice,
  current,
  sameTier,
  available,
  busy,
  onChoose,
  onManage,
}: {
  plan: PlanPresentation;
  billingPeriod: MonetizationBillingPeriod;
  displayPrice: string | null;
  current: boolean;
  sameTier: boolean;
  available: boolean;
  busy: boolean;
  onChoose: () => Promise<void>;
  onManage: () => Promise<void>;
}) => {
  const { theme } = useTheme();
  const { fontScale, width } = useWindowDimensions();
  const stackRows = fontScale >= 1.3 || width < 360;
  const rows = [
    { label: 'Advanced splits', value: plan.advancedSplits },
  ];

  return (
    <GlassCard
      style={styles.card}
      contentStyle={styles.planContent}
    >
      <View style={[styles.planHeading, stackRows && styles.planHeadingStacked]}>
        <View style={styles.flex}>
          <View style={styles.titleLine}>
            <Text
              style={[
                styles.planTitle,
                {
                  color: theme.colors.onSurface,
                  fontSize: theme.typography.title.fontSize,
                  lineHeight: theme.typography.title.lineHeight,
                },
              ]}
            >
              {plan.label}
            </Text>

          </View>
          <View style={styles.priceLine}>
            <Text
              style={[
                styles.price,
                {
                  color: theme.colors.onSurface,
                  fontSize: theme.typography.headline.fontSize,
                  lineHeight: theme.typography.headline.lineHeight,
                },
              ]}
            >
              {displayPrice ?? 'Unavailable'}
            </Text>
            {displayPrice ? (
              <Text style={{ color: theme.colors.muted }}>
                / {billingPeriod === 'monthly' ? 'month' : 'year'}
              </Text>
            ) : null}
          </View>
          {billingPeriod === 'annual' && displayPrice ? (
            <Text style={{ color: theme.colors.muted }}>One yearly App Store charge</Text>
          ) : null}
        </View>
        {current ? <Text style={[theme.typography.caption, { color: theme.colors.success }]}>Current plan</Text> : null}
      </View>

      <View style={styles.planRows}>
        {rows.map((row) => (
          <View key={row.label} style={[styles.planRow, stackRows && styles.planRowStacked]}>
            <Text style={[styles.rowLabel, { color: theme.colors.muted }]}>{row.label}</Text>
            <Text style={[styles.rowValue, stackRows && styles.rowValueStacked, { color: theme.colors.onSurface }]}>{row.value}</Text>
          </View>
        ))}
      </View>

      <AppButton
        disabled={!available}
        loading={busy}
        onPress={current ? onManage : onChoose}
        style={styles.planButton}
        variant="secondary"
      >
        {current
          ? 'Manage current plan'
          : sameTier
            ? `Switch to ${billingPeriod === 'monthly' ? 'monthly' : 'annual'}`
            : `Choose ${plan.label}`}
      </AppButton>
    </GlassCard>
  );
};

export const PlansAndCreditsScreen = () => {
  const { theme } = useTheme();
  const { fontScale, width } = useWindowDimensions();
  const stackRows = fontScale >= 1.3 || width < 360;
  const [billingPeriod, setBillingPeriod] = useState<MonetizationBillingPeriod>('annual');
  const [showAllPlans, setShowAllPlans] = useState(false);
  const [showPurchaseDetails, setShowPurchaseDetails] = useState(false);
  const initializedActivePlanView = useRef(false);
  const {
    snapshot,
    inventory,
    storeState,
    storeEnvironment,
    loadingAccess,
    refreshing,
    restoring,
    busyProductId,
    feedback,
    commerceConfiguration,
    refresh,
    refreshAccountAccess,
    retryStoreConnection,
    purchaseSubscription,
    purchaseCredits,
    restorePurchases,
    manageSubscription,
    clearFeedback,
  } = useMonetizationPurchases();

  useFocusEffect(useCallback(() => {
    void refresh();
  }, [refresh]));

  const allPlans = useMemo(
    () => snapshot ? buildAllPlanPresentations(snapshot.catalog) : [],
    [snapshot],
  );
  const primaryPlans = useMemo(
    () => allPlans.filter((plan) => PRIMARY_PLAN_IDS.includes(
      plan.id as (typeof PRIMARY_PLAN_IDS)[number],
    )),
    [allPlans],
  );
  const additionalPlans = useMemo(
    () => allPlans.filter((plan) => !PRIMARY_PLAN_IDS.includes(
      plan.id as (typeof PRIMARY_PLAN_IDS)[number],
    )),
    [allPlans],
  );
  const currentPlanId: MonetizationPlanId = snapshot?.account.planId ?? 'free';
  const activeSubscriptionProductId = snapshot?.account.activeSubscriptionProductId ?? null;
  const currentPlanLabel = snapshot?.catalog.plans[currentPlanId]?.label ?? 'Free';
  const creditBalance = snapshot?.account.creditBalance ?? 0;
  const creditDebt = snapshot?.account.creditDebt ?? 0;
  const currentAccessThrough = accessThroughCopy(snapshot?.account.validUntil);
  const checkoutReady = Platform.OS === 'ios'
    && storeState === 'ready'
    && (!storeEnvironment || storeEnvironment === snapshot?.account.environment)
    && commerceConfiguration !== null;
  const configuredProductCount = commerceConfiguration
    ? commerceConfiguration.subscriptions.length + commerceConfiguration.creditPacks.length
    : 0;
  const loadedProductCount = inventory.subscriptions.length + inventory.creditPacks.length;

  useEffect(() => {
    if (initializedActivePlanView.current || !snapshot) return;
    initializedActivePlanView.current = true;
    const activeProduct = activeSubscriptionProductId
      ? commerceConfiguration?.subscriptions.find(
        (product) => product.productId === activeSubscriptionProductId,
      )
      : null;
    if (activeProduct) setBillingPeriod(activeProduct.billingPeriod);
    if (currentPlanId !== 'free' && !PRIMARY_PLAN_IDS.includes(
      currentPlanId as (typeof PRIMARY_PLAN_IDS)[number],
    )) {
      setShowAllPlans(true);
    }
  }, [activeSubscriptionProductId, commerceConfiguration, currentPlanId, snapshot]);
  const purchaseStatus = useMemo(() => {
    if (Platform.OS !== 'ios') {
      return {
        icon: 'cellphone-off',
        tone: theme.colors.muted,
        title: 'Purchases require an Apple device',
        detail: 'Subscriptions and Mana Credits are available through the App Store on iPhone and iPad.',
      };
    }
    if (storeState === 'connecting' || loadingAccess) {
      return {
        icon: 'store-clock-outline',
        tone: theme.colors.primary,
        title: 'Connecting to the App Store',
        detail: 'Prices and purchase buttons will appear after Apple and ManaSplit finish checking access.',
      };
    }
    if (storeState === 'error') {
      return {
        icon: 'store-alert-outline',
        tone: theme.colors.error,
        title: 'App Store connection needs attention',
        detail: 'Reconnect to Apple, then reload prices without signing out of ManaSplit.',
      };
    }
    if (!commerceConfiguration) {
      return {
        icon: 'shield-alert-outline',
        tone: theme.colors.warning,
        title: 'Secure checkout is unavailable',
        detail: 'ManaSplit could not load a purchase configuration that matches this app and account.',
      };
    }
    if (storeEnvironment && storeEnvironment !== snapshot?.account.environment) {
      return {
        icon: 'store-alert-outline',
        tone: theme.colors.error,
        title: 'Purchase environment needs attention',
        detail: storeEnvironment === 'sandbox'
          ? 'Apple reports a TestFlight sandbox receipt, but this ManaSplit account still has Live App Store access.'
          : 'Apple reports a live App Store receipt, but this ManaSplit account still has Sandbox testing access.',
      };
    }
    if (inventory.missingProductIds.length > 0) {
      return {
        icon: 'store-alert-outline',
        tone: theme.colors.warning,
        title: loadedProductCount > 0 ? 'Some offers are unavailable' : 'Offers are unavailable',
        detail: `${loadedProductCount} of ${configuredProductCount} offers loaded${inventory.storefrontCountryCode ? ` for ${inventory.storefrontCountryCode}` : ''}.`,
      };
    }
    return {
      icon: 'store-check-outline',
      tone: theme.colors.success,
      title: 'App Store ready',
      detail: `${loadedProductCount} offers loaded${inventory.storefrontCountryCode ? ` for ${inventory.storefrontCountryCode}` : ''}.`,
    };
  }, [
    commerceConfiguration,
    configuredProductCount,
    inventory.missingProductIds.length,
    inventory.storefrontCountryCode,
    loadedProductCount,
    loadingAccess,
    snapshot?.account.environment,
    storeState,
    storeEnvironment,
    theme.colors.error,
    theme.colors.muted,
    theme.colors.primary,
    theme.colors.success,
    theme.colors.warning,
  ]);

  const openLegalPage = useCallback(async (label: string, url: string) => {
    try {
      await Linking.openURL(url);
    } catch (error) {
      console.warn(`[PlansAndCredits] Could not open ${label}:`, error);
      appAlert(`Could not open ${label}`, 'Check your connection and try again.');
    }
  }, []);

  const descriptorForPlan = useCallback((planId: PaidMonetizationPlanId) =>
    commerceConfiguration?.subscriptions.find(
      (product) => product.planId === planId && product.billingPeriod === billingPeriod,
    ) ?? null, [billingPeriod, commerceConfiguration]);

  const renderPlan = (plan: PlanPresentation) => {
    const descriptor = descriptorForPlan(plan.id);
    const displayPrice = descriptor ? storeDisplayPrice(inventory, descriptor) : null;
    const available = Boolean(descriptor && displayPrice && checkoutReady);
    const sameTier = currentPlanId === plan.id;
    const current = activeSubscriptionProductId
      ? descriptor?.productId === activeSubscriptionProductId
      : sameTier;
    return (
      <PlanCard
        key={plan.id}
        plan={plan}
        billingPeriod={billingPeriod}
        displayPrice={displayPrice}
        current={current}
        sameTier={sameTier}
        available={current ? Platform.OS === 'ios' : available}
        busy={Boolean(descriptor && busyProductId === descriptor.productId)}
        onChoose={() => purchaseSubscription(plan.id, billingPeriod)}
        onManage={manageSubscription}
      />
    );
  };

  const feedbackColor = feedback?.kind === 'error'
    ? theme.colors.error
    : feedback?.kind === 'pending'
      ? theme.colors.warning
      : feedback?.kind === 'success'
        ? theme.colors.success
        : theme.colors.primary;

  return (
    <LiquidBackground style={styles.root}>
      <DetailScreenScaffold
        horizontalInset={SCREEN_GUTTER}
        contentContainerStyle={styles.scrollContent}
        bottomSpacing={theme.spacing.xxl}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={theme.colors.primary}
          />
        )}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroCopy}>
          <Text
            style={{
              color: theme.colors.onSurface,
              fontSize: theme.typography.headline.fontSize,
              lineHeight: theme.typography.headline.lineHeight,
              fontWeight: theme.typography.headline.fontWeight,
            }}
          >
            Choose how you use ManaSplit
          </Text>
          <Text
            style={{
              color: theme.colors.muted,
              fontSize: theme.typography.body.fontSize,
              lineHeight: theme.typography.body.lineHeight,
            }}
          >
            Keep the free essentials, add a plan for regular use, or buy Mana Credits only when you need them.
          </Text>
        </View>

        {loadingAccess && !snapshot ? (
          <View style={styles.loading} accessibilityLiveRegion="polite">
            <ActivityIndicator color={theme.colors.primary} />
            <Text style={{ color: theme.colors.muted }}>Loading App Store access…</Text>
          </View>
        ) : null}

        {feedback ? (
          <GlassCard style={styles.card} contentStyle={styles.feedbackContent}>
            <Icon
              source={feedback.kind === 'success'
                ? 'check-circle-outline'
                : feedback.kind === 'pending'
                  ? 'clock-outline'
                  : feedback.kind === 'error'
                    ? 'alert-circle-outline'
                    : 'information-outline'}
              size={23}
              color={feedbackColor}
            />
            <Text style={[styles.flex, { color: theme.colors.onSurface }]}>{feedback.message}</Text>
            <IconButton
              accessibilityLabel="Dismiss message"
              icon="close"
              size={18}
              onPress={clearFeedback}
            />
          </GlassCard>
        ) : null}

        {snapshot ? (
          <>
            {snapshot.account.access.kind === 'internal_test' ? (
              <GlassCard style={styles.card} contentStyle={styles.internalContent}>
                <View
                  style={[
                    styles.statusIcon,
                    { backgroundColor: theme.colors.successContainer, borderRadius: theme.radius.pill },
                  ]}
                >
                  <Icon source="shield-check" size={22} color={theme.colors.success} />
                </View>
                <View style={styles.flex}>
                  <Text style={[styles.messageTitle, { color: theme.colors.onSurface }]}>Full access enabled</Text>
                  <Text style={{ color: theme.colors.muted }}>
                    Your account can use all ManaSplit features. {expiryCopy(snapshot.account.access.grantExpiresAt)}.
                  </Text>
                </View>
              </GlassCard>
            ) : null}

            <GlassCard style={styles.card} contentStyle={styles.ledgerContent}>
              <View style={[styles.ledgerHeader, stackRows && styles.ledgerHeaderStacked]}>
                <View style={styles.flex}>
                  <Text style={[styles.eyebrow, { color: theme.colors.muted }]}>CURRENT ACCESS</Text>
                  <Text
                    style={[
                      styles.currentPlan,
                      {
                        color: theme.colors.onSurface,
                        fontSize: theme.typography.headline.fontSize,
                        lineHeight: theme.typography.headline.lineHeight,
                      },
                    ]}
                  >
                    {currentPlanLabel}
                  </Text>
                  <Text style={{ color: theme.colors.muted }}>
                    {describeAdvancedSplitAccess(snapshot.catalog, currentPlanId)} for advanced splits
                  </Text>
                  {currentAccessThrough ? (
                    <Text style={{ color: theme.colors.muted }}>{currentAccessThrough}</Text>
                  ) : null}
                </View>
                <View
                  style={[
                    styles.creditBalance,
                    stackRows && styles.creditBalanceStacked,
                    { backgroundColor: theme.colors.primaryContainer, borderRadius: theme.radius.lg },
                  ]}
                >
                  <Icon source="circle-multiple-outline" size={22} color={theme.colors.primary} />
                  <Text style={[styles.creditNumber, { color: theme.colors.onPrimaryContainer }]}>
                    {creditBalance.toLocaleString()}
                  </Text>
                  <Text style={[styles.creditUnit, { color: theme.colors.onPrimaryContainer }]}>CREDITS</Text>
                </View>
              </View>
              <Text style={{ color: theme.colors.muted }}>
                Included uses reset with your plan. Purchased credits do not expire and are used only after you approve the charge for a feature.
              </Text>
              {creditDebt > 0 ? (
                <Text style={{ color: theme.colors.warning }}>
                  Refund adjustment: {creditDebt.toLocaleString()} future {creditDebt === 1 ? 'credit' : 'credits'} will be applied before new credits become spendable.
                </Text>
              ) : null}
            </GlassCard>

            <GlassCard style={styles.card} contentStyle={styles.storeStatusContent}>
              <View style={styles.storeStatusHeading} accessibilityLiveRegion="polite">
                <View
                  style={[
                    styles.statusIcon,
                    { backgroundColor: theme.colors.surfaceVariant, borderRadius: theme.radius.pill },
                  ]}
                >
                  <Icon source={purchaseStatus.icon} size={22} color={purchaseStatus.tone} />
                </View>
                <View style={styles.flex}>
                  <Text style={[styles.messageTitle, { color: theme.colors.onSurface }]}>
                    {purchaseStatus.title}
                  </Text>
                  <Text style={{ color: theme.colors.muted }}>{purchaseStatus.detail}</Text>
                </View>
              </View>
              {storeState === 'error' ? (
                <AppButton
                  variant="secondary"
                  icon="refresh"
                  onPress={retryStoreConnection}
                >
                  Retry App Store
                </AppButton>
              ) : null}
              <AppButton
                variant="ghost"
                compact
                icon={showPurchaseDetails ? 'chevron-up' : 'chevron-down'}
                onPress={async () => setShowPurchaseDetails((visible) => !visible)}
              >
                {showPurchaseDetails ? 'Hide purchase details' : 'Purchase details'}
              </AppButton>
              {showPurchaseDetails ? (
                <View style={styles.purchaseDetails}>
                  <View style={styles.detailRow}>
                    <Text style={[styles.detailLabel, { color: theme.colors.muted }]}>Connection</Text>
                    <Text style={[styles.detailValue, { color: theme.colors.onSurface }]}>
                      {storeState === 'ready' ? 'Connected' : storeState === 'connecting' ? 'Connecting' : 'Unavailable'}
                    </Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={[styles.detailLabel, { color: theme.colors.muted }]}>Verification</Text>
                    <Text style={[styles.detailValue, { color: theme.colors.onSurface }]}>
                      {snapshot.account.environment === 'sandbox' ? 'Sandbox testing' : 'Live App Store'}
                    </Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={[styles.detailLabel, { color: theme.colors.muted }]}>Apple receipt</Text>
                    <Text style={[styles.detailValue, { color: theme.colors.onSurface }]}>
                      {storeEnvironment === 'sandbox'
                        ? 'Sandbox'
                        : storeEnvironment === 'production'
                          ? 'Live App Store'
                          : 'Not reported'}
                    </Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={[styles.detailLabel, { color: theme.colors.muted }]}>Products</Text>
                    <Text style={[styles.detailValue, { color: theme.colors.onSurface }]}>
                      {configuredProductCount > 0
                        ? `${loadedProductCount} of ${configuredProductCount} available`
                        : 'Configuration unavailable'}
                    </Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={[styles.detailLabel, { color: theme.colors.muted }]}>Storefront</Text>
                    <Text style={[styles.detailValue, { color: theme.colors.onSurface }]}>
                      {inventory.storefrontCountryCode ?? 'Not reported'}
                    </Text>
                  </View>
                  {currentAccessThrough ? (
                    <View style={styles.detailRow}>
                      <Text style={[styles.detailLabel, { color: theme.colors.muted }]}>Plan access</Text>
                      <Text style={[styles.detailValue, { color: theme.colors.onSurface }]}>
                        {new Date(snapshot.account.validUntil as number).toLocaleString()}
                      </Text>
                    </View>
                  ) : null}
                  <Text style={[styles.testingNote, { color: theme.colors.muted }]}>
                    If you are testing through TestFlight, Verification must say Sandbox testing before you confirm a purchase.
                  </Text>
                  <AppButton
                    variant="secondary"
                    compact
                    icon="account-sync-outline"
                    loading={refreshing}
                    onPress={refreshAccountAccess}
                  >
                    Refresh account access
                  </AppButton>
                </View>
              ) : null}
            </GlassCard>

            <View style={[styles.sectionHeaderRow, stackRows && styles.sectionHeaderRowStacked]}>
              <SectionLabel style={styles.sectionLabel}>Subscriptions</SectionLabel>
              <BillingSelector value={billingPeriod} onChange={setBillingPeriod} />
            </View>
            <Text style={[theme.typography.body, { color: theme.colors.onSurfaceVariant, marginBottom: theme.spacing.md }]}>
              Every plan includes core expenses, groups and chat. Mana Credit top-ups are available with any plan. Compare included advanced splits and the total billing price below.
            </Text>
            <View style={styles.planList}>{primaryPlans.map(renderPlan)}</View>

            <AppButton
              variant="ghost"
              compact
              icon={showAllPlans ? 'chevron-up' : 'chevron-down'}
              onPress={async () => setShowAllPlans((current) => !current)}
              style={styles.showAllButton}
            >
              {showAllPlans ? 'Show fewer plans' : 'See all plans'}
            </AppButton>

            {showAllPlans ? (
              <View style={styles.planList}>
                {additionalPlans.map(renderPlan)}
              </View>
            ) : null}

            <SectionLabel style={styles.sectionLabel}>Mana Credits</SectionLabel>
            <GlassCard style={styles.card} contentStyle={styles.sectionContent}>
              <View style={styles.sectionHeading}>
                <View
                  style={[
                    styles.statusIcon,
                    { backgroundColor: theme.colors.primaryContainer, borderRadius: theme.radius.pill },
                  ]}
                >
                  <Icon source="wallet-plus-outline" size={22} color={theme.colors.primary} />
                </View>
                <View style={styles.flex}>
                  <Text style={[styles.messageTitle, { color: theme.colors.onSurface }]}>Top up only when needed</Text>
                  <Text style={{ color: theme.colors.muted }}>
                    Credits work with or without a subscription. Buying a pack does not start a recurring payment.
                  </Text>
                </View>
              </View>

              <View style={styles.creditPacks}>
                {(commerceConfiguration?.creditPacks ?? []).map((pack) => {
                  const descriptor = findApplePurchaseDescriptor(commerceConfiguration!, pack.productId);
                  const displayPrice = descriptor ? storeDisplayPrice(inventory, descriptor) : null;
                  const available = Boolean(displayPrice && checkoutReady);
                  return (
                    <View
                      key={pack.productId}
                      style={[
                        styles.creditPack,
                        stackRows && styles.creditPackStacked,
                        {
                          backgroundColor: theme.colors.surfaceVariant,
                          borderRadius: theme.radius.lg,
                        },
                      ]}
                    >
                      <View style={styles.creditPackCopy}>
                        <Text style={[styles.creditPackAmount, { color: theme.colors.onSurface }]}>
                          {pack.credits.toLocaleString()}
                        </Text>
                        <Text style={{ color: theme.colors.muted }}>Mana Credits</Text>
                        <Text style={[styles.creditPackPrice, { color: theme.colors.onSurface }]}>
                          {displayPrice ?? 'Unavailable'}
                        </Text>
                      </View>
                      <AppButton
                        compact
                        disabled={!available}
                        loading={busyProductId === pack.productId}
                        onPress={() => purchaseCredits(pack.productId)}
                        style={stackRows ? styles.stackedButton : undefined}
                      >
                        Buy {pack.credits}
                      </AppButton>
                    </View>
                  );
                })}
              </View>

              {!commerceConfiguration ? (
                <Text style={{ color: theme.colors.warning }}>
                  Purchases are not available for this app version yet.
                </Text>
              ) : null}
              {inventory.missingProductIds.length > 0 && storeState === 'ready' ? (
                <Text style={{ color: theme.colors.warning }}>
                  Some offers are unavailable for this Apple Account or App Store region. Check App Store sign-in, purchase restrictions, and try reloading prices.
                </Text>
              ) : null}
            </GlassCard>

            <SectionLabel style={styles.sectionLabel}>App Store account</SectionLabel>
            <GlassCard style={styles.card} contentStyle={styles.accountActions}>
              <AppButton
                variant="secondary"
                icon="restore"
                disabled={!checkoutReady}
                loading={restoring}
                onPress={restorePurchases}
              >
                Restore purchases
              </AppButton>
              <AppButton
                variant="ghost"
                icon="open-in-new"
                disabled={Platform.OS !== 'ios'}
                onPress={manageSubscription}
              >
                Manage subscription
              </AppButton>
            </GlassCard>

            <Text style={[styles.renewalCopy, { color: theme.colors.muted }]}>
              Payment is charged to your Apple Account. Subscriptions renew automatically unless cancelled at least 24 hours before the current period ends. Manage or cancel in your App Store account.
            </Text>
            <View style={styles.legalLinks}>
              <TouchableOpacity
                accessibilityRole="link"
                accessibilityLabel="Open ManaSplit terms"
                onPress={() => void openLegalPage('Terms', TERMS_URL)}
              >
                <Text style={{ color: theme.colors.primary, fontWeight: '700' }}>Terms</Text>
              </TouchableOpacity>
              <Text style={{ color: theme.colors.muted }}>•</Text>
              <TouchableOpacity
                accessibilityRole="link"
                accessibilityLabel="Open ManaSplit privacy policy"
                onPress={() => void openLegalPage('Privacy policy', PRIVACY_URL)}
              >
                <Text style={{ color: theme.colors.primary, fontWeight: '700' }}>Privacy</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : null}
      </DetailScreenScaffold>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  scrollContent: {
    gap: 12,
  },
  heroCopy: {
    gap: 6,
    marginBottom: 4,
  },
  loading: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  card: { overflow: 'hidden' },
  feedbackContent: {
    minHeight: 62,
    paddingLeft: 16,
    paddingRight: 4,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  internalContent: {
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  statusIcon: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageTitle: {
    fontWeight: '700',
    marginBottom: 2,
  },
  ledgerContent: {
    padding: 16,
    gap: 14,
  },
  ledgerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  ledgerHeaderStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  storeStatusContent: {
    padding: 16,
    gap: 10,
  },
  storeStatusHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  purchaseDetails: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128, 128, 128, 0.35)',
    paddingTop: 12,
    gap: 8,
  },
  detailRow: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  detailLabel: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  detailValue: {
    flex: 1.35,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    textAlign: 'right',
  },
  testingNote: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17,
  },
  eyebrow: {
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 1.2,
    fontWeight: '800',
  },
  currentPlan: { fontWeight: '800' },
  creditBalance: {
    minWidth: 88,
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  creditBalanceStacked: {
    minWidth: 104,
    alignSelf: 'flex-start',
  },
  creditNumber: {
    fontSize: 22,
    lineHeight: 27,
    fontWeight: '900',
  },
  creditUnit: {
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 1,
    fontWeight: '800',
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 12,
  },
  sectionHeaderRowStacked: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  sectionLabel: {
    marginLeft: 4,
    marginTop: 12,
    marginBottom: -4,
  },
  billingSelector: {
    flexDirection: 'row',
    padding: 3,
  },
  billingOption: {
    minHeight: 44,
    minWidth: 82,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  planList: { gap: 12 },
  planContent: {
    padding: 16,
    gap: 14,
  },
  planHeading: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  planHeadingStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  },
  planTitle: { fontWeight: '800' },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  priceLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: 4,
  },
  price: { fontWeight: '900' },
  planRows: { gap: 9 },
  planRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  planRowStacked: {
    flexDirection: 'column',
    gap: 2,
  },
  rowLabel: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  rowValue: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    textAlign: 'right',
  },
  rowValueStacked: {
    textAlign: 'left',
    flex: 0,
  },
  planButton: { marginTop: 2 },
  showAllButton: { alignSelf: 'center' },
  sectionContent: {
    padding: 16,
    gap: 16,
  },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  creditPacks: { gap: 10 },
  creditPack: {
    minHeight: 86,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  creditPackStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  stackedButton: {
    alignSelf: 'stretch',
  },
  creditPackCopy: { flex: 1 },
  creditPackAmount: {
    fontSize: 22,
    lineHeight: 26,
    fontWeight: '900',
  },
  creditPackPrice: {
    marginTop: 4,
    fontWeight: '700',
  },
  accountActions: {
    padding: 16,
    gap: 8,
  },
  renewalCopy: {
    marginTop: 8,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  legalLinks: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
  },
});
