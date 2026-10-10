export const MONETIZATION_SCHEMA_VERSION = 1 as const;

export type MonetizationPlanId =
  | 'free'
  | 'essential'
  | 'plus'
  | 'pro'
  | 'power'
  | 'max';

export const PAID_MONETIZATION_PLAN_IDS = [
  'essential',
  'plus',
  'pro',
  'power',
  'max',
] as const satisfies readonly MonetizationPlanId[];

export type PaidMonetizationPlanId = (typeof PAID_MONETIZATION_PLAN_IDS)[number];
export type MonetizationBillingPeriod = 'monthly' | 'annual';

export type MonetizationEnvironment = 'sandbox' | 'production';
export type MonetizationExecutionRoute =
  | 'local_deterministic'
  | 'on_device_apple'
  | 'provider'
  | 'server';
export type MonetizationUsageOutcome = 'completed' | 'failed' | 'cancelled' | 'abandoned';
export type MonetizationQuotaCadence = 'day' | 'week' | 'month';
export type MonetizationCostClass =
  | 'deterministic_local'
  | 'apple_device_capability'
  | 'provider_variable'
  | 'persistent_infrastructure';

export type MonetizationQuotaRule =
  | { kind: 'metered'; limit: number; cadence: MonetizationQuotaCadence }
  | { kind: 'unlimited_local' }
  | { kind: 'measure_only'; cadence: MonetizationQuotaCadence };

export interface MonetizationPlanDefinition {
  label: string;
  storefrontStatus: 'not_for_sale' | 'research_only' | 'for_sale' | 'storefront';
}

/** Feature ids the app can reserve itself (the work runs on this device). */
export type ClientMeteredFeatureId =
  | 'advanced_split.completion'
  | 'ai.expense_on_device_turn'
  | 'insights.advanced_report';

/** Feature ids metered inside the server callable that does the work. */
export type ServerMeteredFeatureId = 'provider.security_check' | 'provider.manual_monitor_run';

export type MeteredFeatureId = ClientMeteredFeatureId | ServerMeteredFeatureId;

export interface MonetizationFeatureDefinition {
  id: string;
  /** Short user-facing name. Older catalogs used a technical description. */
  label: string;
  /** Nouns for one completed use; absent on older catalogs. */
  unit?: { one: string; other: string };
  enforcement?: 'client_authorized' | 'server_internal';
  quotaKey: string;
  costClass: MonetizationCostClass;
  allowedExecutionRoutes: MonetizationExecutionRoute[];
  quotaByPlan: Record<MonetizationPlanId, MonetizationQuotaRule>;
  /** Current server-owned price in Mana Credits. */
  creditCost?: number | null;
  /** Accepted only for compatibility with the earlier shadow catalog. */
  creditCostHypothesis?: number | null;
  variants?: string[];
  freePreview?: {
    kind: 'per_variant_lifetime';
    count: 1;
  };
}

export interface MonetizationPricingHypotheses {
  status: 'research_hypothesis' | 'storefront';
  currency: 'USD';
  checkoutDisplayAllowed: boolean;
  localizedStorefrontPriceRequired: true;
  subscriptions: Partial<Record<Exclude<MonetizationPlanId, 'free'>, {
    monthlyMinor: number;
    annualMinor: number;
  }>>;
  creditPacks: Array<{ credits: number; priceMinor?: number; productId?: string }>;
  permanentUnlockResearchRanges: Record<
    string,
    { minimumMinor: number; maximumMinor: number }
  >;
}

export interface MonetizationCatalog {
  schemaVersion: 1;
  version: string;
  status: 'research_hypothesis' | 'active';
  enforcementMode: 'shadow' | 'enforced';
  plans: Record<MonetizationPlanId, MonetizationPlanDefinition>;
  features: Record<string, MonetizationFeatureDefinition>;
  capacities: {
    premiumSavedLooks: Record<MonetizationPlanId, number | null>;
    premiumAppearanceCollections: Record<
      MonetizationPlanId,
      number | 'rotating_preview' | 'all_current' | 'all_current_and_future_while_subscribed'
    >;
  };
  pricing: MonetizationPricingHypotheses;
  exclusions: {
    permanentlyFreeSplitMethods: string[];
    randomizedOrUnclearedSplitMethods: string[];
    purchasedCreditChargingEnabled: boolean;
  };
}

export interface MonetizationAppleSubscriptionProducts {
  monthly: string;
  annual: string;
}

export interface MonetizationAppleCreditProduct {
  productId: string;
  credits: number;
}

export interface MonetizationAppleCommerce {
  enabled: boolean;
  platform: 'ios';
  bundleId: 'com.splitcircle.app';
  appAppleId: 6760814898;
  verificationCallable: 'verifyAppleTransaction';
  products: {
    subscriptions: Record<PaidMonetizationPlanId, MonetizationAppleSubscriptionProducts>;
    creditPacks: MonetizationAppleCreditProduct[];
  };
}

export interface MonetizationSnapshot {
  schemaVersion: 1;
  serverTime: number;
  catalog: MonetizationCatalog;
  account: {
    environment: MonetizationEnvironment;
    planId: MonetizationPlanId;
    planSource: 'default_free' | 'server_projection';
    /** End of the currently projected paid entitlement. Older snapshots omit it. */
    validUntil?: number | null;
    /** Exact StoreKit product currently projecting the paid tier. */
    activeSubscriptionProductId?: string | null;
    /** Added by the production ledger. Older shadow snapshots omit it. */
    creditBalance?: number;
    /** Outstanding adjustment from refunded credits that were already spent. */
    creditDebt?: number;
    /** Opaque server-issued UUID. Never derive this from the Firebase UID. */
    appAccountToken?: string | null;
    access: {
      kind: 'standard' | 'internal_test';
      commercialQuotaBypass: boolean;
      providerSafetyBypass: false;
      grantExpiresAt: number | null;
      grantId: string | null;
    };
  };
  /** Absent on the pre-commerce shadow contract. Absence always disables checkout. */
  commerce?: MonetizationAppleCommerce;
  capabilities: {
    appleVerification: boolean;
    creditPurchases: boolean;
    creditSpending: boolean;
    offlineLeases: boolean;
    friendGifting: false;
  };
  enforcement: {
    commercial: 'shadow' | 'server_enforced';
    blocksFeatures: boolean;
  };
}

export interface VerifyAppleTransactionInput {
  productId: string;
  transactionId: string;
  signedTransactionInfo: string;
  appAccountToken: string;
}

export interface VerifyAppleTransactionResult {
  verified: true;
  accepted: true;
  duplicate: boolean;
  finishTransaction: true;
  environment: MonetizationEnvironment;
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  purchaseKind: 'subscription' | 'consumable_credits';
  /** Highest currently active plan after the verified transaction is applied. */
  planId: MonetizationPlanId | null;
  /** Plan encoded by the exact subscription product that was verified. */
  purchasedPlanId: PaidMonetizationPlanId | null;
  validUntil: number | null;
  activeSubscriptionProductId?: string | null;
  creditsGranted: number;
  creditBalance: number;
  creditDebt?: number;
  serverTime: number;
}

export type MonetizedOperationAccessSource =
  | 'preview'
  | 'included_use'
  | 'unlimited'
  | 'internal_test'
  | 'measurement_only'
  | 'credits'
  | 'quota_exhausted';

export interface AuthorizeMonetizedOperationInput {
  operationId: string;
  featureId: string;
  variant?: string;
  executionRoute: MonetizationExecutionRoute;
  /** Credits must never be considered unless the user approved this exact attempt. */
  useCredits: boolean;
}

export interface MonetizedOperationAuthorization {
  schemaVersion: 1;
  allowed: boolean;
  /** Server reservation id. Null when access was denied before reserving anything. */
  authorizationId: string | null;
  environment: MonetizationEnvironment;
  featureId: string;
  planId: MonetizationPlanId;
  source: MonetizedOperationAccessSource;
  reasonCode: string;
  creditCost: number | null;
  creditBalance: number;
  remaining: number | null;
  resetsAt: number | null;
}

export interface FinalizeMonetizedOperationInput {
  operationId: string;
  authorizationId: string;
  outcome: MonetizationUsageOutcome;
}

export interface FinalizeMonetizedOperationResult {
  schemaVersion: 1;
  accepted: true;
  duplicate: boolean;
  outcome: MonetizationUsageOutcome;
  creditBalance: number;
  serverTime: number;
}

export interface RecordMonetizationUsageInput {
  operationId: string;
  featureId: string;
  outcome: MonetizationUsageOutcome;
  variant?: string;
  executionRoute: MonetizationExecutionRoute;
  connectivity: 'online' | 'offline_reconciled';
  app?: {
    platform: 'ios' | 'android';
    version?: string;
    build?: string;
    distribution?: string;
  };
}

export interface MonetizationUsageDecision {
  schemaVersion: 1;
  accepted: true;
  duplicate: boolean;
  enforcementApplied: false;
  allowed: true;
  environment: MonetizationEnvironment;
  featureId: string;
  quotaKey: string;
  planId: MonetizationPlanId;
  accessSource: string;
  shadowDecision: {
    wouldAllow: boolean;
    source:
      | 'preview'
      | 'included_use'
      | 'unlimited'
      | 'internal_test'
      | 'quota_exhausted'
      | 'measurement_only'
      | 'not_counted';
    reasonCode: string;
    limit: number | null;
    usedBefore: number;
    usedAfter: number;
    remaining: number | null;
    windowStart: number | null;
    resetsAt: number | null;
    countedTowardQuota: boolean;
    claimedPreview: boolean;
  };
  credits: { evaluated: false };
  offline: {
    reconciled: boolean;
    leaseVerified: false;
    windowBasis: 'server_received_at';
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const AUTHORIZATION_ID_PATTERN = /^[0-9a-f]{64}$/;

export const isMonetizationPlanId = (value: unknown): value is MonetizationPlanId =>
  value === 'free'
  || value === 'essential'
  || value === 'plus'
  || value === 'pro'
  || value === 'power'
  || value === 'max';

const isPaidMonetizationPlanId = (value: unknown): value is PaidMonetizationPlanId =>
  PAID_MONETIZATION_PLAN_IDS.includes(value as PaidMonetizationPlanId);

const isEnvironment = (value: unknown): value is MonetizationEnvironment =>
  value === 'sandbox' || value === 'production';

const isQuotaRule = (value: unknown): value is MonetizationQuotaRule => {
  if (!isRecord(value)) return false;
  if (value.kind === 'unlimited_local') return true;
  if (value.kind === 'measure_only') {
    return value.cadence === 'day' || value.cadence === 'week' || value.cadence === 'month';
  }
  return value.kind === 'metered'
    && Number.isInteger(value.limit)
    && (value.limit as number) >= 0
    && (value.cadence === 'day' || value.cadence === 'week' || value.cadence === 'month');
};

const hasPlanKeys = (
  value: unknown,
  validate: (entry: unknown) => boolean,
): value is Record<MonetizationPlanId, unknown> => isRecord(value)
  && ['free', ...PAID_MONETIZATION_PLAN_IDS].every((planId) => validate(value[planId]));

const isPlanDefinition = (value: unknown): value is MonetizationPlanDefinition => isRecord(value)
  && typeof value.label === 'string'
  && value.label.trim().length > 0
  && (
    value.storefrontStatus === 'not_for_sale'
    || value.storefrontStatus === 'research_only'
    || value.storefrontStatus === 'for_sale'
    || value.storefrontStatus === 'storefront'
  );

const isFeatureDefinition = (value: unknown): value is MonetizationFeatureDefinition => isRecord(value)
  && typeof value.id === 'string'
  && typeof value.label === 'string'
  && typeof value.quotaKey === 'string'
  && Array.isArray(value.allowedExecutionRoutes)
  && hasPlanKeys(value.quotaByPlan, isQuotaRule)
  && (
    value.creditCost === null
    || isFiniteNumber(value.creditCost)
    || value.creditCostHypothesis === null
    || isFiniteNumber(value.creditCostHypothesis)
  );

const isCatalog = (value: unknown): value is MonetizationCatalog => {
  if (!isRecord(value)
    || value.schemaVersion !== MONETIZATION_SCHEMA_VERSION
    || typeof value.version !== 'string'
    || (value.status !== 'research_hypothesis' && value.status !== 'active')
    || (value.enforcementMode !== 'shadow' && value.enforcementMode !== 'enforced')
    || !hasPlanKeys(value.plans, isPlanDefinition)
    || !isRecord(value.features)
    || !Object.values(value.features).every(isFeatureDefinition)
    || !isRecord(value.capacities)
    || !hasPlanKeys(
      value.capacities.premiumSavedLooks,
      (entry) => entry === null || (Number.isInteger(entry) && (entry as number) >= 0),
    )
    || !hasPlanKeys(
      value.capacities.premiumAppearanceCollections,
      (entry) => Number.isInteger(entry)
        || entry === 'rotating_preview'
        || entry === 'all_current'
        || entry === 'all_current_and_future_while_subscribed',
    )
    || !isRecord(value.pricing)
    || (value.pricing.status !== 'research_hypothesis' && value.pricing.status !== 'storefront')
    || value.pricing.currency !== 'USD'
    || typeof value.pricing.checkoutDisplayAllowed !== 'boolean'
    || value.pricing.localizedStorefrontPriceRequired !== true
    || !isRecord(value.pricing.subscriptions)
    || !Array.isArray(value.pricing.creditPacks)
    || !isRecord(value.pricing.permanentUnlockResearchRanges)
    || !isRecord(value.exclusions)
    || !Array.isArray(value.exclusions.permanentlyFreeSplitMethods)
    || !Array.isArray(value.exclusions.randomizedOrUnclearedSplitMethods)
    || typeof value.exclusions.purchasedCreditChargingEnabled !== 'boolean') {
    return false;
  }
  return true;
};

const isAppleCommerce = (value: unknown): value is MonetizationAppleCommerce => {
  if (!isRecord(value)
    || typeof value.enabled !== 'boolean'
    || value.platform !== 'ios'
    || value.bundleId !== 'com.splitcircle.app'
    || value.appAppleId !== 6760814898
    || value.verificationCallable !== 'verifyAppleTransaction'
    || !isRecord(value.products)
    || !isRecord(value.products.subscriptions)
    || !Array.isArray(value.products.creditPacks)) {
    return false;
  }
  const products = value.products as Record<string, unknown>;
  const subscriptions = products.subscriptions as Record<string, unknown>;
  const creditPacks = products.creditPacks as unknown[];
  const subscriptionsValid = PAID_MONETIZATION_PLAN_IDS.every((planId) => {
    const product = subscriptions[planId];
    return isRecord(product)
      && typeof product.monthly === 'string'
      && product.monthly.length > 0
      && typeof product.annual === 'string'
      && product.annual.length > 0;
  });
  return subscriptionsValid && creditPacks.every((pack) => isRecord(pack)
    && typeof pack.productId === 'string'
    && pack.productId.length > 0
    && Number.isInteger(pack.credits)
    && (pack.credits as number) > 0);
};

export const isMonetizationSnapshot = (value: unknown): value is MonetizationSnapshot => {
  if (!isRecord(value)
    || value.schemaVersion !== MONETIZATION_SCHEMA_VERSION
    || !isFiniteNumber(value.serverTime)
    || !isCatalog(value.catalog)
    || !isRecord(value.account)
    || !isEnvironment(value.account.environment)
    || !isMonetizationPlanId(value.account.planId)
    || (value.account.planSource !== 'default_free' && value.account.planSource !== 'server_projection')
    || (value.account.creditBalance !== undefined
      && (!Number.isInteger(value.account.creditBalance) || (value.account.creditBalance as number) < 0))
    || (value.account.creditDebt !== undefined
      && (!Number.isInteger(value.account.creditDebt) || (value.account.creditDebt as number) < 0))
    || (value.account.validUntil !== undefined
      && value.account.validUntil !== null
      && !isFiniteNumber(value.account.validUntil))
    || (value.account.activeSubscriptionProductId !== undefined
      && value.account.activeSubscriptionProductId !== null
      && typeof value.account.activeSubscriptionProductId !== 'string')
    || (value.account.appAccountToken !== undefined
      && value.account.appAccountToken !== null
      && typeof value.account.appAccountToken !== 'string')
    || !isRecord(value.account.access)
    || (value.account.access.kind !== 'standard' && value.account.access.kind !== 'internal_test')
    || typeof value.account.access.commercialQuotaBypass !== 'boolean'
    || value.account.access.providerSafetyBypass !== false
    || (value.account.access.grantExpiresAt !== null
      && !isFiniteNumber(value.account.access.grantExpiresAt))
    || (value.account.access.grantId !== null && typeof value.account.access.grantId !== 'string')
    || (value.commerce !== undefined && !isAppleCommerce(value.commerce))
    || !isRecord(value.capabilities)
    || typeof value.capabilities.appleVerification !== 'boolean'
    || typeof value.capabilities.creditPurchases !== 'boolean'
    || typeof value.capabilities.creditSpending !== 'boolean'
    || typeof value.capabilities.offlineLeases !== 'boolean'
    || value.capabilities.friendGifting !== false
    || !isRecord(value.enforcement)
    || (value.enforcement.commercial !== 'shadow'
      && value.enforcement.commercial !== 'server_enforced')
    || typeof value.enforcement.blocksFeatures !== 'boolean'
    || value.enforcement.blocksFeatures !== (value.enforcement.commercial === 'server_enforced')) {
    return false;
  }
  return true;
};

export const isVerifyAppleTransactionResult = (
  value: unknown,
): value is VerifyAppleTransactionResult => isRecord(value)
  && value.verified === true
  && value.accepted === true
  && typeof value.duplicate === 'boolean'
  && value.finishTransaction === true
  && isEnvironment(value.environment)
  && typeof value.productId === 'string'
  && value.productId.length > 0
  && typeof value.transactionId === 'string'
  && value.transactionId.length > 0
  && typeof value.originalTransactionId === 'string'
  && value.originalTransactionId.length > 0
  && (value.purchaseKind === 'subscription' || value.purchaseKind === 'consumable_credits')
  && (value.planId === null || isMonetizationPlanId(value.planId))
  && (value.purchasedPlanId === null || isPaidMonetizationPlanId(value.purchasedPlanId))
  && (value.purchaseKind === 'subscription'
    ? value.planId !== null && value.purchasedPlanId !== null
    : value.planId === null && value.purchasedPlanId === null)
  && (value.validUntil === null || isFiniteNumber(value.validUntil))
  && (value.activeSubscriptionProductId === undefined
    || value.activeSubscriptionProductId === null
    || typeof value.activeSubscriptionProductId === 'string')
  && Number.isInteger(value.creditsGranted)
  && (value.creditsGranted as number) >= 0
  && Number.isInteger(value.creditBalance)
  && (value.creditBalance as number) >= 0
  && (value.creditDebt === undefined
    || (Number.isInteger(value.creditDebt) && (value.creditDebt as number) >= 0))
  && isFiniteNumber(value.serverTime);

const isOperationAccessSource = (value: unknown): value is MonetizedOperationAccessSource =>
  value === 'preview'
  || value === 'included_use'
  || value === 'unlimited'
  || value === 'internal_test'
  || value === 'measurement_only'
  || value === 'credits'
  || value === 'quota_exhausted';

export const isMonetizedOperationAuthorization = (
  value: unknown,
): value is MonetizedOperationAuthorization => isRecord(value)
  && value.schemaVersion === MONETIZATION_SCHEMA_VERSION
  && typeof value.allowed === 'boolean'
  && (value.authorizationId === null
    || (typeof value.authorizationId === 'string'
      && AUTHORIZATION_ID_PATTERN.test(value.authorizationId)))
  && isEnvironment(value.environment)
  && typeof value.featureId === 'string'
  && value.featureId.length > 0
  && isMonetizationPlanId(value.planId)
  && isOperationAccessSource(value.source)
  && typeof value.reasonCode === 'string'
  && (value.creditCost === null
    || (Number.isInteger(value.creditCost) && (value.creditCost as number) >= 0))
  && Number.isInteger(value.creditBalance)
  && (value.creditBalance as number) >= 0
  && (value.remaining === null
    || (Number.isInteger(value.remaining) && (value.remaining as number) >= 0))
  && (value.resetsAt === null || isFiniteNumber(value.resetsAt))
  && (!value.allowed || typeof value.authorizationId === 'string');

export const isFinalizeMonetizedOperationResult = (
  value: unknown,
): value is FinalizeMonetizedOperationResult => isRecord(value)
  && value.schemaVersion === MONETIZATION_SCHEMA_VERSION
  && value.accepted === true
  && typeof value.duplicate === 'boolean'
  && (value.outcome === 'completed'
    || value.outcome === 'failed'
    || value.outcome === 'cancelled'
    || value.outcome === 'abandoned')
  && Number.isInteger(value.creditBalance)
  && (value.creditBalance as number) >= 0
  && isFiniteNumber(value.serverTime);

export interface MonetizationFeatureUsage {
  featureId: MeteredFeatureId;
  label: string;
  unit: { one: string; other: string };
  rule: MonetizationQuotaRule;
  used: number;
  reserved: number;
  limit: number | null;
  remaining: number | null;
  windowStartMs: number | null;
  resetsAt: number | null;
  creditCost: number | null;
  previews: { variant: string; claimed: boolean }[] | null;
}

export interface MonetizationUsageDay {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  counts: Partial<Record<MeteredFeatureId, number>>;
  creditsSpent: number;
}

export interface MonetizationCreditLedgerItem {
  id: string;
  type: string;
  status: string;
  creditDelta: number;
  balanceAfter: number | null;
  featureId: MeteredFeatureId | null;
  productId: string | null;
  createdAt: number | null;
}

export interface MonetizationUsageSummary {
  schemaVersion: 1;
  serverTime: number;
  environment: MonetizationEnvironment;
  planId: MonetizationPlanId;
  validUntil: number | null;
  creditBalance: number;
  creditDebt: number;
  access: {
    kind: 'standard' | 'internal_test';
    commercialQuotaBypass: boolean;
    grantExpiresAt: number | null;
  };
  features: MonetizationFeatureUsage[];
  daily: MonetizationUsageDay[];
  ledger: MonetizationCreditLedgerItem[];
}

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

const isNullableFinite = (value: unknown): boolean => value === null || isFiniteNumber(value);

const isFeatureUsage = (value: unknown): value is MonetizationFeatureUsage => isRecord(value)
  && typeof value.featureId === 'string'
  && typeof value.label === 'string'
  && isRecord(value.unit)
  && typeof value.unit.one === 'string'
  && typeof value.unit.other === 'string'
  && isQuotaRule(value.rule)
  && isNonNegativeInteger(value.used)
  && isNonNegativeInteger(value.reserved)
  && (value.limit === null || isNonNegativeInteger(value.limit))
  && (value.remaining === null || isNonNegativeInteger(value.remaining))
  && isNullableFinite(value.windowStartMs)
  && isNullableFinite(value.resetsAt)
  && (value.creditCost === null || isNonNegativeInteger(value.creditCost))
  && (value.previews === null || (Array.isArray(value.previews) && value.previews.every(
    (preview) => isRecord(preview) && typeof preview.variant === 'string' && typeof preview.claimed === 'boolean',
  )));

const isUsageDay = (value: unknown): value is MonetizationUsageDay => isRecord(value)
  && typeof value.day === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value.day)
  && isRecord(value.counts)
  && Object.values(value.counts).every(isNonNegativeInteger)
  && isNonNegativeInteger(value.creditsSpent);

const isLedgerItem = (value: unknown): value is MonetizationCreditLedgerItem => isRecord(value)
  && typeof value.id === 'string'
  && typeof value.type === 'string'
  && typeof value.status === 'string'
  && Number.isInteger(value.creditDelta)
  && isNullableFinite(value.balanceAfter)
  && (value.featureId === null || typeof value.featureId === 'string')
  && (value.productId === null || typeof value.productId === 'string')
  && isNullableFinite(value.createdAt);

export const isMonetizationUsageSummary = (value: unknown): value is MonetizationUsageSummary =>
  isRecord(value)
  && value.schemaVersion === MONETIZATION_SCHEMA_VERSION
  && isFiniteNumber(value.serverTime)
  && isEnvironment(value.environment)
  && isMonetizationPlanId(value.planId)
  && isNullableFinite(value.validUntil)
  && isNonNegativeInteger(value.creditBalance)
  && isNonNegativeInteger(value.creditDebt)
  && isRecord(value.access)
  && (value.access.kind === 'standard' || value.access.kind === 'internal_test')
  && typeof value.access.commercialQuotaBypass === 'boolean'
  && isNullableFinite(value.access.grantExpiresAt)
  && Array.isArray(value.features) && value.features.every(isFeatureUsage)
  && Array.isArray(value.daily) && value.daily.every(isUsageDay)
  && Array.isArray(value.ledger) && value.ledger.every(isLedgerItem);
