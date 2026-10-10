import { createHash } from "node:crypto";
import {
    FieldValue,
    getFirestore,
    type DocumentReference,
    type Firestore,
    type Transaction,
} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
    CLIENT_AUTHORIZED_FEATURE_IDS,
    METERED_FEATURES,
    MONETIZATION_SCHEMA_VERSION,
    type ExecutionRoute,
    type MeteredFeatureId,
    type MonetizationEnvironment,
    type PlanId,
} from "./monetizationCatalog";
import {
    MonetizationInputError,
    getPreviewKey,
    getRuleWindow,
    hashOpaque,
    sanitizeUsageInput,
    usagePayloadDigest,
    type InternalTestAccess,
    type SanitizedAppContext,
} from "./monetizationCore";
import {
    MONETIZATION_ACCOUNT_STATE_COLLECTION,
    MONETIZATION_USAGE_ACCOUNT_COLLECTION,
    accountDocumentId,
    accountStateRef,
    accountStateWrite,
    ensureMonetizationAccount,
    parseAccountState,
    safeNonNegativeInteger,
    usageAccountRef,
} from "./monetizationStore";
import {
    mapMonetizationInputError,
    resolveRequestMonetizationContext,
} from "./monetizationRequest";

const RESERVATION_TTL_MS = 15 * 60 * 1_000;
const FINALIZED_RESERVATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export type MonetizedAccessSource =
    | "preview"
    | "included_use"
    | "unlimited"
    | "internal_test"
    | "measurement_only"
    | "credits"
    | "quota_exhausted";

export interface AuthorizeMonetizedOperationInput {
    operationId: string;
    featureId: MeteredFeatureId;
    variant?: string;
    executionRoute: ExecutionRoute;
    useCredits: boolean;
    app?: SanitizedAppContext;
}

export interface MonetizedOperationAuthorization {
    schemaVersion: 1;
    allowed: boolean;
    authorizationId: string | null;
    environment: MonetizationEnvironment;
    featureId: MeteredFeatureId;
    planId: PlanId;
    source: MonetizedAccessSource;
    reasonCode: string;
    creditCost: number | null;
    creditBalance: number;
    remaining: number | null;
    resetsAt: number | null;
}

type FinalOutcome = "completed" | "failed" | "cancelled" | "abandoned";

export interface FinalizeMonetizedOperationResult {
    schemaVersion: 1;
    accepted: true;
    duplicate: boolean;
    outcome: FinalOutcome;
    creditBalance: number;
    serverTime: number;
}

interface StoredReservation {
    status: "reserved" | "finalized" | "denied";
    payloadDigest: string;
    authorizationId: string;
    operationDigest: string;
    environment: MonetizationEnvironment;
    featureId: MeteredFeatureId;
    variant?: string;
    source: MonetizedAccessSource;
    creditCost: number;
    windowDocumentId: string | null;
    previewDocumentId: string | null;
    expiresAtMs: number;
    result: MonetizedOperationAuthorization;
    finalResult?: FinalizeMonetizedOperationResult;
}

function authorizationDocumentId(
    environment: MonetizationEnvironment,
    uid: string,
    operationId: string,
): string {
    return hashOpaque(["monetization-authorization-v1", environment, uid, operationId]);
}

function windowDocumentId(featureId: MeteredFeatureId, windowKey: string): string {
    return hashOpaque(["usage-window-v2", featureId, windowKey]);
}

function previewDocumentId(previewKey: string): string {
    return hashOpaque(["usage-preview-v2", previewKey]);
}

function isHexDigest(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function parseStoredReservation(value: unknown): StoredReservation | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if ((data.status !== "reserved" && data.status !== "finalized" && data.status !== "denied") ||
        typeof data.payloadDigest !== "string" || !isHexDigest(data.authorizationId) ||
        typeof data.operationDigest !== "string" ||
        (data.environment !== "sandbox" && data.environment !== "production") ||
        typeof data.featureId !== "string" || !(data.featureId in METERED_FEATURES) ||
        typeof data.source !== "string" || typeof data.creditCost !== "number" ||
        typeof data.expiresAtMs !== "number" || !data.result || typeof data.result !== "object") {
        return null;
    }
    return data as unknown as StoredReservation;
}

export function sanitizeAuthorizeMonetizedOperationInput(
    value: unknown,
): AuthorizeMonetizedOperationInput {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new MonetizationInputError("INVALID_PAYLOAD", "request must be an object.");
    }
    const input = value as Record<string, unknown>;
    if (typeof input.useCredits !== "boolean") {
        throw new MonetizationInputError(
            "CREDIT_CONSENT_REQUIRED",
            "useCredits must explicitly state whether this attempt may spend credits.",
        );
    }
    const usage = sanitizeUsageInput({
        operationId: input.operationId,
        featureId: input.featureId,
        variant: input.variant,
        executionRoute: input.executionRoute,
        connectivity: "online",
        outcome: "completed",
        app: input.app,
    });
    // Provider-backed features are authorized by the callable that performs
    // the provider work, never by a client reservation it could leave unused.
    if (!CLIENT_AUTHORIZED_FEATURE_IDS.includes(usage.featureId)) {
        throw new MonetizationInputError(
            "FEATURE_NOT_ENFORCED",
            "This feature is not enabled for commercial authorization.",
        );
    }
    return {
        operationId: usage.operationId,
        featureId: usage.featureId,
        ...(usage.variant ? { variant: usage.variant } : {}),
        executionRoute: usage.executionRoute,
        useCredits: input.useCredits,
        ...(usage.app ? { app: usage.app } : {}),
    };
}

function authorizationPayloadDigest(input: AuthorizeMonetizedOperationInput): string {
    return usagePayloadDigest({
        operationId: input.operationId,
        featureId: input.featureId,
        outcome: "completed",
        variant: input.variant,
        executionRoute: input.executionRoute,
        connectivity: "online",
        app: input.app,
    });
}

export function operationDigest(operationId: string): string {
    return createHash("sha256").update(operationId, "utf8").digest("hex");
}

function remainingAfterReservation(limit: number, completed: number, reserved: number): number {
    return Math.max(0, limit - completed - reserved);
}

async function authorizeInTransaction(params: {
    db: Firestore;
    uid: string;
    environment: MonetizationEnvironment;
    access: InternalTestAccess;
    input: AuthorizeMonetizedOperationInput;
    nowMs: number;
}): Promise<MonetizedOperationAuthorization> {
    const feature = METERED_FEATURES[params.input.featureId];
    const payloadDigest = authorizationPayloadDigest(params.input);
    const authorizationId = authorizationDocumentId(
        params.environment,
        params.uid,
        params.input.operationId,
    );
    const usageRef = usageAccountRef(params.environment, params.uid, params.db);
    const reservationRef = usageRef.collection("reservations").doc(authorizationId);
    const accountRef = accountStateRef(params.environment, params.uid, params.db);

    return params.db.runTransaction(async (transaction) => {
        const [accountSnapshot, reservationSnapshot] = await Promise.all([
            transaction.get(accountRef),
            transaction.get(reservationRef),
        ]);
        const account = parseAccountState({
            data: accountSnapshot.data(),
            uid: params.uid,
            environment: params.environment,
            nowMs: params.nowMs,
        });
        if (!account) throw new Error("Monetization account is missing or malformed.");

        const existing = reservationSnapshot.exists
            ? parseStoredReservation(reservationSnapshot.data())
            : null;
        if (reservationSnapshot.exists && !existing) {
            throw new Error("Stored authorization is malformed.");
        }
        if (existing && existing.payloadDigest !== payloadDigest) {
            throw new HttpsError("failed-precondition", "operationId was reused for another feature.", {
                reasonCode: "IDEMPOTENCY_KEY_REUSED",
            });
        }
        if (existing?.status === "reserved") {
            if (existing.expiresAtMs <= params.nowMs) {
                throw new HttpsError("failed-precondition", "The authorization expired.", {
                    reasonCode: "AUTHORIZATION_EXPIRED",
                });
            }
            return existing.result;
        }
        if (existing?.status === "finalized") {
            return {
                ...existing.result,
                allowed: false,
                authorizationId: null,
                reasonCode: "operation_already_finalized",
            };
        }

        const rule = feature.quotaByPlan[account.planId];
        const window = getRuleWindow(rule, params.nowMs);
        const windowId = window ? windowDocumentId(params.input.featureId, window.key) : null;
        const windowRef = windowId ? usageRef.collection("usageWindows").doc(windowId) : null;
        const rawPreviewKey = getPreviewKey({
            operationId: params.input.operationId,
            featureId: params.input.featureId,
            outcome: "completed",
            variant: params.input.variant,
            executionRoute: params.input.executionRoute,
            connectivity: "online",
            app: params.input.app,
        });
        const previewId = rawPreviewKey ? previewDocumentId(rawPreviewKey) : null;
        const previewRef = previewId ? usageRef.collection("previews").doc(previewId) : null;
        const [windowSnapshot, previewSnapshot] = await Promise.all([
            windowRef ? transaction.get(windowRef) : Promise.resolve(null),
            previewRef ? transaction.get(previewRef) : Promise.resolve(null),
        ]);
        const completed = safeNonNegativeInteger(windowSnapshot?.data()?.completedCount);
        const reserved = safeNonNegativeInteger(windowSnapshot?.data()?.reservedCount);
        let source: MonetizedAccessSource;
        let reasonCode: string;
        let allowed = true;
        let creditsToReserve = 0;
        let reserveQuota = false;
        let reservePreview = false;

        if (params.access.commercialQuotaBypass) {
            source = "internal_test";
            reasonCode = "internal_test_access";
        } else if (account.planId === "free" && previewRef && !previewSnapshot?.exists) {
            source = "preview";
            reasonCode = "preview_available";
            reservePreview = true;
        } else if (rule.kind === "unlimited_local") {
            source = "unlimited";
            reasonCode = "unlimited_local";
        } else if (rule.kind === "measure_only") {
            source = "measurement_only";
            reasonCode = "measurement_only";
            reserveQuota = true;
        } else if (completed + reserved < rule.limit) {
            source = "included_use";
            reasonCode = "quota_available";
            reserveQuota = true;
        } else if (feature.creditCost !== null && params.input.useCredits &&
            account.creditBalance >= feature.creditCost) {
            source = "credits";
            reasonCode = "credits_authorized";
            creditsToReserve = feature.creditCost;
        } else {
            source = "quota_exhausted";
            allowed = false;
            reasonCode = feature.creditCost === null
                ? "upgrade_required"
                : params.input.useCredits
                    ? "insufficient_credits"
                    : "credit_consent_required";
        }

        const balanceAfter = account.creditBalance - creditsToReserve;
        const remaining = rule.kind === "metered"
            ? remainingAfterReservation(
                rule.limit,
                completed,
                reserved + (reserveQuota ? 1 : 0),
            )
            : null;
        const result: MonetizedOperationAuthorization = {
            schemaVersion: MONETIZATION_SCHEMA_VERSION,
            allowed,
            authorizationId: allowed ? authorizationId : null,
            environment: params.environment,
            featureId: params.input.featureId,
            planId: account.planId,
            source,
            reasonCode,
            creditCost: feature.creditCost,
            creditBalance: balanceAfter,
            remaining,
            resetsAt: window?.endMs ?? null,
        };

        transaction.set(usageRef, {
            schemaVersion: MONETIZATION_SCHEMA_VERSION,
            environment: params.environment,
            accountDocumentId: accountRef.id,
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        if (allowed && reserveQuota && windowRef && window) {
            transaction.set(windowRef, {
                schemaVersion: MONETIZATION_SCHEMA_VERSION,
                featureId: params.input.featureId,
                quotaKey: feature.quotaKey,
                windowStartMs: window.startMs,
                windowEndMs: window.endMs,
                completedCount: completed,
                reservedCount: reserved + 1,
                updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
        }
        if (allowed && reservePreview && previewRef) {
            transaction.create(previewRef, {
                schemaVersion: MONETIZATION_SCHEMA_VERSION,
                status: "reserved",
                authorizationId,
                featureId: params.input.featureId,
                variant: params.input.variant,
                expiresAtMs: params.nowMs + RESERVATION_TTL_MS,
                updatedAt: FieldValue.serverTimestamp(),
            });
        }
        if (creditsToReserve > 0) {
            account.creditBalance = balanceAfter;
            transaction.set(accountRef, accountStateWrite(account), { merge: true });
            transaction.create(usageRef.collection("creditLedger").doc(authorizationId), {
                schemaVersion: MONETIZATION_SCHEMA_VERSION,
                type: "operation_reservation",
                status: "reserved",
                authorizationId,
                creditDelta: -creditsToReserve,
                balanceAfter,
                featureId: params.input.featureId,
                createdAt: FieldValue.serverTimestamp(),
            });
        }

        transaction.set(reservationRef, {
            schemaVersion: MONETIZATION_SCHEMA_VERSION,
            status: allowed ? "reserved" : "denied",
            payloadDigest,
            authorizationId,
            operationDigest: operationDigest(params.input.operationId),
            environment: params.environment,
            featureId: params.input.featureId,
            ...(params.input.variant ? { variant: params.input.variant } : {}),
            source,
            creditCost: creditsToReserve,
            windowDocumentId: reserveQuota ? windowId : null,
            previewDocumentId: reservePreview ? previewId : null,
            expiresAtMs: allowed ? params.nowMs + RESERVATION_TTL_MS : params.nowMs,
            result,
            updatedAt: FieldValue.serverTimestamp(),
        });
        return result;
    });
}

export const authorizeMonetizedOperation = onCall(
    { cors: true, maxInstances: 40 },
    async (request) => {
        let input: AuthorizeMonetizedOperationInput;
        try {
            input = sanitizeAuthorizeMonetizedOperationInput(request.data);
        } catch (error) {
            mapMonetizationInputError(error);
        }
        const nowMs = Date.now();
        const context = await resolveRequestMonetizationContext(request, nowMs);
        try {
            await ensureMonetizationAccount({
                uid: context.uid,
                environment: context.environment,
            });
            return await authorizeInTransaction({
                db: getFirestore(),
                uid: context.uid,
                environment: context.environment,
                access: context.access,
                input: input as AuthorizeMonetizedOperationInput,
                nowMs,
            });
        } catch (error) {
            if (error instanceof HttpsError) throw error;
            logger.error("authorizeMonetizedOperation failed", {
                accountDigest: hashOpaque(["monetization-log-v1", context.uid]),
                featureId: (input as AuthorizeMonetizedOperationInput).featureId,
                errorName: error instanceof Error ? error.name : "UnknownError",
            });
            throw new HttpsError("internal", "Access could not be authorized.");
        }
    },
);

function sanitizeFinalizeInput(value: unknown): {
    operationId: string;
    authorizationId: string;
    outcome: FinalOutcome;
} {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpsError("invalid-argument", "request must be an object.");
    }
    const input = value as Record<string, unknown>;
    const validation = sanitizeUsageInput({
        operationId: input.operationId,
        featureId: "insights.advanced_report",
        executionRoute: "local_deterministic",
        connectivity: "online",
        outcome: input.outcome,
    });
    if (!isHexDigest(input.authorizationId)) {
        throw new HttpsError("invalid-argument", "authorizationId is invalid.");
    }
    return {
        operationId: validation.operationId,
        authorizationId: input.authorizationId,
        outcome: validation.outcome,
    };
}

function releaseWindowReservation(
    transaction: Transaction,
    windowRef: DocumentReference | null,
    windowData: FirebaseFirestore.DocumentData | undefined,
    completed: boolean,
): void {
    if (!windowRef) return;
    const reservedCount = safeNonNegativeInteger(windowData?.reservedCount);
    const completedCount = safeNonNegativeInteger(windowData?.completedCount);
    transaction.set(windowRef, {
        reservedCount: Math.max(0, reservedCount - 1),
        completedCount: completed ? completedCount + 1 : completedCount,
        updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
}

/** UTC calendar day used to bucket completed operations for the usage page. */
export function usageDayKey(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
}

/** Firestore map keys cannot hold the catalog's dotted ids unambiguously. */
export function usageCountKey(featureId: string): string {
    return featureId.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Per-day totals of completed operations, independent of plan windows, so
 * the usage page can chart activity across plan changes. Increment-only, so it
 * needs no read inside the finalizing transaction.
 */
function recordDailyUsage(
    transaction: Transaction,
    usageRef: DocumentReference,
    featureId: MeteredFeatureId,
    creditsSpent: number,
    nowMs: number,
): void {
    const day = usageDayKey(nowMs);
    transaction.set(usageRef.collection("usageDays").doc(day), {
        schemaVersion: MONETIZATION_SCHEMA_VERSION,
        day,
        counts: { [usageCountKey(featureId)]: FieldValue.increment(1) },
        ...(creditsSpent > 0 ? { creditsSpent: FieldValue.increment(creditsSpent) } : {}),
        updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
}

export async function finalizeReservationInTransaction(params: {
    transaction: Transaction;
    db: Firestore;
    accountId: string;
    reservationId: string;
    expectedAuthorizationId?: string;
    expectedOperationDigest?: string;
    outcome: FinalOutcome;
    nowMs: number;
    allowExpiredRelease?: boolean;
}): Promise<FinalizeMonetizedOperationResult> {
    const usageRef = params.db.collection(MONETIZATION_USAGE_ACCOUNT_COLLECTION).doc(params.accountId);
    const accountRef = params.db.collection(MONETIZATION_ACCOUNT_STATE_COLLECTION).doc(params.accountId);
    const reservationRef = usageRef.collection("reservations").doc(params.reservationId);
    const transaction = params.transaction;
    const reservationSnapshot = await transaction.get(reservationRef);
        if (!reservationSnapshot.exists) {
            throw new HttpsError("not-found", "Authorization was not found.", {
                reasonCode: "AUTHORIZATION_NOT_FOUND",
            });
        }
        const reservation = parseStoredReservation(reservationSnapshot.data());
        if (!reservation) throw new Error("Stored authorization is malformed.");
        if (params.expectedAuthorizationId &&
            reservation.authorizationId !== params.expectedAuthorizationId) {
            throw new HttpsError("permission-denied", "Authorization does not match this operation.");
        }
        if (params.expectedOperationDigest &&
            reservation.operationDigest !== params.expectedOperationDigest) {
            throw new HttpsError("permission-denied", "Authorization does not match this operation.");
        }

        const accountSnapshot = await transaction.get(accountRef);
        const accountData = accountSnapshot.data();
        if (!accountData || accountData.schemaVersion !== 1) {
            throw new Error("Monetization account is missing.");
        }
        if (reservation.status === "finalized") {
            if (!reservation.finalResult) throw new Error("Stored finalization is malformed.");
            if (reservation.finalResult.outcome !== params.outcome) {
                throw new HttpsError("failed-precondition", "Operation already has another outcome.", {
                    reasonCode: "FINAL_OUTCOME_CONFLICT",
                });
            }
            return { ...reservation.finalResult, duplicate: true };
        }
        if (reservation.status !== "reserved") {
            throw new HttpsError("failed-precondition", "Denied access cannot be finalized.");
        }
        if (reservation.expiresAtMs <= params.nowMs && !params.allowExpiredRelease) {
            throw new HttpsError("failed-precondition", "The authorization expired.", {
                reasonCode: "AUTHORIZATION_EXPIRED",
            });
        }

        const windowRef = reservation.windowDocumentId
            ? usageRef.collection("usageWindows").doc(reservation.windowDocumentId)
            : null;
        const previewRef = reservation.previewDocumentId
            ? usageRef.collection("previews").doc(reservation.previewDocumentId)
            : null;
        const ledgerRef = reservation.creditCost > 0
            ? usageRef.collection("creditLedger").doc(reservation.authorizationId)
            : null;
        const [windowSnapshot, previewSnapshot, ledgerSnapshot] = await Promise.all([
            windowRef ? transaction.get(windowRef) : Promise.resolve(null),
            previewRef ? transaction.get(previewRef) : Promise.resolve(null),
            ledgerRef ? transaction.get(ledgerRef) : Promise.resolve(null),
        ]);
        const completed = params.outcome === "completed";
        releaseWindowReservation(transaction, windowRef, windowSnapshot?.data(), completed);
        if (completed) {
            recordDailyUsage(transaction, usageRef, reservation.featureId, reservation.creditCost, params.nowMs);
        }

        if (previewRef) {
            if (previewSnapshot?.data()?.authorizationId === reservation.authorizationId) {
                if (completed) {
                    transaction.set(previewRef, {
                        status: "consumed",
                        consumedAt: FieldValue.serverTimestamp(),
                        updatedAt: FieldValue.serverTimestamp(),
                    }, { merge: true });
                } else {
                    transaction.delete(previewRef);
                }
            } else {
                throw new Error("Preview reservation binding changed.");
            }
        }

        let creditBalance = safeNonNegativeInteger(accountData.creditBalance);
        let creditDebt = safeNonNegativeInteger(accountData.creditDebt);
        if (reservation.creditCost > 0 && ledgerRef) {
            if (!ledgerSnapshot?.exists || ledgerSnapshot.data()?.status !== "reserved") {
                throw new Error("Credit reservation is missing or already changed.");
            }
            if (completed) {
                transaction.update(ledgerRef, {
                    status: "spent",
                    finalizedAt: FieldValue.serverTimestamp(),
                });
            } else {
                const netAfterRelease = creditBalance - creditDebt + reservation.creditCost;
                creditBalance = Math.max(0, netAfterRelease);
                creditDebt = Math.max(0, -netAfterRelease);
                transaction.update(accountRef, {
                    creditBalance,
                    creditDebt,
                    updatedAt: FieldValue.serverTimestamp(),
                });
                transaction.update(ledgerRef, {
                    status: "released",
                    creditDelta: 0,
                    balanceAfter: creditBalance,
                    debtAfter: creditDebt,
                    finalizedAt: FieldValue.serverTimestamp(),
                });
            }
        }

        const result: FinalizeMonetizedOperationResult = {
            schemaVersion: MONETIZATION_SCHEMA_VERSION,
            accepted: true,
            duplicate: false,
            outcome: params.outcome,
            creditBalance,
            serverTime: params.nowMs,
        };
        transaction.update(reservationRef, {
            status: "finalized",
            outcome: params.outcome,
            finalResult: result,
            finalizedAt: FieldValue.serverTimestamp(),
            purgeAfterMs: params.nowMs + FINALIZED_RESERVATION_RETENTION_MS,
            updatedAt: FieldValue.serverTimestamp(),
        });
    return result;
}

async function finalizeReservation(params: {
    db: Firestore;
    accountId: string;
    reservationId: string;
    expectedAuthorizationId?: string;
    expectedOperationDigest?: string;
    outcome: FinalOutcome;
    nowMs: number;
    allowExpiredRelease?: boolean;
}): Promise<FinalizeMonetizedOperationResult> {
    return params.db.runTransaction((transaction) => finalizeReservationInTransaction({
        ...params,
        transaction,
    }));
}

export const finalizeMonetizedOperation = onCall(
    { cors: true, maxInstances: 40 },
    async (request) => {
        const input = sanitizeFinalizeInput(request.data);
        const context = await resolveRequestMonetizationContext(request);
        const accountId = accountDocumentId(context.environment, context.uid);
        try {
            return await finalizeReservation({
                db: getFirestore(),
                accountId,
                reservationId: input.authorizationId,
                expectedAuthorizationId: input.authorizationId,
                expectedOperationDigest: operationDigest(input.operationId),
                outcome: input.outcome,
                nowMs: Date.now(),
            });
        } catch (error) {
            if (error instanceof HttpsError) throw error;
            logger.error("finalizeMonetizedOperation failed", {
                accountDigest: hashOpaque(["monetization-log-v1", context.uid]),
                errorName: error instanceof Error ? error.name : "UnknownError",
            });
            throw new HttpsError("internal", "The operation could not be finalized.");
        }
    },
);

/** Thrown by provider callables when the caller's included uses ran out. */
export function quotaExhaustedError(decision: MonetizedOperationAuthorization): HttpsError {
    const feature = METERED_FEATURES[decision.featureId];
    return new HttpsError(
        "resource-exhausted",
        `You've used all your included ${feature.unit.other} for now.`,
        { reasonCode: decision.reasonCode, monetization: decision },
    );
}

/**
 * Reserve one use of a provider-backed feature from inside the callable that
 * performs it. `operationKey` must be stable for one logical attempt so a
 * retried request returns the original decision instead of charging twice.
 */
export async function authorizeServerMeteredOperation(params: {
    uid: string;
    environment: MonetizationEnvironment;
    access: InternalTestAccess;
    featureId: MeteredFeatureId;
    operationKey: string;
    useCredits: boolean;
    nowMs?: number;
    db?: Firestore;
}): Promise<MonetizedOperationAuthorization> {
    const feature = METERED_FEATURES[params.featureId];
    if (feature.enforcement !== "server_internal") {
        throw new Error(`${params.featureId} is not a server-internal feature.`);
    }
    await ensureMonetizationAccount({ uid: params.uid, environment: params.environment, db: params.db });
    return authorizeInTransaction({
        db: params.db ?? getFirestore(),
        uid: params.uid,
        environment: params.environment,
        access: params.access,
        input: {
            operationId: params.operationKey,
            featureId: params.featureId,
            executionRoute: "provider",
            useCredits: params.useCredits,
        },
        nowMs: params.nowMs ?? Date.now(),
    });
}

/** Completes or releases a reservation made by authorizeServerMeteredOperation. */
export async function finalizeServerMeteredOperation(params: {
    uid: string;
    environment: MonetizationEnvironment;
    authorization: MonetizedOperationAuthorization;
    operationKey: string;
    outcome: FinalOutcome;
    nowMs?: number;
    db?: Firestore;
}): Promise<FinalizeMonetizedOperationResult | null> {
    if (!params.authorization.allowed || !params.authorization.authorizationId) return null;
    return finalizeReservation({
        db: params.db ?? getFirestore(),
        accountId: accountDocumentId(params.environment, params.uid),
        reservationId: params.authorization.authorizationId,
        expectedAuthorizationId: params.authorization.authorizationId,
        expectedOperationDigest: operationDigest(params.operationKey),
        outcome: params.outcome,
        nowMs: params.nowMs ?? Date.now(),
        allowExpiredRelease: params.outcome !== "completed",
    });
}

/** Support tooling and the scheduled reaper share this fail-safe release path. */
export async function releaseMonetizationReservation(params: {
    accountId: string;
    reservationId: string;
    nowMs?: number;
    db?: Firestore;
}): Promise<FinalizeMonetizedOperationResult> {
    return finalizeReservation({
        db: params.db ?? getFirestore(),
        accountId: params.accountId,
        reservationId: params.reservationId,
        outcome: "abandoned",
        nowMs: params.nowMs ?? Date.now(),
        allowExpiredRelease: true,
    });
}

export const reapExpiredMonetizationReservations = onSchedule(
    {
        schedule: "every 15 minutes",
        timeZone: "Etc/UTC",
        retryCount: 3,
        maxInstances: 1,
    },
    async () => {
        const db = getFirestore();
        const nowMs = Date.now();
        const snapshot = await db.collectionGroup("reservations")
            .where("expiresAtMs", "<=", nowMs)
            .limit(200)
            .get();
        let released = 0;
        for (const document of snapshot.docs) {
            if (document.data().status !== "reserved") continue;
            const usageRoot = document.ref.parent.parent;
            if (!usageRoot || usageRoot.parent.id !== MONETIZATION_USAGE_ACCOUNT_COLLECTION) continue;
            try {
                await releaseMonetizationReservation({
                    db,
                    accountId: usageRoot.id,
                    reservationId: document.id,
                    nowMs,
                });
                released += 1;
            } catch (error) {
                logger.warn("Expired monetization reservation release failed", {
                    accountDigest: hashOpaque(["reservation-account-v1", usageRoot.id]),
                    reservationDigest: hashOpaque(["reservation-v1", document.id]),
                    errorName: error instanceof Error ? error.name : "UnknownError",
                });
            }
        }
        logger.info("Expired monetization reservation sweep complete", {
            inspected: snapshot.size,
            released,
        });
    },
);
