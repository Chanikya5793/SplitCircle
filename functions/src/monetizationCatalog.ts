/** Server-owned commercial policy. StoreKit remains authoritative for price. */

import {
    APPLE_CREDIT_PACKS,
    APPLE_SUBSCRIPTION_PRODUCTS,
} from "./commerceCatalog";

export const MONETIZATION_SCHEMA_VERSION = 1 as const;
export const MONETIZATION_CATALOG_VERSION = "2026-09-06.commerce-v1" as const;

export const PLAN_IDS = ["free", "essential", "plus", "pro", "power", "max"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const MONETIZATION_ENVIRONMENTS = ["sandbox", "production"] as const;
export type MonetizationEnvironment = (typeof MONETIZATION_ENVIRONMENTS)[number];

export const EXECUTION_ROUTES = [
    "local_deterministic",
    "on_device_apple",
    "provider",
    "server",
] as const;
export type ExecutionRoute = (typeof EXECUTION_ROUTES)[number];

export type CostClass =
    | "deterministic_local"
    | "apple_device_capability"
    | "provider_variable"
    | "persistent_infrastructure";

export type QuotaCadence = "day" | "week" | "month";

export type QuotaRule =
    | { kind: "metered"; limit: number; cadence: QuotaCadence }
    | { kind: "unlimited_local" }
    | { kind: "measure_only"; cadence: QuotaCadence };

export type PlanQuotas = Record<PlanId, QuotaRule>;

export const ADVANCED_SPLIT_VARIANTS = [
    "itemized",
    "income",
    "consumption",
    "timeBased",
    "itemType",
] as const;
export type AdvancedSplitVariant = (typeof ADVANCED_SPLIT_VARIANTS)[number];

export const METERED_FEATURE_IDS = [
    "advanced_split.completion",
    "insights.advanced_report",
    "ai.expense_on_device_turn",
    "provider.ai_or_ocr_job",
    "provider.security_check",
    "provider.manual_monitor_run",
] as const;
export type MeteredFeatureId = (typeof METERED_FEATURE_IDS)[number];

export interface MeteredFeatureDefinition {
    id: MeteredFeatureId;
    label: string;
    quotaKey: string;
    costClass: CostClass;
    allowedExecutionRoutes: readonly ExecutionRoute[];
    quotaByPlan: PlanQuotas;
    creditCost: number | null;
    variants?: readonly string[];
    freePreview?: {
        kind: "per_variant_lifetime";
        count: 1;
    };
}

const monthlyLocalQuotas: PlanQuotas = {
    free: { kind: "metered", limit: 3, cadence: "week" },
    essential: { kind: "metered", limit: 20, cadence: "month" },
    plus: { kind: "metered", limit: 75, cadence: "month" },
    pro: { kind: "metered", limit: 250, cadence: "month" },
    power: { kind: "metered", limit: 1_000, cadence: "month" },
    max: { kind: "unlimited_local" },
};

export const METERED_FEATURES: Record<MeteredFeatureId, MeteredFeatureDefinition> = {
    "advanced_split.completion": {
        id: "advanced_split.completion",
        label: "Eligible advanced split completion",
        quotaKey: "advanced_split.completion",
        costClass: "deterministic_local",
        allowedExecutionRoutes: ["local_deterministic"],
        variants: ADVANCED_SPLIT_VARIANTS,
        freePreview: { kind: "per_variant_lifetime", count: 1 },
        quotaByPlan: monthlyLocalQuotas,
        creditCost: 1,
    },
    "insights.advanced_report": {
        id: "insights.advanced_report",
        label: "Generated advanced local report",
        quotaKey: "insights.advanced_report",
        costClass: "deterministic_local",
        allowedExecutionRoutes: ["local_deterministic", "on_device_apple"],
        quotaByPlan: monthlyLocalQuotas,
        creditCost: 1,
    },
    "ai.expense_on_device_turn": {
        id: "ai.expense_on_device_turn",
        label: "On-device expense assistant turn",
        quotaKey: "ai.expense_on_device_turn",
        costClass: "apple_device_capability",
        allowedExecutionRoutes: ["on_device_apple"],
        quotaByPlan: {
            free: { kind: "metered", limit: 3, cadence: "day" },
            essential: { kind: "metered", limit: 30, cadence: "month" },
            plus: { kind: "metered", limit: 100, cadence: "month" },
            pro: { kind: "metered", limit: 400, cadence: "month" },
            power: { kind: "metered", limit: 1_500, cadence: "month" },
            max: { kind: "unlimited_local" },
        },
        // On-device turns have no continuing provider cost. A future pricing
        // experiment can still test value, but credit charging stays disabled.
        creditCost: null,
    },
    "provider.ai_or_ocr_job": {
        id: "provider.ai_or_ocr_job",
        label: "Provider-backed AI or OCR job",
        quotaKey: "provider.ai_or_ocr_job",
        costClass: "provider_variable",
        allowedExecutionRoutes: ["provider"],
        quotaByPlan: {
            free: { kind: "metered", limit: 1, cadence: "week" },
            essential: { kind: "metered", limit: 5, cadence: "month" },
            plus: { kind: "metered", limit: 20, cadence: "month" },
            pro: { kind: "metered", limit: 75, cadence: "month" },
            power: { kind: "metered", limit: 250, cadence: "month" },
            max: { kind: "metered", limit: 500, cadence: "month" },
        },
        creditCost: 4,
    },
    "provider.security_check": {
        id: "provider.security_check",
        label: "Provider-backed security check",
        quotaKey: "provider.security_check",
        costClass: "provider_variable",
        allowedExecutionRoutes: ["provider"],
        quotaByPlan: {
            free: { kind: "metered", limit: 3, cadence: "day" },
            essential: { kind: "metered", limit: 15, cadence: "day" },
            plus: { kind: "metered", limit: 50, cadence: "day" },
            pro: { kind: "metered", limit: 200, cadence: "day" },
            power: { kind: "metered", limit: 750, cadence: "day" },
            max: { kind: "metered", limit: 1_500, cadence: "day" },
        },
        creditCost: 2,
    },
    "provider.manual_monitor_run": {
        id: "provider.manual_monitor_run",
        label: "Manual provider-backed monitoring run",
        quotaKey: "provider.manual_monitor_run",
        costClass: "provider_variable",
        allowedExecutionRoutes: ["provider"],
        quotaByPlan: {
            free: { kind: "metered", limit: 1, cadence: "week" },
            essential: { kind: "metered", limit: 4, cadence: "month" },
            plus: { kind: "metered", limit: 15, cadence: "month" },
            pro: { kind: "metered", limit: 50, cadence: "month" },
            power: { kind: "metered", limit: 150, cadence: "month" },
            max: { kind: "metered", limit: 300, cadence: "month" },
        },
        creditCost: 10,
    },
};

export const MONETIZATION_CATALOG = {
    schemaVersion: MONETIZATION_SCHEMA_VERSION,
    version: MONETIZATION_CATALOG_VERSION,
    status: "active" as const,
    enforcementMode: "enforced" as const,
    telemetry: {
        trust: "server_authoritative" as const,
        appCheckEnforced: false,
        eligibleForBillingOrEnforcement: true,
    },
    plans: {
        free: { label: "Free", storefrontStatus: "not_for_sale" as const },
        essential: { label: "Essential", storefrontStatus: "storefront" as const },
        plus: { label: "Plus", storefrontStatus: "storefront" as const },
        pro: { label: "Pro", storefrontStatus: "storefront" as const },
        power: { label: "Power", storefrontStatus: "storefront" as const },
        max: { label: "Max", storefrontStatus: "storefront" as const },
    },
    // Only features with a complete server-side enforcement boundary are
    // published to purchasing clients. The remaining definitions stay
    // available to privacy-safe shadow telemetry until their call sites are
    // wired end to end.
    features: {
        "advanced_split.completion": METERED_FEATURES["advanced_split.completion"],
    },
    capacities: {
        premiumSavedLooks: {
            free: 0,
            essential: 3,
            plus: 10,
            pro: 25,
            power: 100,
            max: null,
        },
        premiumAppearanceCollections: {
            free: "rotating_preview",
            essential: 2,
            plus: 5,
            pro: 10,
            power: "all_current",
            max: "all_current_and_future_while_subscribed",
        },
    },
    pricing: {
        status: "storefront" as const,
        currency: "USD" as const,
        checkoutDisplayAllowed: true,
        localizedStorefrontPriceRequired: true,
        subscriptions: {
            essential: {
                monthlyMinor: 299,
                annualMinor: 2_499,
                monthlyProductId: APPLE_SUBSCRIPTION_PRODUCTS.essential.monthly,
                annualProductId: APPLE_SUBSCRIPTION_PRODUCTS.essential.annual,
            },
            plus: {
                monthlyMinor: 499,
                annualMinor: 3_999,
                monthlyProductId: APPLE_SUBSCRIPTION_PRODUCTS.plus.monthly,
                annualProductId: APPLE_SUBSCRIPTION_PRODUCTS.plus.annual,
            },
            pro: {
                monthlyMinor: 899,
                annualMinor: 6_999,
                monthlyProductId: APPLE_SUBSCRIPTION_PRODUCTS.pro.monthly,
                annualProductId: APPLE_SUBSCRIPTION_PRODUCTS.pro.annual,
            },
            power: {
                monthlyMinor: 1_499,
                annualMinor: 11_999,
                monthlyProductId: APPLE_SUBSCRIPTION_PRODUCTS.power.monthly,
                annualProductId: APPLE_SUBSCRIPTION_PRODUCTS.power.annual,
            },
            max: {
                monthlyMinor: 2_499,
                annualMinor: 19_999,
                monthlyProductId: APPLE_SUBSCRIPTION_PRODUCTS.max.monthly,
                annualProductId: APPLE_SUBSCRIPTION_PRODUCTS.max.annual,
            },
        },
        creditPacks: APPLE_CREDIT_PACKS,
        permanentUnlockResearchRanges: {
            fairSplitToolkit: { minimumMinor: 1_499, maximumMinor: 1_999 },
            receiptBuilder: { minimumMinor: 799, maximumMinor: 1_299 },
            completeAdvancedToolkit: { minimumMinor: 2_499, maximumMinor: 2_999 },
            appearanceCollectionPass: { minimumMinor: 999, maximumMinor: 1_499 },
            insightsLab: { minimumMinor: 1_499, maximumMinor: 2_499 },
        },
    },
    exclusions: {
        permanentlyFreeSplitMethods: ["equal", "exact", "percentage", "shares", "adjustment"],
        randomizedOrUnclearedSplitMethods: ["roulette", "weightedRoulette", "scrooge"],
        purchasedCreditChargingEnabled: true,
    },
} as const;

export function isPlanId(value: unknown): value is PlanId {
    return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

export function isMeteredFeatureId(value: unknown): value is MeteredFeatureId {
    return typeof value === "string" && (METERED_FEATURE_IDS as readonly string[]).includes(value);
}

export function isMonetizationEnvironment(value: unknown): value is MonetizationEnvironment {
    return typeof value === "string" && (MONETIZATION_ENVIRONMENTS as readonly string[]).includes(value);
}

export function isExecutionRoute(value: unknown): value is ExecutionRoute {
    return typeof value === "string" && (EXECUTION_ROUTES as readonly string[]).includes(value);
}
