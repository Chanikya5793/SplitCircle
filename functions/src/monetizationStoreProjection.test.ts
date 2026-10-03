import { describe, expect, it } from "vitest";
import { APPLE_SUBSCRIPTION_PRODUCTS } from "./commerceCatalog";
import {
    projectActivePlan,
    type StoredSubscriptionEntitlement,
} from "./monetizationStore";

const NOW_MS = Date.parse("2026-09-27T12:00:00.000Z");

function entitlement(
    productId: string,
    planId: StoredSubscriptionEntitlement["planId"],
    expiresAtMs: number,
): StoredSubscriptionEntitlement {
    return {
        productId,
        planId,
        originalTransactionId: `${productId}.original`,
        latestTransactionId: `${productId}.latest`,
        purchaseDateMs: NOW_MS - 1_000,
        expiresAtMs,
        revokedAtMs: null,
        isUpgraded: false,
        environment: "sandbox",
        updatedAtMs: NOW_MS,
    };
}

describe("active subscription projection", () => {
    it("reports the exact product that supplies the highest active tier", () => {
        const result = projectActivePlan({
            lower: entitlement(
                APPLE_SUBSCRIPTION_PRODUCTS.essential.annual,
                "essential",
                NOW_MS + 365 * 24 * 60 * 60 * 1_000,
            ),
            higher: entitlement(
                APPLE_SUBSCRIPTION_PRODUCTS.pro.monthly,
                "pro",
                NOW_MS + 30 * 24 * 60 * 60 * 1_000,
            ),
        }, NOW_MS);

        expect(result).toEqual({
            planId: "pro",
            validUntilMs: NOW_MS + 30 * 24 * 60 * 60 * 1_000,
            activeSubscriptionProductId: APPLE_SUBSCRIPTION_PRODUCTS.pro.monthly,
        });
    });

    it("uses the later expiration to choose between products for the same tier", () => {
        const result = projectActivePlan({
            monthly: entitlement(
                APPLE_SUBSCRIPTION_PRODUCTS.pro.monthly,
                "pro",
                NOW_MS + 10_000,
            ),
            annual: entitlement(
                APPLE_SUBSCRIPTION_PRODUCTS.pro.annual,
                "pro",
                NOW_MS + 20_000,
            ),
        }, NOW_MS);

        expect(result.activeSubscriptionProductId).toBe(
            APPLE_SUBSCRIPTION_PRODUCTS.pro.annual,
        );
        expect(result.validUntilMs).toBe(NOW_MS + 20_000);
    });
});
