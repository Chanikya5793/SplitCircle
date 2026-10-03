import {
    Environment,
    InAppOwnershipType,
    Type,
    type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    applyVerifiedAppleNotification,
    applyVerifiedApplePurchase,
} from "./appleCommerce";
import {
    validateAppleTransactionPayload,
    type VerifiedAppleServerNotification,
} from "./appleCommerceVerification";
import {
    APPLE_BUNDLE_ID,
    APPLE_CREDIT_PACKS,
    APPLE_SUBSCRIPTION_PRODUCTS,
} from "./commerceCatalog";
import { monetizationAccountDocumentId } from "./monetizationCore";
import {
    MONETIZATION_APPLE_NOTIFICATION_COLLECTION,
    MONETIZATION_APPLE_ORIGINAL_TRANSACTION_COLLECTION,
    MONETIZATION_APPLE_TRANSACTION_COLLECTION,
    appleAccountTokenDocumentId,
    appleNotificationDocumentId,
    appleOriginalTransactionDocumentId,
    appleTransactionDocumentId,
    ensureMonetizationAccount,
} from "./monetizationStore";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = emulatorHost ? describe : describe.skip;
const PROJECT_ID = "manasplit-apple-ledger-test";
const NOW_MS = Date.parse("2026-09-07T15:00:00.000Z");

describeWithEmulator("Apple entitlement and credit ledger", () => {
    const adminApp = initializeApp({ projectId: PROJECT_ID }, "apple-ledger-test");
    const db = getFirestore(adminApp);
    const uid = "apple-ledger-user";
    let appAccountToken = "";

    beforeAll(async () => {
        await db.recursiveDelete(db.collection("monetizationAccountStates"));
        await db.recursiveDelete(db.collection("monetizationUsageAccounts"));
        await db.recursiveDelete(db.collection("monetizationAppleAccountTokens"));
        await db.recursiveDelete(db.collection("monetizationAppleTransactions"));
        await db.recursiveDelete(db.collection("monetizationAppleOriginalTransactions"));
        await db.recursiveDelete(db.collection("monetizationAppleNotifications"));
        appAccountToken = (await ensureMonetizationAccount({
            uid,
            environment: "sandbox",
            db,
        })).appAccountToken;
    });

    afterAll(async () => {
        await deleteApp(adminApp);
    });

    const decoded = (overrides: Record<string, unknown> = {}) => ({
        originalTransactionId: "2000000111111111",
        transactionId: "2000000222222222",
        bundleId: APPLE_BUNDLE_ID,
        productId: APPLE_CREDIT_PACKS[0].productId,
        purchaseDate: NOW_MS - 10_000,
        originalPurchaseDate: NOW_MS - 10_000,
        quantity: 1,
        type: Type.CONSUMABLE,
        appAccountToken,
        inAppOwnershipType: InAppOwnershipType.PURCHASED,
        signedDate: NOW_MS - 1_000,
        environment: Environment.SANDBOX,
        ...overrides,
    });

    it("grants a consumable exactly once and reverses a verified revocation", async () => {
        const verified = validateAppleTransactionPayload(decoded(), {
            environment: "sandbox",
            requireActive: true,
            nowMs: NOW_MS,
        });
        const first = await applyVerifiedApplePurchase({ uid, verified, nowMs: NOW_MS, db });
        expect(first).toMatchObject({
            duplicate: false,
            purchaseKind: "consumable_credits",
            creditsGranted: 25,
            creditBalance: 25,
        });
        const retry = await applyVerifiedApplePurchase({ uid, verified, nowMs: NOW_MS, db });
        expect(retry).toMatchObject({ duplicate: true, creditsGranted: 0, creditBalance: 25 });

        const revoked = validateAppleTransactionPayload(decoded({
            signedDate: NOW_MS + 1_000,
            revocationDate: NOW_MS,
        }), {
            environment: "sandbox",
            requireActive: false,
            nowMs: NOW_MS + 2_000,
        });
        const notification: VerifiedAppleServerNotification = {
            environment: "sandbox",
            decoded: {
                notificationUUID: "4319fd7f-18a9-4285-8954-fb0d0a3f0a38",
                notificationType: "REFUND",
                version: "2.0",
                signedDate: NOW_MS + 1_000,
            } as ResponseBodyV2DecodedPayload,
            transaction: revoked,
            renewalInfo: null,
        };
        expect(await applyVerifiedAppleNotification({
            notification,
            nowMs: NOW_MS + 2_000,
            db,
        })).toEqual({ duplicate: false, applied: true });
        const account = await ensureMonetizationAccount({ uid, environment: "sandbox", db });
        expect(account).toMatchObject({ creditBalance: 0, creditDebt: 0 });
        expect(await applyVerifiedAppleNotification({
            notification,
            nowMs: NOW_MS + 2_000,
            db,
        })).toEqual({ duplicate: true, applied: true });
    });

    it("reuses one Apple account token across production and sandbox ledgers", async () => {
        const sharedUid = "apple-shared-token-user";
        const production = await ensureMonetizationAccount({
            uid: sharedUid,
            environment: "production",
            db,
        });
        const sandbox = await ensureMonetizationAccount({
            uid: sharedUid,
            environment: "sandbox",
            db,
        });

        expect(sandbox.appAccountToken).toBe(production.appAccountToken);
        const sandboxBinding = await db.collection("monetizationAppleAccountTokens")
            .doc(appleAccountTokenDocumentId("sandbox", sandbox.appAccountToken))
            .get();
        expect(sandboxBinding.data()).toMatchObject({
            accountDocumentId: monetizationAccountDocumentId("sandbox", sharedUid),
            environment: "sandbox",
        });
    });

    it("binds an early sandbox notification from the trusted production token", async () => {
        const notificationUid = "apple-cross-environment-notification-user";
        const production = await ensureMonetizationAccount({
            uid: notificationUid,
            environment: "production",
            db,
        });
        const verified = validateAppleTransactionPayload(decoded({
            originalTransactionId: "2000000999999971",
            transactionId: "2000000999999972",
            appAccountToken: production.appAccountToken,
            productId: APPLE_SUBSCRIPTION_PRODUCTS.plus.monthly,
            type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
            expiresDate: NOW_MS + 30 * 24 * 60 * 60 * 1_000,
        }), {
            environment: "sandbox",
            requireActive: false,
            nowMs: NOW_MS,
        });
        const notification: VerifiedAppleServerNotification = {
            environment: "sandbox",
            decoded: {
                notificationUUID: "4e959d48-460a-44e1-9246-adba38288029",
                notificationType: "DID_RENEW",
                version: "2.0",
                signedDate: NOW_MS,
            } as ResponseBodyV2DecodedPayload,
            transaction: verified,
            renewalInfo: null,
        };

        expect(await applyVerifiedAppleNotification({ notification, nowMs: NOW_MS, db }))
            .toEqual({ duplicate: false, applied: true });
        const sandbox = await ensureMonetizationAccount({
            uid: notificationUid,
            environment: "sandbox",
            db,
        });
        expect(sandbox).toMatchObject({
            appAccountToken: production.appAccountToken,
            planId: "plus",
            activeSubscriptionProductId: APPLE_SUBSCRIPTION_PRODUCTS.plus.monthly,
        });
    });

    it("projects the highest active subscription from a verified transaction", async () => {
        const verified = validateAppleTransactionPayload(decoded({
            originalTransactionId: "2000000333333333",
            transactionId: "2000000444444444",
            productId: APPLE_SUBSCRIPTION_PRODUCTS.max.monthly,
            type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
            expiresDate: NOW_MS + 30 * 24 * 60 * 60 * 1_000,
            signedDate: NOW_MS,
        }), {
            environment: "sandbox",
            requireActive: true,
            nowMs: NOW_MS,
        });
        const result = await applyVerifiedApplePurchase({ uid, verified, nowMs: NOW_MS, db });
        expect(result).toMatchObject({
            duplicate: false,
            purchaseKind: "subscription",
            planId: "max",
            purchasedPlanId: "max",
            activeSubscriptionProductId: APPLE_SUBSCRIPTION_PRODUCTS.max.monthly,
            creditBalance: 0,
        });
        expect(result.validUntil).toBe(NOW_MS + 30 * 24 * 60 * 60 * 1_000);
    });

    it("reports the exact purchased plan separately from a higher active projection", async () => {
        const account = await ensureMonetizationAccount({ uid, environment: "sandbox", db });
        const verified = validateAppleTransactionPayload(decoded({
            originalTransactionId: "2000000999999991",
            transactionId: "2000000999999992",
            appAccountToken: account.appAccountToken,
            productId: APPLE_SUBSCRIPTION_PRODUCTS.essential.monthly,
            type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
            purchaseDate: NOW_MS + 1_000,
            originalPurchaseDate: NOW_MS + 1_000,
            expiresDate: NOW_MS + 20 * 24 * 60 * 60 * 1_000,
            signedDate: NOW_MS + 1_000,
        }), {
            environment: "sandbox",
            requireActive: true,
            nowMs: NOW_MS + 2_000,
        });

        const result = await applyVerifiedApplePurchase({
            uid,
            verified,
            nowMs: NOW_MS + 2_000,
            db,
        });

        expect(result).toMatchObject({
            purchaseKind: "subscription",
            planId: "max",
            purchasedPlanId: "essential",
            activeSubscriptionProductId: APPLE_SUBSCRIPTION_PRODUCTS.max.monthly,
        });
    });

    it("does not let a late older renewal overwrite a newer subscription transaction", async () => {
        const orderingUid = "apple-subscription-ordering-user";
        const orderingAccount = await ensureMonetizationAccount({
            uid: orderingUid,
            environment: "sandbox",
            db,
        });
        const originalTransactionId = "2000000123456789";
        const newerTransaction = validateAppleTransactionPayload(decoded({
            originalTransactionId,
            transactionId: "2000000123456791",
            appAccountToken: orderingAccount.appAccountToken,
            productId: APPLE_SUBSCRIPTION_PRODUCTS.max.monthly,
            type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
            purchaseDate: NOW_MS,
            originalPurchaseDate: NOW_MS - 30 * 24 * 60 * 60 * 1_000,
            expiresDate: NOW_MS + 30 * 24 * 60 * 60 * 1_000,
            signedDate: NOW_MS + 1_000,
        }), {
            environment: "sandbox",
            requireActive: false,
            nowMs: NOW_MS + 5_000,
        });
        const olderTransactionResignedLater = validateAppleTransactionPayload(decoded({
            originalTransactionId,
            transactionId: "2000000123456790",
            appAccountToken: orderingAccount.appAccountToken,
            productId: APPLE_SUBSCRIPTION_PRODUCTS.essential.monthly,
            type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
            purchaseDate: NOW_MS - 30 * 24 * 60 * 60 * 1_000,
            originalPurchaseDate: NOW_MS - 30 * 24 * 60 * 60 * 1_000,
            expiresDate: NOW_MS,
            signedDate: NOW_MS + 2_000,
        }), {
            environment: "sandbox",
            requireActive: false,
            nowMs: NOW_MS + 5_000,
        });
        const notification = (
            transaction: typeof newerTransaction,
            notificationUUID: string,
        ): VerifiedAppleServerNotification => ({
            environment: "sandbox",
            decoded: {
                notificationUUID,
                notificationType: "DID_RENEW",
                version: "2.0",
                signedDate: transaction.signedDate,
            } as ResponseBodyV2DecodedPayload,
            transaction,
            renewalInfo: null,
        });

        await applyVerifiedAppleNotification({
            notification: notification(
                newerTransaction,
                "3bf2688d-4844-42c6-b07c-a6e8413b71ee",
            ),
            nowMs: NOW_MS + 5_000,
            db,
        });
        await applyVerifiedAppleNotification({
            notification: notification(
                olderTransactionResignedLater,
                "3eda497f-fd37-48d9-a793-642671a6088f",
            ),
            nowMs: NOW_MS + 5_000,
            db,
        });

        const account = await ensureMonetizationAccount({
            uid: orderingUid,
            environment: "sandbox",
            db,
        });
        expect(account).toMatchObject({
            planId: "max",
            subscriptions: {
                [Object.keys(account.subscriptions)[0] as string]: {
                    productId: APPLE_SUBSCRIPTION_PRODUCTS.max.monthly,
                    latestTransactionId: newerTransaction.transactionId,
                    purchaseDateMs: newerTransaction.purchaseDate,
                    expiresAtMs: newerTransaction.expiresDate,
                },
            },
        });
    });

    it("reports every purchased pack unit while settling refund debt first", async () => {
        const debtUid = "apple-ledger-debt-user";
        const debtAccount = await ensureMonetizationAccount({
            uid: debtUid,
            environment: "sandbox",
            db,
        });
        await db.collection("monetizationAccountStates")
            .doc(monetizationAccountDocumentId("sandbox", debtUid))
            .update({ creditBalance: 0, creditDebt: 10 });
        const verified = validateAppleTransactionPayload(decoded({
            originalTransactionId: "2000000555555555",
            transactionId: "2000000666666666",
            appAccountToken: debtAccount.appAccountToken,
        }), {
            environment: "sandbox",
            requireActive: true,
            nowMs: NOW_MS,
        });

        const result = await applyVerifiedApplePurchase({
            uid: debtUid,
            verified,
            nowMs: NOW_MS,
            db,
        });
        expect(result).toMatchObject({
            duplicate: false,
            creditsGranted: 25,
            creditBalance: 15,
            creditDebt: 0,
        });
    });

    it("tombstones a refund before purchase and restores it once after reversal", async () => {
        const refundUid = "apple-ledger-refund-before-purchase-user";
        const refundAccount = await ensureMonetizationAccount({
            uid: refundUid,
            environment: "sandbox",
            db,
        });
        const transactionId = "2000000777777777";
        const originalTransactionId = "2000000888888888";
        const refunded = validateAppleTransactionPayload(decoded({
            originalTransactionId,
            transactionId,
            appAccountToken: refundAccount.appAccountToken,
            signedDate: NOW_MS + 1_000,
            revocationDate: NOW_MS,
        }), {
            environment: "sandbox",
            requireActive: false,
            nowMs: NOW_MS + 2_000,
        });
        const refundNotification: VerifiedAppleServerNotification = {
            environment: "sandbox",
            decoded: {
                notificationUUID: "c5aec88a-042f-4aae-85ed-0bab733157d8",
                notificationType: "REFUND",
                version: "2.0",
                signedDate: NOW_MS + 1_000,
            } as ResponseBodyV2DecodedPayload,
            transaction: refunded,
            renewalInfo: null,
        };

        expect(await applyVerifiedAppleNotification({
            notification: refundNotification,
            nowMs: NOW_MS + 2_000,
            db,
        })).toEqual({ duplicate: false, applied: true });
        expect(await ensureMonetizationAccount({
            uid: refundUid,
            environment: "sandbox",
            db,
        })).toMatchObject({ creditBalance: 0, creditDebt: 0 });

        const transactionRef = db.collection(MONETIZATION_APPLE_TRANSACTION_COLLECTION)
            .doc(appleTransactionDocumentId("sandbox", transactionId));
        expect((await transactionRef.get()).data()).toMatchObject({ refunded: true });
        expect(await applyVerifiedAppleNotification({
            notification: refundNotification,
            nowMs: NOW_MS + 2_000,
            db,
        })).toEqual({ duplicate: true, applied: true });

        const restored = validateAppleTransactionPayload(decoded({
            originalTransactionId,
            transactionId,
            appAccountToken: refundAccount.appAccountToken,
            signedDate: NOW_MS + 3_000,
        }), {
            environment: "sandbox",
            requireActive: false,
            nowMs: NOW_MS + 4_000,
        });
        const reversalNotification: VerifiedAppleServerNotification = {
            environment: "sandbox",
            decoded: {
                notificationUUID: "dfc2eff9-d268-4bbd-8513-e89bcdb0bd2c",
                notificationType: "REFUND_REVERSED",
                version: "2.0",
                signedDate: NOW_MS + 3_000,
            } as ResponseBodyV2DecodedPayload,
            transaction: restored,
            renewalInfo: null,
        };

        expect(await applyVerifiedAppleNotification({
            notification: reversalNotification,
            nowMs: NOW_MS + 4_000,
            db,
        })).toEqual({ duplicate: false, applied: true });
        expect(await ensureMonetizationAccount({
            uid: refundUid,
            environment: "sandbox",
            db,
        })).toMatchObject({ creditBalance: 25, creditDebt: 0 });
        expect((await transactionRef.get()).data()).toMatchObject({ refunded: false });
        expect(await applyVerifiedAppleNotification({
            notification: reversalNotification,
            nowMs: NOW_MS + 4_000,
            db,
        })).toEqual({ duplicate: true, applied: true });
        expect(await ensureMonetizationAccount({
            uid: refundUid,
            environment: "sandbox",
            db,
        })).toMatchObject({ creditBalance: 25, creditDebt: 0 });
    });

    it("returns the stored applied state when replaying a transactionless notification", async () => {
        const notification: VerifiedAppleServerNotification = {
            environment: "sandbox",
            decoded: {
                notificationUUID: "113ed0be-fc28-40d0-a44f-cfde01996e68",
                notificationType: "TEST",
                version: "2.0",
                signedDate: NOW_MS,
            } as ResponseBodyV2DecodedPayload,
            transaction: null,
            renewalInfo: null,
        };

        expect(await applyVerifiedAppleNotification({
            notification,
            nowMs: NOW_MS,
            db,
        })).toEqual({ duplicate: false, applied: false });
        expect(await applyVerifiedAppleNotification({
            notification,
            nowMs: NOW_MS,
            db,
        })).toEqual({ duplicate: true, applied: false });
    });

    it("acknowledges later Apple notifications after the owning account was deleted", async () => {
        const originalTransactionId = "2000000999999998";
        const notificationUUID = "a906513d-a2da-43ce-a537-a54404dc2562";
        await db.collection(MONETIZATION_APPLE_ORIGINAL_TRANSACTION_COLLECTION)
            .doc(appleOriginalTransactionDocumentId("sandbox", originalTransactionId))
            .set({
                schemaVersion: 1,
                environment: "sandbox",
                accountDocumentId: null,
                ownerDeleted: true,
            });
        const verified = validateAppleTransactionPayload(decoded({
            originalTransactionId,
            transactionId: "2000000999999999",
            appAccountToken: "92ad6ad6-15e3-41f2-b4d8-1f28207df409",
            productId: APPLE_SUBSCRIPTION_PRODUCTS.pro.monthly,
            type: Type.AUTO_RENEWABLE_SUBSCRIPTION,
            expiresDate: NOW_MS + 30 * 24 * 60 * 60 * 1_000,
        }), {
            environment: "sandbox",
            requireActive: false,
            nowMs: NOW_MS,
        });
        const notification: VerifiedAppleServerNotification = {
            environment: "sandbox",
            decoded: {
                notificationUUID,
                notificationType: "DID_RENEW",
                version: "2.0",
                signedDate: NOW_MS,
            } as ResponseBodyV2DecodedPayload,
            transaction: verified,
            renewalInfo: null,
        };

        expect(await applyVerifiedAppleNotification({ notification, nowMs: NOW_MS, db }))
            .toEqual({ duplicate: false, applied: false });
        expect(await applyVerifiedAppleNotification({ notification, nowMs: NOW_MS, db }))
            .toEqual({ duplicate: true, applied: false });
        const storedNotification = await db.collection(MONETIZATION_APPLE_NOTIFICATION_COLLECTION)
            .doc(appleNotificationDocumentId("sandbox", notificationUUID))
            .get();
        expect(storedNotification.data()).toMatchObject({
            applied: false,
            ownerDeleted: true,
        });
    });
});
