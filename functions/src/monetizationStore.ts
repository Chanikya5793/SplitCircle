import { randomUUID } from "node:crypto";
import {
    FieldValue,
    Timestamp,
    getFirestore,
    type DocumentData,
    type DocumentReference,
    type Firestore,
    type Transaction,
} from "firebase-admin/firestore";
import { PLAN_PRIORITY, isPaidPlanId, type PaidPlanId } from "./commerceCatalog";
import {
    MONETIZATION_SCHEMA_VERSION,
    type MonetizationEnvironment,
    type PlanId,
} from "./monetizationCatalog";
import { hashOpaque, monetizationAccountDocumentId } from "./monetizationCore";

export const MONETIZATION_ACCOUNT_STATE_COLLECTION = "monetizationAccountStates";
export const MONETIZATION_USAGE_ACCOUNT_COLLECTION = "monetizationUsageAccounts";
export const MONETIZATION_APPLE_TRANSACTION_COLLECTION = "monetizationAppleTransactions";
export const MONETIZATION_APPLE_ORIGINAL_TRANSACTION_COLLECTION =
    "monetizationAppleOriginalTransactions";
export const MONETIZATION_APPLE_ACCOUNT_TOKEN_COLLECTION = "monetizationAppleAccountTokens";
export const MONETIZATION_APPLE_NOTIFICATION_COLLECTION = "monetizationAppleNotifications";
export const MONETIZATION_ADMIN_AUDIT_COLLECTION = "monetizationAdminAudit";

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CREDIT_BALANCE = 10_000_000;

export interface StoredSubscriptionEntitlement {
    productId: string;
    planId: PaidPlanId;
    originalTransactionId: string;
    latestTransactionId: string;
    purchaseDateMs: number;
    expiresAtMs: number;
    revokedAtMs: number | null;
    isUpgraded: boolean;
    environment: MonetizationEnvironment;
    updatedAtMs: number;
}

export interface MonetizationAccountState {
    schemaVersion: 1;
    uid: string;
    environment: MonetizationEnvironment;
    status: "active";
    appAccountToken: string;
    creditBalance: number;
    creditDebt: number;
    planId: PlanId;
    validUntilMs: number | null;
    activeSubscriptionProductId: string | null;
    subscriptions: Record<string, StoredSubscriptionEntitlement>;
}

export interface AccountProjection {
    planId: PlanId;
    validUntilMs: number | null;
    activeSubscriptionProductId: string | null;
}

export function safeNonNegativeInteger(value: unknown): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : 0;
}

function sanitizeSubscriptions(value: unknown): Record<string, StoredSubscriptionEntitlement> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, StoredSubscriptionEntitlement> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const entry = raw as Record<string, unknown>;
        if (typeof entry.productId !== "string" || !isPaidPlanId(entry.planId) ||
            typeof entry.originalTransactionId !== "string" ||
            typeof entry.latestTransactionId !== "string" ||
            typeof entry.expiresAtMs !== "number" || !Number.isFinite(entry.expiresAtMs) ||
            (entry.environment !== "sandbox" && entry.environment !== "production")) {
            continue;
        }
        result[key] = {
            productId: entry.productId,
            planId: entry.planId as PaidPlanId,
            originalTransactionId: entry.originalTransactionId,
            latestTransactionId: entry.latestTransactionId,
            purchaseDateMs: typeof entry.purchaseDateMs === "number" &&
                Number.isSafeInteger(entry.purchaseDateMs) && entry.purchaseDateMs > 0
                ? entry.purchaseDateMs
                : 0,
            expiresAtMs: entry.expiresAtMs,
            revokedAtMs: typeof entry.revokedAtMs === "number" && Number.isFinite(entry.revokedAtMs)
                ? entry.revokedAtMs
                : null,
            isUpgraded: entry.isUpgraded === true,
            environment: entry.environment,
            updatedAtMs: typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs)
                ? entry.updatedAtMs
                : 0,
        };
    }
    return result;
}

export function projectActivePlan(
    subscriptions: Record<string, StoredSubscriptionEntitlement>,
    nowMs: number,
): AccountProjection {
    let planId: PlanId = "free";
    let validUntilMs: number | null = null;
    let activeSubscriptionProductId: string | null = null;
    for (const subscription of Object.values(subscriptions)) {
        if (subscription.revokedAtMs !== null || subscription.isUpgraded ||
            subscription.expiresAtMs <= nowMs) {
            continue;
        }
        if (PLAN_PRIORITY[subscription.planId] > PLAN_PRIORITY[planId]) {
            planId = subscription.planId;
            validUntilMs = subscription.expiresAtMs;
            activeSubscriptionProductId = subscription.productId;
        } else if (subscription.planId === planId) {
            if (subscription.expiresAtMs > (validUntilMs ?? 0)) {
                validUntilMs = subscription.expiresAtMs;
                activeSubscriptionProductId = subscription.productId;
            }
        }
    }
    return { planId, validUntilMs, activeSubscriptionProductId };
}

export function parseAccountState(params: {
    data: DocumentData | undefined;
    uid: string;
    environment: MonetizationEnvironment;
    nowMs?: number;
}): MonetizationAccountState | null {
    const data = params.data;
    if (!data || data.schemaVersion !== MONETIZATION_SCHEMA_VERSION ||
        data.uid !== params.uid || data.environment !== params.environment ||
        data.status !== "active" || typeof data.appAccountToken !== "string" ||
        !UUID_PATTERN.test(data.appAccountToken)) {
        return null;
    }
    const subscriptions = sanitizeSubscriptions(data.subscriptions);
    const projection = projectActivePlan(subscriptions, params.nowMs ?? Date.now());
    return {
        schemaVersion: MONETIZATION_SCHEMA_VERSION,
        uid: params.uid,
        environment: params.environment,
        status: "active",
        appAccountToken: data.appAccountToken,
        creditBalance: Math.min(MAX_CREDIT_BALANCE, safeNonNegativeInteger(data.creditBalance)),
        creditDebt: Math.min(MAX_CREDIT_BALANCE, safeNonNegativeInteger(data.creditDebt)),
        planId: projection.planId,
        validUntilMs: projection.validUntilMs,
        activeSubscriptionProductId: projection.activeSubscriptionProductId,
        subscriptions,
    };
}

export function accountDocumentId(environment: MonetizationEnvironment, uid: string): string {
    return monetizationAccountDocumentId(environment, uid);
}

export function accountStateRef(
    environment: MonetizationEnvironment,
    uid: string,
    db: Firestore = getFirestore(),
): DocumentReference {
    return db.collection(MONETIZATION_ACCOUNT_STATE_COLLECTION)
        .doc(accountDocumentId(environment, uid));
}

export function usageAccountRef(
    environment: MonetizationEnvironment,
    uid: string,
    db: Firestore = getFirestore(),
): DocumentReference {
    return db.collection(MONETIZATION_USAGE_ACCOUNT_COLLECTION)
        .doc(accountDocumentId(environment, uid));
}

export function appleAccountTokenDocumentId(
    environment: MonetizationEnvironment,
    appAccountToken: string,
): string {
    return `${environment}_${hashOpaque(["apple-account-token-v1", appAccountToken]).slice(0, 48)}`;
}

export function appleTransactionDocumentId(
    environment: MonetizationEnvironment,
    transactionId: string,
): string {
    return `${environment}_${hashOpaque(["apple-transaction-v1", transactionId])}`;
}

export function appleOriginalTransactionDocumentId(
    environment: MonetizationEnvironment,
    originalTransactionId: string,
): string {
    return `${environment}_${hashOpaque(["apple-original-transaction-v1", originalTransactionId])}`;
}

export function appleNotificationDocumentId(
    environment: MonetizationEnvironment,
    notificationUUID: string,
): string {
    return `${environment}_${hashOpaque(["apple-notification-v1", notificationUUID])}`;
}

export function subscriptionMapKey(originalTransactionId: string): string {
    return hashOpaque(["subscription-entitlement-v1", originalTransactionId]);
}

export function accountStateWrite(
    account: MonetizationAccountState,
): Record<string, unknown> {
    return {
        schemaVersion: MONETIZATION_SCHEMA_VERSION,
        uid: account.uid,
        environment: account.environment,
        status: "active",
        appAccountToken: account.appAccountToken,
        creditBalance: account.creditBalance,
        creditDebt: account.creditDebt,
        planId: account.planId,
        validUntil: account.validUntilMs === null ? null : Timestamp.fromMillis(account.validUntilMs),
        activeSubscriptionProductId: account.activeSubscriptionProductId,
        subscriptions: account.subscriptions,
        updatedAt: FieldValue.serverTimestamp(),
    };
}

/**
 * Initializes the server-owned customer record and its reverse token binding.
 * Sandbox and production ledgers stay isolated, but both reuse the same opaque
 * Apple account token. TestFlight always creates sandbox transactions, and a
 * token that changes when test access is granted would make an already-created
 * transaction impossible to restore.
 */
export async function ensureMonetizationAccount(params: {
    uid: string;
    environment: MonetizationEnvironment;
    db?: Firestore;
}): Promise<MonetizationAccountState> {
    const db = params.db ?? getFirestore();
    const accountRef = accountStateRef(params.environment, params.uid, db);
    const otherEnvironment: MonetizationEnvironment = params.environment === "sandbox"
        ? "production"
        : "sandbox";
    const otherAccountRef = accountStateRef(otherEnvironment, params.uid, db);
    const candidateToken = randomUUID();

    return db.runTransaction(async (transaction) => {
        const [accountSnapshot, otherAccountSnapshot] = await Promise.all([
            transaction.get(accountRef),
            transaction.get(otherAccountRef),
        ]);
        const existingData = accountSnapshot.data();
        const existingToken = typeof existingData?.appAccountToken === "string" &&
            UUID_PATTERN.test(existingData.appAccountToken)
            ? existingData.appAccountToken
            : null;
        const otherData = otherAccountSnapshot.data();
        const otherToken = otherData?.uid === params.uid &&
            otherData?.status === "active" &&
            typeof otherData?.appAccountToken === "string" &&
            UUID_PATTERN.test(otherData.appAccountToken)
            ? otherData.appAccountToken as string
            : null;
        const appAccountToken = existingToken ?? otherToken ?? candidateToken;
        const tokenRef = db.collection(MONETIZATION_APPLE_ACCOUNT_TOKEN_COLLECTION)
            .doc(appleAccountTokenDocumentId(params.environment, appAccountToken));
        const tokenSnapshot = await transaction.get(tokenRef);
        const accountId = accountRef.id;
        if (tokenSnapshot.exists && tokenSnapshot.data()?.accountDocumentId !== accountId) {
            throw new Error("App account token binding collision.");
        }

        const subscriptions = sanitizeSubscriptions(existingData?.subscriptions);
        const projection = projectActivePlan(subscriptions, Date.now());
        const account: MonetizationAccountState = {
            schemaVersion: MONETIZATION_SCHEMA_VERSION,
            uid: params.uid,
            environment: params.environment,
            status: "active",
            appAccountToken,
            creditBalance: Math.min(
                MAX_CREDIT_BALANCE,
                safeNonNegativeInteger(existingData?.creditBalance),
            ),
            creditDebt: Math.min(MAX_CREDIT_BALANCE, safeNonNegativeInteger(existingData?.creditDebt)),
            planId: projection.planId,
            validUntilMs: projection.validUntilMs,
            activeSubscriptionProductId: projection.activeSubscriptionProductId,
            subscriptions,
        };

        transaction.set(accountRef, accountStateWrite(account), { merge: true });
        transaction.set(tokenRef, {
            schemaVersion: MONETIZATION_SCHEMA_VERSION,
            environment: params.environment,
            accountDocumentId: accountId,
            subjectDigest: hashOpaque(["monetization-subject-v1", params.uid]),
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return account;
    });
}

export async function readAccountInTransaction(params: {
    transaction: Transaction;
    ref: DocumentReference;
    uid: string;
    environment: MonetizationEnvironment;
}): Promise<MonetizationAccountState> {
    const snapshot = await params.transaction.get(params.ref);
    const parsed = parseAccountState({
        data: snapshot.data(),
        uid: params.uid,
        environment: params.environment,
    });
    if (!parsed) throw new Error("Monetization account is missing or malformed.");
    return parsed;
}
