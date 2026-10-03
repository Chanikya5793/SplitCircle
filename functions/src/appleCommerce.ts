import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import {
    AppleCommerceVerificationError,
    isRetryableAppleCommerceVerificationError,
    verifyApplePurchaseTransaction,
    verifyAppleServerNotification,
    type ValidatedAppleTransaction,
    type VerifiedAppleServerNotification,
} from "./appleCommerceVerification";
import { getAppleProduct, type PaidPlanId } from "./commerceCatalog";
import {
    MONETIZATION_SCHEMA_VERSION,
    type MonetizationEnvironment,
    type PlanId,
} from "./monetizationCatalog";
import { hashOpaque } from "./monetizationCore";
import { resolveRequestMonetizationContext } from "./monetizationRequest";
import {
    MONETIZATION_APPLE_ACCOUNT_TOKEN_COLLECTION,
    MONETIZATION_APPLE_NOTIFICATION_COLLECTION,
    MONETIZATION_APPLE_ORIGINAL_TRANSACTION_COLLECTION,
    MONETIZATION_APPLE_TRANSACTION_COLLECTION,
    accountStateRef,
    accountStateWrite,
    appleAccountTokenDocumentId,
    appleNotificationDocumentId,
    appleOriginalTransactionDocumentId,
    appleTransactionDocumentId,
    ensureMonetizationAccount,
    parseAccountState,
    projectActivePlan,
    subscriptionMapKey,
    usageAccountRef,
    type MonetizationAccountState,
    type StoredSubscriptionEntitlement,
} from "./monetizationStore";

const MAX_SIGNED_TRANSACTION_LENGTH = 512 * 1024;
const SAFE_IDENTIFIER = /^[^\s]{1,128}$/;
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VerifyAppleTransactionResult {
    verified: true;
    accepted: true;
    duplicate: boolean;
    finishTransaction: true;
    environment: MonetizationEnvironment;
    productId: string;
    transactionId: string;
    originalTransactionId: string;
    purchaseKind: "subscription" | "consumable_credits";
    /** Highest currently active plan after applying this transaction. */
    planId: PlanId | null;
    /** Plan encoded by this exact subscription product, independent of projection. */
    purchasedPlanId: PaidPlanId | null;
    validUntil: number | null;
    activeSubscriptionProductId: string | null;
    creditsGranted: number;
    creditBalance: number;
    creditDebt: number;
    serverTime: number;
}

class AppleTransactionReplayError extends Error {
    constructor() {
        super("This Apple transaction belongs to another ManaSplit account.");
        this.name = "AppleTransactionReplayError";
    }
}

class UnmappedAppleNotificationError extends Error {
    readonly environment: MonetizationEnvironment;
    readonly notificationDigest: string;
    readonly accountTokenDigest: string | null;
    readonly originalTransactionDigest: string | null;

    constructor(notification: VerifiedAppleServerNotification) {
        super("The verified Apple notification has no account binding yet.");
        this.name = "UnmappedAppleNotificationError";
        this.environment = notification.environment;
        this.notificationDigest = hashOpaque([
            "apple-notification-log-v1",
            notification.decoded.notificationUUID ?? "missing",
        ]);
        this.accountTokenDigest = notification.transaction
            ? hashOpaque(["apple-account-token-log-v1", notification.transaction.appAccountToken])
            : null;
        this.originalTransactionDigest = notification.transaction
            ? hashOpaque([
                "apple-original-transaction-log-v1",
                notification.transaction.originalTransactionId,
            ])
            : null;
    }
}

function requireVerifyInput(value: unknown): {
    productId: string;
    transactionId: string;
    signedTransactionInfo: string;
    appAccountToken: string;
} {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpsError("invalid-argument", "request must be an object.");
    }
    const data = value as Record<string, unknown>;
    if (typeof data.productId !== "string" || !SAFE_IDENTIFIER.test(data.productId) ||
        !getAppleProduct(data.productId)) {
        throw new HttpsError("invalid-argument", "productId is not in the active catalog.");
    }
    if (typeof data.transactionId !== "string" || !SAFE_IDENTIFIER.test(data.transactionId)) {
        throw new HttpsError("invalid-argument", "transactionId is malformed.");
    }
    if (typeof data.appAccountToken !== "string" || !UUID_PATTERN.test(data.appAccountToken)) {
        throw new HttpsError("invalid-argument", "appAccountToken is malformed.");
    }
    if (typeof data.signedTransactionInfo !== "string" ||
        data.signedTransactionInfo.length === 0 ||
        data.signedTransactionInfo.length > MAX_SIGNED_TRANSACTION_LENGTH ||
        data.signedTransactionInfo.split(".").length !== 3) {
        throw new HttpsError("invalid-argument", "signedTransactionInfo is malformed.");
    }
    return {
        productId: data.productId,
        transactionId: data.transactionId,
        signedTransactionInfo: data.signedTransactionInfo,
        appAccountToken: data.appAccountToken,
    };
}

function applyCreditDelta(
    account: MonetizationAccountState,
    delta: number,
): { balanceBefore: number; debtBefore: number; balanceAfter: number; debtAfter: number } {
    const balanceBefore = account.creditBalance;
    const debtBefore = account.creditDebt;
    const netBefore = balanceBefore - debtBefore;
    const netAfter = netBefore + delta;
    account.creditBalance = Math.max(0, netAfter);
    account.creditDebt = Math.max(0, -netAfter);
    return {
        balanceBefore,
        debtBefore,
        balanceAfter: account.creditBalance,
        debtAfter: account.creditDebt,
    };
}

function resultFor(params: {
    verified: ValidatedAppleTransaction;
    account: MonetizationAccountState;
    duplicate: boolean;
    creditsGranted: number;
    serverTime: number;
}): VerifyAppleTransactionResult {
    const product = params.verified.product;
    return {
        verified: true,
        accepted: true,
        duplicate: params.duplicate,
        finishTransaction: true,
        environment: params.verified.environment,
        productId: params.verified.productId,
        transactionId: params.verified.transactionId,
        originalTransactionId: params.verified.originalTransactionId,
        purchaseKind: product.kind,
        planId: product.kind === "subscription" ? params.account.planId : null,
        purchasedPlanId: product.kind === "subscription" ? product.planId : null,
        validUntil: product.kind === "subscription" ? params.account.validUntilMs : null,
        activeSubscriptionProductId: product.kind === "subscription"
            ? params.account.activeSubscriptionProductId
            : null,
        creditsGranted: params.creditsGranted,
        creditBalance: params.account.creditBalance,
        creditDebt: params.account.creditDebt,
        serverTime: params.serverTime,
    };
}

function shouldApplySubscriptionTransaction(
    current: StoredSubscriptionEntitlement | undefined,
    verified: ValidatedAppleTransaction,
): boolean {
    if (!current) return true;

    // Lifecycle updates for the same renewal transaction are ordered by the
    // signed date so a later revocation or recovery can update that purchase.
    if (current.latestTransactionId === verified.transactionId) {
        return verified.signedDate >= current.updatedAtMs;
    }

    // Apple can re-sign and redeliver an older renewal after a newer renewal.
    // A signed date therefore cannot order different transactions in the same
    // original-transaction chain. Use the purchase chronology instead.
    if (current.purchaseDateMs > 0 && verified.purchaseDate !== current.purchaseDateMs) {
        return verified.purchaseDate > current.purchaseDateMs;
    }

    // Legacy entries predate purchaseDateMs. Subscription expirations still
    // provide a safe ordering boundary for distinct renewal transactions.
    if (verified.expiresDate !== null && verified.expiresDate !== current.expiresAtMs) {
        return verified.expiresDate > current.expiresAtMs;
    }

    if (verified.purchaseDate !== current.purchaseDateMs) {
        return verified.purchaseDate > current.purchaseDateMs;
    }
    return verified.signedDate >= current.updatedAtMs;
}

export async function applyVerifiedApplePurchase(params: {
    uid: string;
    verified: ValidatedAppleTransaction;
    nowMs: number;
    db?: Firestore;
}): Promise<VerifyAppleTransactionResult> {
    const db = params.db ?? getFirestore();
    const environment = params.verified.environment;
    const accountRef = accountStateRef(environment, params.uid, db);
    const usageRef = usageAccountRef(environment, params.uid, db);
    const accountId = accountRef.id;
    const transactionRef = db.collection(MONETIZATION_APPLE_TRANSACTION_COLLECTION)
        .doc(appleTransactionDocumentId(environment, params.verified.transactionId));
    const originalRef = db.collection(MONETIZATION_APPLE_ORIGINAL_TRANSACTION_COLLECTION)
        .doc(appleOriginalTransactionDocumentId(
            environment,
            params.verified.originalTransactionId,
        ));

    return db.runTransaction(async (transaction) => {
        const [accountSnapshot, transactionSnapshot, originalSnapshot] = await Promise.all([
            transaction.get(accountRef),
            transaction.get(transactionRef),
            transaction.get(originalRef),
        ]);
        const account = parseAccountState({
            data: accountSnapshot.data(),
            uid: params.uid,
            environment,
            nowMs: params.nowMs,
        });
        if (!account) throw new Error("Monetization account is missing or malformed.");
        if (account.appAccountToken !== params.verified.appAccountToken) {
            throw new AppleTransactionReplayError();
        }

        if (transactionSnapshot.exists) {
            const stored = transactionSnapshot.data();
            if (stored?.accountDocumentId !== accountId ||
                stored?.productId !== params.verified.productId ||
                stored?.transactionId !== params.verified.transactionId) {
                throw new AppleTransactionReplayError();
            }
            return resultFor({
                verified: params.verified,
                account,
                duplicate: true,
                creditsGranted: 0,
                serverTime: params.nowMs,
            });
        }

        if (originalSnapshot.exists && originalSnapshot.data()?.accountDocumentId !== accountId) {
            throw new AppleTransactionReplayError();
        }

        let creditsGranted = 0;
        const product = params.verified.product;
        if (product.kind === "subscription") {
            const expiresAtMs = params.verified.expiresDate;
            if (expiresAtMs === null || expiresAtMs <= params.nowMs) {
                throw new Error("Verified subscription did not contain an active expiration.");
            }
            const key = subscriptionMapKey(params.verified.originalTransactionId);
            const current = account.subscriptions[key];
            if (shouldApplySubscriptionTransaction(current, params.verified)) {
                account.subscriptions[key] = {
                    productId: params.verified.productId,
                    planId: product.planId,
                    originalTransactionId: params.verified.originalTransactionId,
                    latestTransactionId: params.verified.transactionId,
                    purchaseDateMs: params.verified.purchaseDate,
                    expiresAtMs,
                    revokedAtMs: null,
                    isUpgraded: false,
                    environment,
                    updatedAtMs: params.verified.signedDate,
                };
            }
            const projection = projectActivePlan(account.subscriptions, params.nowMs);
            account.planId = projection.planId;
            account.validUntilMs = projection.validUntilMs;
            account.activeSubscriptionProductId = projection.activeSubscriptionProductId;
            transaction.set(originalRef, {
                schemaVersion: MONETIZATION_SCHEMA_VERSION,
                environment,
                accountDocumentId: accountId,
                originalTransactionId: params.verified.originalTransactionId,
                appAccountTokenDigest: hashOpaque([params.verified.appAccountToken]),
                updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
        } else {
            const creditChange = applyCreditDelta(account, product.credits);
            // Report the pack units Apple verified, even when some units first
            // settle debt created by a prior refunded-and-already-spent pack.
            // The separate creditBalance remains the user's spendable amount.
            creditsGranted = product.credits;
            transaction.create(usageRef.collection("creditLedger").doc(transactionRef.id), {
                schemaVersion: MONETIZATION_SCHEMA_VERSION,
                type: "apple_credit_purchase",
                status: "settled",
                productId: params.verified.productId,
                transactionId: params.verified.transactionId,
                creditDelta: product.credits,
                ...creditChange,
                createdAt: FieldValue.serverTimestamp(),
            });
        }

        transaction.set(accountRef, accountStateWrite(account), { merge: true });
        transaction.create(transactionRef, {
            schemaVersion: MONETIZATION_SCHEMA_VERSION,
            environment,
            accountDocumentId: accountId,
            transactionId: params.verified.transactionId,
            originalTransactionId: params.verified.originalTransactionId,
            productId: params.verified.productId,
            purchaseKind: product.kind,
            credits: product.kind === "consumable_credits" ? product.credits : 0,
            refunded: false,
            expiresAtMs: params.verified.expiresDate,
            signedDateMs: params.verified.signedDate,
            accountTokenDigest: hashOpaque([params.verified.appAccountToken]),
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
        });

        return resultFor({
            verified: params.verified,
            account,
            duplicate: false,
            creditsGranted,
            serverTime: params.nowMs,
        });
    });
}

export const verifyAppleTransaction = onCall(
    { cors: true, maxInstances: 30 },
    async (request) => {
        const input = requireVerifyInput(request.data);
        const nowMs = Date.now();
        const context = await resolveRequestMonetizationContext(request, nowMs);
        try {
            const account = await ensureMonetizationAccount({
                uid: context.uid,
                environment: context.environment,
            });
            if (input.appAccountToken !== account.appAccountToken) {
                throw new HttpsError("permission-denied", "The purchase belongs to another account.", {
                    reasonCode: "APP_ACCOUNT_TOKEN_MISMATCH",
                });
            }
            const verified = await verifyApplePurchaseTransaction({
                ...input,
                environment: context.environment,
                nowMs,
            });
            return await applyVerifiedApplePurchase({
                uid: context.uid,
                verified,
                nowMs,
            });
        } catch (error) {
            if (error instanceof HttpsError) throw error;
            if (error instanceof AppleTransactionReplayError) {
                throw new HttpsError("permission-denied", error.message, {
                    reasonCode: "APPLE_TRANSACTION_REPLAY",
                });
            }
            if (error instanceof AppleCommerceVerificationError) {
                logger.warn("Apple purchase verification rejected", {
                    accountDigest: hashOpaque(["apple-purchase-account-v1", context.uid]),
                    transactionDigest: hashOpaque(["apple-purchase-transaction-v1", input.transactionId]),
                    verificationCode: error.code,
                });
                throw new HttpsError("failed-precondition", "Apple could not verify this purchase.", {
                    reasonCode: `APPLE_${error.code.toUpperCase()}`,
                });
            }
            logger.error("Apple purchase persistence failed", {
                accountDigest: hashOpaque(["apple-purchase-account-v1", context.uid]),
                transactionDigest: hashOpaque(["apple-purchase-transaction-v1", input.transactionId]),
                errorName: error instanceof Error ? error.name : "UnknownError",
            });
            throw new HttpsError("internal", "The purchase could not be recorded safely.");
        }
    },
);

async function lookupNotificationAccount(params: {
    notification: VerifiedAppleServerNotification;
    db: Firestore;
}): Promise<{ accountId: string | null; ownerDeleted: boolean }> {
    const transaction = params.notification.transaction;
    if (!transaction) return { accountId: null, ownerDeleted: false };
    const tokenRef = params.db.collection(MONETIZATION_APPLE_ACCOUNT_TOKEN_COLLECTION)
        .doc(appleAccountTokenDocumentId(params.notification.environment, transaction.appAccountToken));
    const originalRef = params.db.collection(MONETIZATION_APPLE_ORIGINAL_TRANSACTION_COLLECTION)
        .doc(appleOriginalTransactionDocumentId(
            params.notification.environment,
            transaction.originalTransactionId,
        ));
    const [tokenSnapshot, originalSnapshot] = await Promise.all([
        tokenRef.get(),
        originalRef.get(),
    ]);
    const tokenData = tokenSnapshot.data();
    const originalData = originalSnapshot.data();
    const tokenAccount = typeof tokenData?.accountDocumentId === "string"
        ? tokenData.accountDocumentId as string
        : null;
    const originalAccount = typeof originalData?.accountDocumentId === "string"
        ? originalData.accountDocumentId as string
        : null;
    if (tokenAccount && originalAccount && tokenAccount !== originalAccount) {
        throw new AppleTransactionReplayError();
    }
    if (!tokenAccount && !originalAccount && !tokenData?.ownerDeleted && !originalData?.ownerDeleted) {
        const otherEnvironment: MonetizationEnvironment = params.notification.environment === "sandbox"
            ? "production"
            : "sandbox";
        const otherTokenRef = params.db.collection(MONETIZATION_APPLE_ACCOUNT_TOKEN_COLLECTION)
            .doc(appleAccountTokenDocumentId(otherEnvironment, transaction.appAccountToken));
        const otherTokenSnapshot = await otherTokenRef.get();
        const otherTokenData = otherTokenSnapshot.data();
        const otherAccountId = typeof otherTokenData?.accountDocumentId === "string"
            ? otherTokenData.accountDocumentId as string
            : null;

        if (otherAccountId && otherTokenData?.ownerDeleted !== true) {
            const otherAccountSnapshot = await params.db
                .collection("monetizationAccountStates")
                .doc(otherAccountId)
                .get();
            const otherAccountData = otherAccountSnapshot.data();
            const ownerUid = typeof otherAccountData?.uid === "string"
                ? otherAccountData.uid as string
                : null;
            const otherAccount = ownerUid
                ? parseAccountState({
                    data: otherAccountData,
                    uid: ownerUid,
                    environment: otherEnvironment,
                })
                : null;

            // Both reverse bindings and account ledgers are server-owned. A
            // signed Apple token already bound in the opposite environment can
            // therefore establish the matching environment ledger safely. This
            // matters when Apple delivers a TestFlight notification before the
            // tester has refreshed the app and caused a sandbox account to exist.
            if (otherAccount?.appAccountToken === transaction.appAccountToken) {
                const recovered = await ensureMonetizationAccount({
                    uid: otherAccount.uid,
                    environment: params.notification.environment,
                    db: params.db,
                });
                if (recovered.appAccountToken === transaction.appAccountToken) {
                    return {
                        accountId: accountStateRef(
                            params.notification.environment,
                            otherAccount.uid,
                            params.db,
                        ).id,
                        ownerDeleted: false,
                    };
                }
            }
        }
    }
    return {
        accountId: originalAccount ?? tokenAccount,
        ownerDeleted: originalData?.ownerDeleted === true || tokenData?.ownerDeleted === true,
    };
}

export async function applyVerifiedAppleNotification(params: {
    notification: VerifiedAppleServerNotification;
    nowMs: number;
    db?: Firestore;
}): Promise<{ duplicate: boolean; applied: boolean }> {
    const db = params.db ?? getFirestore();
    const environment = params.notification.environment;
    const notificationUUID = params.notification.decoded.notificationUUID;
    if (typeof notificationUUID !== "string") throw new Error("Verified notification has no UUID.");
    const notificationRef = db.collection(MONETIZATION_APPLE_NOTIFICATION_COLLECTION)
        .doc(appleNotificationDocumentId(environment, notificationUUID));
    const binding = await lookupNotificationAccount({ notification: params.notification, db });
    const accountId = binding.accountId;
    if (params.notification.transaction && !accountId && !binding.ownerDeleted) {
        throw new UnmappedAppleNotificationError(params.notification);
    }

    return db.runTransaction(async (transaction) => {
        const notificationSnapshot = await transaction.get(notificationRef);
        if (notificationSnapshot.exists) {
            return {
                duplicate: true,
                applied: notificationSnapshot.data()?.applied === true,
            };
        }
        const verified = params.notification.transaction;
        if (!verified || !accountId) {
            transaction.create(notificationRef, {
                schemaVersion: MONETIZATION_SCHEMA_VERSION,
                environment,
                notificationUUID,
                notificationType: params.notification.decoded.notificationType ?? null,
                subtype: params.notification.decoded.subtype ?? null,
                applied: false,
                ...(binding.ownerDeleted ? { ownerDeleted: true } : {}),
                receivedAt: FieldValue.serverTimestamp(),
            });
            return { duplicate: false, applied: false };
        }

        const accountRef = db.collection("monetizationAccountStates").doc(accountId);
        const globalTransactionRef = db.collection(MONETIZATION_APPLE_TRANSACTION_COLLECTION)
            .doc(appleTransactionDocumentId(environment, verified.transactionId));
        const originalRef = db.collection(MONETIZATION_APPLE_ORIGINAL_TRANSACTION_COLLECTION)
            .doc(appleOriginalTransactionDocumentId(environment, verified.originalTransactionId));
        const [accountSnapshot, globalTransactionSnapshot, originalSnapshot] = await Promise.all([
            transaction.get(accountRef),
            transaction.get(globalTransactionRef),
            transaction.get(originalRef),
        ]);
        const accountData = accountSnapshot.data();
        if (!accountData || typeof accountData.uid !== "string") {
            throw new UnmappedAppleNotificationError(params.notification);
        }
        const account = parseAccountState({
            data: accountData,
            uid: accountData.uid,
            environment,
            nowMs: params.nowMs,
        });
        if (!account || account.appAccountToken !== verified.appAccountToken) {
            throw new AppleTransactionReplayError();
        }
        if (originalSnapshot.exists && originalSnapshot.data()?.accountDocumentId !== accountId) {
            throw new AppleTransactionReplayError();
        }
        if (globalTransactionSnapshot.exists &&
            globalTransactionSnapshot.data()?.accountDocumentId !== accountId) {
            throw new AppleTransactionReplayError();
        }

        const product = verified.product;
        if (product.kind === "subscription") {
            if (verified.expiresDate === null) throw new Error("Subscription expiration is missing.");
            const gracePeriodExpiresDate = params.notification.renewalInfo
                ?.gracePeriodExpiresDate ?? null;
            const effectiveExpiresAt = !verified.isRevoked && !verified.isUpgraded &&
                gracePeriodExpiresDate !== null && gracePeriodExpiresDate > verified.expiresDate
                ? gracePeriodExpiresDate
                : verified.expiresDate;
            const key = subscriptionMapKey(verified.originalTransactionId);
            const current = account.subscriptions[key];
            if (shouldApplySubscriptionTransaction(current, verified)) {
                account.subscriptions[key] = {
                    productId: verified.productId,
                    planId: product.planId,
                    originalTransactionId: verified.originalTransactionId,
                    latestTransactionId: verified.transactionId,
                    purchaseDateMs: verified.purchaseDate,
                    expiresAtMs: effectiveExpiresAt,
                    revokedAtMs: verified.isRevoked
                        ? verified.decoded.revocationDate ?? params.nowMs
                        : null,
                    isUpgraded: verified.decoded.isUpgraded === true,
                    environment,
                    updatedAtMs: verified.signedDate,
                };
            }
            const projection = projectActivePlan(account.subscriptions, params.nowMs);
            account.planId = projection.planId;
            account.validUntilMs = projection.validUntilMs;
            account.activeSubscriptionProductId = projection.activeSubscriptionProductId;
            transaction.set(originalRef, {
                schemaVersion: MONETIZATION_SCHEMA_VERSION,
                environment,
                accountDocumentId: accountId,
                originalTransactionId: verified.originalTransactionId,
                appAccountTokenDigest: hashOpaque([verified.appAccountToken]),
                updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
        } else {
            const prior = globalTransactionSnapshot.data();
            const priorSignedDate = typeof prior?.signedDateMs === "number"
                ? prior.signedDateMs as number
                : 0;
            const priorRefunded = prior?.refunded === true;
            const isNewerState = !globalTransactionSnapshot.exists ||
                verified.signedDate > priorSignedDate;
            const shouldGrant = !verified.isRevoked && (
                !globalTransactionSnapshot.exists || (isNewerState && priorRefunded)
            );
            const shouldRefund = globalTransactionSnapshot.exists && isNewerState &&
                verified.isRevoked && !priorRefunded;
            if (shouldGrant || shouldRefund) {
                const delta = shouldGrant ? product.credits : -product.credits;
                const creditChange = applyCreditDelta(account, delta);
                const usageRef = db.collection("monetizationUsageAccounts").doc(accountId);
                const ledgerDocumentId = !globalTransactionSnapshot.exists
                    ? globalTransactionRef.id
                    : `${globalTransactionRef.id}_${shouldGrant ? "refund_reversed" : "refund"}` +
                        `_${verified.signedDate}`;
                transaction.set(usageRef.collection("creditLedger").doc(
                    ledgerDocumentId,
                ), {
                    schemaVersion: MONETIZATION_SCHEMA_VERSION,
                    type: shouldGrant ? "apple_credit_purchase" : "apple_credit_refund",
                    status: "settled",
                    productId: verified.productId,
                    transactionId: verified.transactionId,
                    creditDelta: delta,
                    ...creditChange,
                    createdAt: FieldValue.serverTimestamp(),
                });
            }
        }

        transaction.set(accountRef, accountStateWrite(account), { merge: true });
        transaction.set(globalTransactionRef, {
            schemaVersion: MONETIZATION_SCHEMA_VERSION,
            environment,
            accountDocumentId: accountId,
            transactionId: verified.transactionId,
            originalTransactionId: verified.originalTransactionId,
            productId: verified.productId,
            purchaseKind: product.kind,
            credits: product.kind === "consumable_credits" ? product.credits : 0,
            refunded: product.kind === "consumable_credits"
                ? (!globalTransactionSnapshot.exists ||
                    verified.signedDate > (
                        typeof globalTransactionSnapshot.data()?.signedDateMs === "number"
                            ? globalTransactionSnapshot.data()?.signedDateMs as number
                            : 0
                    )
                    ? verified.isRevoked
                    : globalTransactionSnapshot.data()?.refunded === true)
                : false,
            expiresAtMs: verified.expiresDate,
            signedDateMs: Math.max(
                verified.signedDate,
                typeof globalTransactionSnapshot.data()?.signedDateMs === "number"
                    ? globalTransactionSnapshot.data()?.signedDateMs as number
                    : 0,
            ),
            accountTokenDigest: hashOpaque([verified.appAccountToken]),
            updatedAt: FieldValue.serverTimestamp(),
            ...(globalTransactionSnapshot.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
        }, { merge: true });
        transaction.create(notificationRef, {
            schemaVersion: MONETIZATION_SCHEMA_VERSION,
            environment,
            notificationUUID,
            notificationType: params.notification.decoded.notificationType ?? null,
            subtype: params.notification.decoded.subtype ?? null,
            accountDocumentId: accountId,
            transactionDocumentId: globalTransactionRef.id,
            applied: true,
            receivedAt: FieldValue.serverTimestamp(),
        });
        return { duplicate: false, applied: true };
    });
}

export async function verifyNotificationInEitherEnvironment(
    signedPayload: string,
    verify: typeof verifyAppleServerNotification = verifyAppleServerNotification,
): Promise<VerifiedAppleServerNotification> {
    try {
        return await verify(signedPayload, "production");
    } catch (productionError) {
        if (!(productionError instanceof AppleCommerceVerificationError) ||
            productionError.code !== "invalid_environment") {
            throw productionError;
        }
        try {
            return await verify(signedPayload, "sandbox");
        } catch (sandboxError) {
            throw sandboxError;
        }
    }
}

export function appleNotificationHttpStatusForError(error: unknown): 400 | 500 | 503 {
    if (error instanceof UnmappedAppleNotificationError ||
        isRetryableAppleCommerceVerificationError(error)) {
        return 503;
    }
    if (error instanceof AppleCommerceVerificationError ||
        error instanceof AppleTransactionReplayError) {
        return 400;
    }
    return 500;
}

export const appStoreServerNotificationsV2 = onRequest(
    { cors: false, maxInstances: 30 },
    async (request, response) => {
        if (request.method !== "POST") {
            response.set("Allow", "POST").status(405).send("Method Not Allowed");
            return;
        }
        const signedPayload = request.body?.signedPayload;
        if (typeof signedPayload !== "string" || signedPayload.length === 0 ||
            signedPayload.length > MAX_SIGNED_TRANSACTION_LENGTH) {
            response.status(400).send("Invalid notification payload");
            return;
        }
        try {
            const notification = await verifyNotificationInEitherEnvironment(signedPayload);
            const result = await applyVerifiedAppleNotification({
                notification,
                nowMs: Date.now(),
            });
            logger.info("App Store Server Notification processed", {
                environment: notification.environment,
                notificationDigest: hashOpaque([
                    "apple-notification-log-v1",
                    notification.decoded.notificationUUID ?? "missing",
                ]),
                ...result,
            });
            response.status(200).send("OK");
        } catch (error) {
            if (error instanceof UnmappedAppleNotificationError) {
                logger.warn("Verified App Store notification awaits account binding", {
                    environment: error.environment,
                    notificationDigest: error.notificationDigest,
                    accountTokenDigest: error.accountTokenDigest,
                    originalTransactionDigest: error.originalTransactionDigest,
                });
                response.status(503).send("Account binding is not ready");
                return;
            }
            if (isRetryableAppleCommerceVerificationError(error)) {
                logger.warn("App Store Server Notification verification is temporarily unavailable", {
                    verificationCode: error.code,
                });
                response.status(503).send("Temporary verification failure");
                return;
            }
            if (error instanceof AppleCommerceVerificationError ||
                error instanceof AppleTransactionReplayError) {
                logger.warn("App Store Server Notification rejected", {
                    errorName: error.name,
                    verificationCode: error instanceof AppleCommerceVerificationError
                        ? error.code
                        : "transaction_replay",
                });
                response.status(400).send("Invalid notification");
                return;
            }
            logger.error("App Store Server Notification failed", {
                errorName: error instanceof Error ? error.name : "UnknownError",
            });
            response.status(500).send("Temporary processing failure");
        }
    },
);
