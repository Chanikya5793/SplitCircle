/**
 * Monetization snapshot and compatibility telemetry.
 *
 * New clients authorize and finalize billable operations through the
 * reservation callables. This module keeps the privacy-minimized terminal
 * event path for rollout measurement and older clients; those records never
 * mint or spend credits by themselves.
 */

import { FieldValue, getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { APPLE_COMMERCE_PUBLIC_CATALOG } from "./commerceCatalog";
import {
    METERED_FEATURES,
    MONETIZATION_CATALOG,
    MONETIZATION_CATALOG_VERSION,
    MONETIZATION_SCHEMA_VERSION,
    type MeteredFeatureId,
    type MonetizationEnvironment,
    type PlanId,
} from "./monetizationCatalog";
import {
    MonetizationInputError,
    SHADOW_INGESTION_LIMIT_PER_UTC_DAY,
    evaluateShadowDecision,
    getPreviewKey,
    getRuleWindow,
    hashOpaque,
    monetizationAccountDocumentId,
    projectPrivacySafeUsage,
    sanitizeUsageInput,
    usageEventId,
    usagePayloadDigest,
    type InternalTestAccess,
    type SanitizedUsageInput,
    type ServerPlanState,
    type ShadowDecision,
} from "./monetizationCore";
import { ensureMonetizationAccount } from "./monetizationStore";
import { resolveRequestMonetizationContext } from "./monetizationRequest";

const ACCOUNT_STATE_COLLECTION = "monetizationAccountStates";
const INTERNAL_TEST_GRANT_COLLECTION = "monetizationInternalTestGrants";
const SHADOW_ACCOUNT_COLLECTION = "monetizationShadowAccounts";

class MonetizationConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MonetizationConflictError";
    }
}

class MonetizationRateLimitError extends Error {
    constructor() {
        super("Shadow usage ingestion limit reached.");
        this.name = "MonetizationRateLimitError";
    }
}

export interface MonetizationSnapshotResult {
    schemaVersion: 1;
    serverTime: number;
    catalog: typeof MONETIZATION_CATALOG;
    account: {
        environment: MonetizationEnvironment;
        planId: PlanId;
        planSource: ServerPlanState["source"];
        validUntil: number | null;
        activeSubscriptionProductId: string | null;
        creditBalance: number;
        creditDebt: number;
        appAccountToken: string;
        access: InternalTestAccess;
    };
    commerce: {
        enabled: true;
        platform: "ios";
        bundleId: string;
        appAppleId: number;
        verificationCallable: "verifyAppleTransaction";
        products: typeof APPLE_COMMERCE_PUBLIC_CATALOG.products;
    };
    capabilities: {
        appleVerification: true;
        creditPurchases: true;
        creditSpending: true;
        offlineLeases: false;
        friendGifting: false;
    };
    enforcement: {
        commercial: "server_enforced";
        blocksFeatures: true;
    };
}

export interface RecordMonetizationUsageResult {
    schemaVersion: 1;
    accepted: true;
    duplicate: boolean;
    enforcementApplied: false;
    allowed: true;
    environment: MonetizationEnvironment;
    featureId: MeteredFeatureId;
    quotaKey: string;
    planId: PlanId;
    accessSource: "standard" | "internal_test";
    telemetryTrust: "untrusted_research";
    shadowDecision: ShadowDecision;
    credits: {
        evaluated: false;
    };
    offline: {
        reconciled: boolean;
        leaseVerified: false;
        windowBasis: "server_received_at";
    };
}

export function getMonetizationStoragePaths(params: {
    environment: MonetizationEnvironment;
    uid: string;
    operationId?: string;
}): {
    accountState: string;
    internalTestGrant: string;
    shadowAccount: string;
    event?: string;
} {
    const accountId = monetizationAccountDocumentId(params.environment, params.uid);
    const base = `${SHADOW_ACCOUNT_COLLECTION}/${accountId}`;
    return {
        accountState: `${ACCOUNT_STATE_COLLECTION}/${accountId}`,
        internalTestGrant: `${INTERNAL_TEST_GRANT_COLLECTION}/${accountId}`,
        shadowAccount: base,
        ...(params.operationId ? {
            event: `${base}/events/${usageEventId(params.environment, params.uid, params.operationId)}`,
        } : {}),
    };
}

function publicAccess(access: InternalTestAccess): InternalTestAccess {
    // Keep this projection explicit so adding an issuer note or admin metadata
    // to the server-side resolver cannot leak it to the mobile client.
    return {
        kind: access.kind,
        commercialQuotaBypass: access.commercialQuotaBypass,
        providerSafetyBypass: false,
        grantId: access.grantId,
        grantExpiresAt: access.grantExpiresAt,
    };
}

function buildSnapshot(params: {
    nowMs: number;
    environment: MonetizationEnvironment;
    plan: ServerPlanState;
    access: InternalTestAccess;
    validUntil: number | null;
    activeSubscriptionProductId: string | null;
    creditBalance: number;
    creditDebt: number;
    appAccountToken: string;
}): MonetizationSnapshotResult {
    return {
        schemaVersion: MONETIZATION_SCHEMA_VERSION,
        serverTime: params.nowMs,
        catalog: MONETIZATION_CATALOG,
        account: {
            environment: params.environment,
            planId: params.plan.planId,
            planSource: params.plan.source,
            validUntil: params.validUntil,
            activeSubscriptionProductId: params.activeSubscriptionProductId,
            creditBalance: params.creditBalance,
            creditDebt: params.creditDebt,
            appAccountToken: params.appAccountToken,
            access: publicAccess(params.access),
        },
        commerce: {
            enabled: true,
            ...APPLE_COMMERCE_PUBLIC_CATALOG,
        },
        capabilities: {
            appleVerification: true,
            creditPurchases: true,
            creditSpending: true,
            offlineLeases: false,
            friendGifting: false,
        },
        enforcement: {
            commercial: "server_enforced",
            blocksFeatures: true,
        },
    };
}

function safeCount(value: unknown): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function utcDayKey(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
}

function windowDocumentId(featureId: MeteredFeatureId, windowKey: string): string {
    return hashOpaque(["usage-window-v1", featureId, windowKey]);
}

function previewDocumentId(previewKey: string): string {
    return hashOpaque(["usage-preview-v1", previewKey]);
}

function isStoredUsageResult(value: unknown): value is RecordMonetizationUsageResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<RecordMonetizationUsageResult>;
    return candidate.schemaVersion === 1 && candidate.accepted === true &&
        candidate.enforcementApplied === false && candidate.allowed === true &&
        typeof candidate.featureId === "string" && typeof candidate.quotaKey === "string" &&
        !!candidate.shadowDecision && typeof candidate.shadowDecision === "object";
}

async function persistShadowUsage(params: {
    uid: string;
    environment: MonetizationEnvironment;
    nowMs: number;
    plan: ServerPlanState;
    access: InternalTestAccess;
    input: SanitizedUsageInput;
}): Promise<RecordMonetizationUsageResult> {
    const db = getFirestore();
    const feature = METERED_FEATURES[params.input.featureId];
    const rule = feature.quotaByPlan[params.plan.planId];
    const window = getRuleWindow(rule, params.nowMs);
    const previewKey = getPreviewKey(params.input);
    const paths = getMonetizationStoragePaths({
        environment: params.environment,
        uid: params.uid,
        operationId: params.input.operationId,
    });
    const accountRef = db.doc(paths.shadowAccount);
    const eventRef = db.doc(paths.event as string);
    const ingestionRef = accountRef.collection("ingestionWindows").doc(utcDayKey(params.nowMs));
    const windowRef = window
        ? accountRef.collection("usageWindows").doc(windowDocumentId(params.input.featureId, window.key))
        : null;
    const previewRef = previewKey
        ? accountRef.collection("previews").doc(previewDocumentId(previewKey))
        : null;
    const payloadDigest = usagePayloadDigest(params.input);
    const eventId = eventRef.id;

    return db.runTransaction(async (transaction) => {
        const existing = await transaction.get(eventRef);
        if (existing.exists) {
            const data = existing.data();
            if (!data) throw new Error("Stored monetization event is malformed.");
            if (data.payloadDigest !== payloadDigest) {
                throw new MonetizationConflictError(
                    "operationId was already used for a different terminal usage record.",
                );
            }
            if (!isStoredUsageResult(data.result)) {
                throw new Error("Stored monetization result is malformed.");
            }
            return { ...data.result, duplicate: true };
        }

        const ingestionSnapshot = await transaction.get(ingestionRef);
        const ingestedBefore = safeCount(ingestionSnapshot.data()?.count);
        if (ingestedBefore >= SHADOW_INGESTION_LIMIT_PER_UTC_DAY) {
            throw new MonetizationRateLimitError();
        }

        const windowSnapshot = windowRef ? await transaction.get(windowRef) : null;
        const usedBefore = safeCount(windowSnapshot?.data()?.completedCount);

        let previewAvailable = false;
        if (previewRef && params.plan.planId === "free" &&
            !params.access.commercialQuotaBypass && params.input.outcome === "completed") {
            const previewSnapshot = await transaction.get(previewRef);
            previewAvailable = !previewSnapshot.exists;
        }

        const shadowDecision = evaluateShadowDecision({
            planId: params.plan.planId,
            feature,
            outcome: params.input.outcome,
            access: params.access,
            usedBefore,
            previewAvailable,
            window,
        });
        const result: RecordMonetizationUsageResult = {
            schemaVersion: MONETIZATION_SCHEMA_VERSION,
            accepted: true,
            duplicate: false,
            enforcementApplied: false,
            allowed: true,
            environment: params.environment,
            featureId: params.input.featureId,
            quotaKey: feature.quotaKey,
            planId: params.plan.planId,
            accessSource: params.access.kind,
            telemetryTrust: "untrusted_research",
            shadowDecision,
            credits: { evaluated: false },
            offline: {
                reconciled: params.input.connectivity === "offline_reconciled",
                leaseVerified: false,
                windowBasis: "server_received_at",
            },
        };

        transaction.set(accountRef, {
            schemaVersion: MONETIZATION_SCHEMA_VERSION,
            uid: params.uid,
            environment: params.environment,
            lastCatalogVersion: MONETIZATION_CATALOG_VERSION,
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.set(ingestionRef, {
            schemaVersion: MONETIZATION_SCHEMA_VERSION,
            environment: params.environment,
            utcDay: utcDayKey(params.nowMs),
            count: ingestedBefore + 1,
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        if (shadowDecision.claimedPreview && previewRef && previewKey) {
            transaction.create(previewRef, {
                schemaVersion: MONETIZATION_SCHEMA_VERSION,
                environment: params.environment,
                featureId: params.input.featureId,
                variant: params.input.variant,
                previewKeyDigest: hashOpaque([previewKey]),
                eventId,
                claimedAt: FieldValue.serverTimestamp(),
            });
        }

        if (shadowDecision.countedTowardQuota && windowRef && window) {
            transaction.set(windowRef, {
                schemaVersion: MONETIZATION_SCHEMA_VERSION,
                environment: params.environment,
                featureId: params.input.featureId,
                quotaKey: feature.quotaKey,
                cadence: rule.kind === "unlimited_local" ? null : rule.cadence,
                windowStartMs: window.startMs,
                windowEndMs: window.endMs,
                completedCount: shadowDecision.usedAfter,
                updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
        }

        transaction.create(eventRef, {
            ...projectPrivacySafeUsage(params.input),
            environment: params.environment,
            accountDigest: hashOpaque(["usage-account-v1", params.uid]),
            eventId,
            payloadDigest,
            planId: params.plan.planId,
            planSource: params.plan.source,
            accessSource: params.access.kind,
            telemetryTrust: "untrusted_research",
            internalTestGrantId: params.access.grantId,
            countedTowardQuota: shadowDecision.countedTowardQuota,
            claimedPreview: shadowDecision.claimedPreview,
            wouldAllow: shadowDecision.wouldAllow,
            result,
            receivedAt: FieldValue.serverTimestamp(),
        });
        return result;
    });
}

export const getMonetizationSnapshot = onCall({ cors: true, maxInstances: 20 }, async (request) => {
    const nowMs = Date.now();
    const context = await resolveRequestMonetizationContext(request, nowMs);
    const uid = context.uid;
    try {
        const account = await ensureMonetizationAccount({
            uid,
            environment: context.environment,
        });
        const plan: ServerPlanState = account.planId === "free"
            ? { planId: "free", source: "default_free" }
            : { planId: account.planId, source: "server_projection" };
        return buildSnapshot({
            environment: context.environment,
            plan,
            access: context.access,
            validUntil: account.validUntilMs,
            activeSubscriptionProductId: account.activeSubscriptionProductId,
            creditBalance: account.creditBalance,
            creditDebt: account.creditDebt,
            appAccountToken: account.appAccountToken,
            nowMs,
        });
    } catch (error) {
        logger.error("getMonetizationSnapshot failed", {
            accountDigest: hashOpaque(["monetization-log-v1", uid]),
            errorName: error instanceof Error ? error.name : "UnknownError",
        });
        throw new HttpsError("internal", "Monetization information is temporarily unavailable.");
    }
});

export const recordMonetizationUsage = onCall({ cors: true, maxInstances: 20 }, async (request) => {
    const context = await resolveRequestMonetizationContext(request);
    const uid = context.uid;
    let input: SanitizedUsageInput;
    try {
        input = sanitizeUsageInput(request.data);
    } catch (error) {
        if (error instanceof MonetizationInputError) {
            throw new HttpsError("invalid-argument", error.message, { reasonCode: error.reasonCode });
        }
        throw error;
    }

    const nowMs = Date.now();
    try {
        const account = await ensureMonetizationAccount({
            uid,
            environment: context.environment,
        });
        const plan: ServerPlanState = account.planId === "free"
            ? { planId: "free", source: "default_free" }
            : { planId: account.planId, source: "server_projection" };
        return await persistShadowUsage({
            uid,
            environment: context.environment,
            nowMs,
            plan,
            access: context.access,
            input,
        });
    } catch (error) {
        if (error instanceof MonetizationConflictError) {
            throw new HttpsError("failed-precondition", error.message, {
                reasonCode: "IDEMPOTENCY_KEY_REUSED",
            });
        }
        if (error instanceof MonetizationRateLimitError) {
            throw new HttpsError("resource-exhausted", "Please try again later.", {
                reasonCode: "SHADOW_INGESTION_LIMIT",
            });
        }
        logger.error("recordMonetizationUsage failed", {
            accountDigest: hashOpaque(["monetization-log-v1", uid]),
            featureId: input.featureId,
            errorName: error instanceof Error ? error.name : "UnknownError",
        });
        throw new HttpsError("internal", "Usage could not be recorded.");
    }
});
