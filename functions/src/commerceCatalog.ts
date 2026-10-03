import type { PlanId } from "./monetizationCatalog";

/**
 * Immutable App Store identifiers for the first commerce schema.
 *
 * These identifiers are server-owned. The client may request StoreKit
 * products with them, but a purchase is accepted only after the signed Apple
 * transaction independently resolves to the same catalog entry.
 */
export const APPLE_BUNDLE_ID = "com.splitcircle.app" as const;
export const APPLE_APP_ID = 6_760_814_898 as const;

export const PAID_PLAN_IDS = ["essential", "plus", "pro", "power", "max"] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];
export type SubscriptionPeriod = "monthly" | "annual";

export const APPLE_SUBSCRIPTION_PRODUCTS = {
    essential: {
        monthly: "com.splitcircle.app.subscription.essential.monthly.v1",
        annual: "com.splitcircle.app.subscription.essential.annual.v1",
    },
    plus: {
        monthly: "com.splitcircle.app.subscription.plus.monthly.v1",
        annual: "com.splitcircle.app.subscription.plus.annual.v1",
    },
    pro: {
        monthly: "com.splitcircle.app.subscription.pro.monthly.v1",
        annual: "com.splitcircle.app.subscription.pro.annual.v1",
    },
    power: {
        monthly: "com.splitcircle.app.subscription.power.monthly.v1",
        annual: "com.splitcircle.app.subscription.power.annual.v1",
    },
    max: {
        monthly: "com.splitcircle.app.subscription.max.monthly.v1",
        annual: "com.splitcircle.app.subscription.max.annual.v1",
    },
} as const satisfies Record<PaidPlanId, Record<SubscriptionPeriod, string>>;

export const APPLE_CREDIT_PACKS = [
    { productId: "com.splitcircle.app.credits.25.v1", credits: 25 },
    { productId: "com.splitcircle.app.credits.80.v1", credits: 80 },
    { productId: "com.splitcircle.app.credits.200.v1", credits: 200 },
    { productId: "com.splitcircle.app.credits.500.v1", credits: 500 },
] as const;

export type AppleSubscriptionProduct = {
    kind: "subscription";
    productId: string;
    planId: PaidPlanId;
    period: SubscriptionPeriod;
};

export type AppleCreditProduct = {
    kind: "consumable_credits";
    productId: string;
    credits: number;
};

export type AppleProduct = AppleSubscriptionProduct | AppleCreditProduct;

const productEntries: AppleProduct[] = [
    ...PAID_PLAN_IDS.flatMap((planId) => ([
        {
            kind: "subscription" as const,
            productId: APPLE_SUBSCRIPTION_PRODUCTS[planId].monthly,
            planId,
            period: "monthly" as const,
        },
        {
            kind: "subscription" as const,
            productId: APPLE_SUBSCRIPTION_PRODUCTS[planId].annual,
            planId,
            period: "annual" as const,
        },
    ])),
    ...APPLE_CREDIT_PACKS.map((pack) => ({
        kind: "consumable_credits" as const,
        productId: pack.productId,
        credits: pack.credits,
    })),
];

const APPLE_PRODUCT_BY_ID = new Map(productEntries.map((product) => [product.productId, product]));

export function getAppleProduct(productId: unknown): AppleProduct | null {
    if (typeof productId !== "string") return null;
    return APPLE_PRODUCT_BY_ID.get(productId) ?? null;
}

export function isPaidPlanId(value: unknown): value is PaidPlanId {
    return typeof value === "string" && (PAID_PLAN_IDS as readonly string[]).includes(value);
}

export const PLAN_PRIORITY: Readonly<Record<PlanId, number>> = {
    free: 0,
    essential: 1,
    plus: 2,
    pro: 3,
    power: 4,
    max: 5,
};

export const APPLE_COMMERCE_PUBLIC_CATALOG = {
    platform: "ios" as const,
    bundleId: APPLE_BUNDLE_ID,
    appAppleId: APPLE_APP_ID,
    verificationCallable: "verifyAppleTransaction" as const,
    products: {
        subscriptions: APPLE_SUBSCRIPTION_PRODUCTS,
        creditPacks: APPLE_CREDIT_PACKS,
    },
} as const;
