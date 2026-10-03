import { X509Certificate } from "node:crypto";
import {
    Environment,
    InAppOwnershipType,
    Type,
    VerificationException,
    VerificationStatus,
    type JWSTransactionDecodedPayload,
    type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";
import { describe, expect, it, vi } from "vitest";

import {
    AppleCommerceVerificationError,
    loadAppleRootCertificates,
    validateAppleTransactionPayload,
    verifyApplePurchaseTransaction,
    verifyAppleServerNotification,
} from "./appleCommerceVerification";
import {
    APPLE_APP_ID,
    APPLE_BUNDLE_ID,
    APPLE_CREDIT_PACKS,
    APPLE_SUBSCRIPTION_PRODUCTS,
} from "./commerceCatalog";

const NOW_MS = 1_800_000_000_000;
const ACCOUNT_TOKEN = "7927c9a0-f27e-4bee-89a0-80879f5dbf13";
const TRANSACTION_ID = "2000000999999999";
const COMPACT_JWS = "eyJhbGciOiJFUzI1NiJ9.e30.AA";

function subscriptionTransaction(
    overrides: Partial<JWSTransactionDecodedPayload> = {},
): JWSTransactionDecodedPayload {
    return {
        originalTransactionId: "2000000888888888",
        transactionId: TRANSACTION_ID,
        bundleId: APPLE_BUNDLE_ID,
        productId: APPLE_SUBSCRIPTION_PRODUCTS.max.monthly,
        purchaseDate: NOW_MS - 60_000,
        originalPurchaseDate: NOW_MS - 60_000,
        expiresDate: NOW_MS + 30 * 24 * 60 * 60 * 1000,
        quantity: 1,
        type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
        appAccountToken: ACCOUNT_TOKEN,
        inAppOwnershipType: InAppOwnershipType.PURCHASED,
        signedDate: NOW_MS - 1_000,
        environment: Environment.SANDBOX,
        ...overrides,
    };
}

function expectCode(run: () => unknown, code: string): void {
    try {
        run();
        throw new Error("Expected validation to fail.");
    } catch (error) {
        expect(error).toBeInstanceOf(AppleCommerceVerificationError);
        expect((error as AppleCommerceVerificationError).code).toBe(code);
    }
}

describe("Apple commerce verification", () => {
    it("loads only the three pinned Apple DER trust anchors", () => {
        const roots = loadAppleRootCertificates();
        expect(roots).toHaveLength(3);
        expect(roots.map((root) => new X509Certificate(root).fingerprint256)).toEqual([
            "B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24",
            "C2:B9:B0:42:DD:57:83:0E:7D:11:7D:AC:55:AC:8A:E1:94:07:D3:8E:41:D8:8F:32:15:BC:3A:89:04:44:A0:50",
            "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79",
        ]);
    });

    it("accepts an exact, active catalog subscription", () => {
        const result = validateAppleTransactionPayload(subscriptionTransaction(), {
            environment: "sandbox",
            productId: APPLE_SUBSCRIPTION_PRODUCTS.max.monthly,
            transactionId: TRANSACTION_ID,
            appAccountToken: ACCOUNT_TOKEN,
            requireActive: true,
            nowMs: NOW_MS,
        });

        expect(result.product).toMatchObject({ kind: "subscription", planId: "max" });
        expect(result.isExpired).toBe(false);
        expect(result.isRevoked).toBe(false);
    });

    it("rejects account-token mismatch, expiry, revocation, quantity, and type changes", () => {
        expectCode(() => validateAppleTransactionPayload(subscriptionTransaction(), {
            environment: "sandbox",
            appAccountToken: "128fab4c-a5cc-4283-87e8-3ec7f367807a",
            nowMs: NOW_MS,
        }), "account_token_mismatch");

        expectCode(() => validateAppleTransactionPayload(subscriptionTransaction({
            expiresDate: NOW_MS - 1,
        }), {
            environment: "sandbox",
            requireActive: true,
            nowMs: NOW_MS,
        }), "expired");

        expectCode(() => validateAppleTransactionPayload(subscriptionTransaction({
            revocationDate: NOW_MS - 1,
        }), {
            environment: "sandbox",
            requireActive: true,
            nowMs: NOW_MS,
        }), "revoked");

        expectCode(() => validateAppleTransactionPayload(subscriptionTransaction({ quantity: 2 }), {
            environment: "sandbox",
            nowMs: NOW_MS,
        }), "invalid_quantity");

        expectCode(() => validateAppleTransactionPayload(subscriptionTransaction({
            type: Type.CONSUMABLE,
        }), {
            environment: "sandbox",
            nowMs: NOW_MS,
        }), "type_mismatch");
    });

    it("returns expired and revoked lifecycle state without granting an active purchase", () => {
        const result = validateAppleTransactionPayload(subscriptionTransaction({
            expiresDate: NOW_MS - 10,
            revocationDate: NOW_MS - 5,
        }), {
            environment: "sandbox",
            requireActive: false,
            nowMs: NOW_MS,
        });

        expect(result.isExpired).toBe(true);
        expect(result.isRevoked).toBe(true);
    });

    it("accepts only a one-unit consumable for a credit product", () => {
        const result = validateAppleTransactionPayload(subscriptionTransaction({
            productId: APPLE_CREDIT_PACKS[0].productId,
            type: Type.CONSUMABLE,
            expiresDate: undefined,
        }), {
            environment: "sandbox",
            requireActive: true,
            nowMs: NOW_MS,
        });

        expect(result.product).toMatchObject({
            kind: "consumable_credits",
            ...APPLE_CREDIT_PACKS[0],
        });
        expect(result.expiresDate).toBeNull();
    });

    it("verifies a purchase JWS before applying exact request validation", async () => {
        const verifyAndDecodeTransaction = vi.fn().mockResolvedValue(subscriptionTransaction());
        const result = await verifyApplePurchaseTransaction({
            signedTransactionInfo: COMPACT_JWS,
            environment: "sandbox",
            productId: APPLE_SUBSCRIPTION_PRODUCTS.max.monthly,
            transactionId: TRANSACTION_ID,
            appAccountToken: ACCOUNT_TOKEN,
            nowMs: NOW_MS,
        }, {
            verifier: { verifyAndDecodeTransaction },
        });

        expect(verifyAndDecodeTransaction).toHaveBeenCalledWith(COMPACT_JWS);
        expect(result.transactionId).toBe(TRANSACTION_ID);
    });

    it("verifies the notification envelope and its nested transaction with one environment", async () => {
        const notification: ResponseBodyV2DecodedPayload = {
            notificationType: "DID_RENEW",
            notificationUUID: "41dd6c30-10c7-4d3e-b7b5-7c08bb8feee0",
            version: "2.0",
            signedDate: NOW_MS - 500,
            data: {
                environment: Environment.PRODUCTION,
                appAppleId: APPLE_APP_ID,
                bundleId: APPLE_BUNDLE_ID,
                signedTransactionInfo: COMPACT_JWS,
            },
        };
        const productionTransaction = subscriptionTransaction({
            environment: Environment.PRODUCTION,
        });
        const verifier = {
            verifyAndDecodeNotification: vi.fn().mockResolvedValue(notification),
            verifyAndDecodeTransaction: vi.fn().mockResolvedValue(productionTransaction),
            verifyAndDecodeRenewalInfo: vi.fn(),
        };

        const result = await verifyAppleServerNotification(
            COMPACT_JWS,
            "production",
            { verifier, nowMs: NOW_MS },
        );

        expect(result.environment).toBe("production");
        expect(result.transaction?.productId).toBe(APPLE_SUBSCRIPTION_PRODUCTS.max.monthly);
        expect(verifier.verifyAndDecodeTransaction).toHaveBeenCalledWith(COMPACT_JWS);
    });

    it("preserves retryable OCSP verification failures for HTTP retry handling", async () => {
        const verifier = {
            verifyAndDecodeNotification: vi.fn().mockRejectedValue(
                new VerificationException(VerificationStatus.RETRYABLE_VERIFICATION_FAILURE),
            ),
            verifyAndDecodeTransaction: vi.fn(),
            verifyAndDecodeRenewalInfo: vi.fn(),
        };

        await expect(verifyAppleServerNotification(
            COMPACT_JWS,
            "production",
            { verifier, nowMs: NOW_MS },
        )).rejects.toMatchObject({
            name: "AppleCommerceVerificationError",
            code: "retryable_verification_failed",
        });
    });

    it("preserves a verifier environment mismatch for targeted sandbox fallback", async () => {
        const verifier = {
            verifyAndDecodeNotification: vi.fn().mockRejectedValue(
                new VerificationException(VerificationStatus.INVALID_ENVIRONMENT),
            ),
            verifyAndDecodeTransaction: vi.fn(),
            verifyAndDecodeRenewalInfo: vi.fn(),
        };

        await expect(verifyAppleServerNotification(
            COMPACT_JWS,
            "production",
            { verifier, nowMs: NOW_MS },
        )).rejects.toMatchObject({
            name: "AppleCommerceVerificationError",
            code: "invalid_environment",
        });
    });
});
