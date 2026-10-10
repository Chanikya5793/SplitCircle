/** Server-owned commercial policy. StoreKit remains authoritative for price. */

import {
    APPLE_CREDIT_PACKS,
    APPLE_SUBSCRIPTION_PRODUCTS,
} from "./commerceCatalog";

export const MONETIZATION_SCHEMA_VERSION = 1 as const;
export const MONETIZATION_CATALOG_VERSION = "2026-10-09.usage-v2" as const;

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

/**
 * Where the quota is enforced.
 * - client_authorized: the work runs on the device (local math, Apple
 *   Foundation Models), so the app must obtain a server reservation first.
 * - server_internal: the work runs on our servers or a paid provider, so the
 *   callable that does the work authorizes and finalizes it itself and the
 *   client cannot reserve it directly.
 */
export type MeteredEnforcement = "client_authorized" | "server_internal";

export interface MeteredFeatureDefinition {
    id: MeteredFeatureId;
    /** Short user-facing name, e.g. "AI assistant messages". */
    label: string;
    /** Singular and plural nouns for one completed use. */
    unit: { one: string; other: string };
    enforcement: MeteredEnforcement;
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
        label: "Advanced splits",
        unit: { one: "split", other: "splits" },
        enforcement: "client_authorized",
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
        label: "AI insight reports",
        unit: { one: "report", other: "reports" },
        enforcement: "client_authorized",
        quotaKey: "insights.advanced_report",
        costClass: "deterministic_local",
        allowedExecutionRoutes: ["local_deterministic", "on_device_apple"],
        quotaByPlan: monthlyLocalQuotas,
        creditCost: 1,
    },
    "ai.expense_on_device_turn": {
        id: "ai.expense_on_device_turn",
        label: "AI assistant messages",
        unit: { one: "message", other: "messages" },
        enforcement: "client_authorized",
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
        label: "Cloud AI jobs",
        unit: { one: "job", other: "jobs" },
        enforcement: "server_internal",
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
        label: "Link safety checks",
        unit: { one: "check", other: "checks" },
        enforcement: "server_internal",
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
        label: "Manual security scans",
        unit: { one: "scan", other: "scans" },
        enforcement: "server_internal",
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
    // Only features with a live call path AND a complete enforcement boundary
    // are published. "provider.ai_or_ocr_job" stays unpublished: nothing in
    // the app calls a cloud AI/OCR provider today, and advertising an
    // allowance for a feature that does not exist would mislead people.
    features: {
        "advanced_split.completion": METERED_FEATURES["advanced_split.completion"],
        "ai.expense_on_device_turn": METERED_FEATURES["ai.expense_on_device_turn"],
        "insights.advanced_report": METERED_FEATURES["insights.advanced_report"],
        "provider.security_check": METERED_FEATURES["provider.security_check"],
        "provider.manual_monitor_run": METERED_FEATURES["provider.manual_monitor_run"],
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

export const PUBLISHED_FEATURE_IDS = Object.keys(MONETIZATION_CATALOG.features) as MeteredFeatureId[];

/** Features the app may reserve directly through authorizeMonetizedOperation. */
export const CLIENT_AUTHORIZED_FEATURE_IDS = PUBLISHED_FEATURE_IDS
    .filter((id) => METERED_FEATURES[id].enforcement === "client_authorized");

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
