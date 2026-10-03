import { randomUUID } from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import {
    FieldValue,
    Timestamp,
    getFirestore,
    type Firestore,
} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { type MonetizationEnvironment } from "./monetizationCatalog";
import { hashOpaque } from "./monetizationCore";
import { finalizeReservationInTransaction } from "./monetizationEnforcement";
import {
    MAX_PRODUCTION_INTERNAL_TEST_GRANT_SECONDS,
    MAX_SANDBOX_INTERNAL_TEST_GRANT_SECONDS,
} from "./monetizationCore";
import {
    MONETIZATION_ACCOUNT_STATE_COLLECTION,
    MONETIZATION_ADMIN_AUDIT_COLLECTION,
    MONETIZATION_APPLE_TRANSACTION_COLLECTION,
    MONETIZATION_USAGE_ACCOUNT_COLLECTION,
    accountDocumentId,
    accountStateRef,
    ensureMonetizationAccount,
    parseAccountState,
} from "./monetizationStore";

const SUPPORT_GRANT_COLLECTION = "monetizationSupportGrants";
const SUPPORT_RATE_LIMIT_COLLECTION = "monetizationSupportRateLimits";
const INTERNAL_TEST_GRANT_COLLECTION = "monetizationInternalTestGrants";
const SANDBOX_COMMERCE_GRANT_COLLECTION = "monetizationSandboxCommerceGrants";
const TEST_ACCESS_OPERATION_COLLECTION = "monetizationTestAccessOperations";
const TEST_ACCESS_CONTROL_COLLECTION = "monetizationTestAccessControls";
const SUPPORT_CLAIM = "manasplitSupport";
const INTERNAL_TEST_CLAIM = "manasplitInternalTest";
const SANDBOX_COMMERCE_CLAIM = "manasplitSandboxCommerce";
const MAX_SUPPORT_CLAIM_SECONDS = 12 * 60 * 60;
const MAX_COURTESY_CREDITS_PER_ACTION = 500;
const MAX_COURTESY_CREDITS_PER_ACTOR_DAY = 2_000;
const TEST_ACCESS_OPERATION_LEASE_MS = 5 * 60 * 1_000;
const SAFE_UID = /^[^/\u0000-\u001f]{1,128}$/;
const SAFE_REASON = /^[A-Z0-9_]{3,40}$/;
const SAFE_TICKET = /^[A-Za-z0-9._-]{3,80}$/;
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SupportScope =
    | "monetization.read"
    | "monetization.credit_grant"
    | "monetization.reservation_release"
    | "monetization.test_access";

interface SupportActor {
    uid: string;
    role: "admin" | "support";
}

interface CourtesyCreditGrantResult {
    amount: number;
    creditBalance: number;
    creditDebt: number;
    duplicate: boolean;
}

type MonetizationTestAccessType = "internal_test" | "sandbox_commerce";
type MonetizationTestAccessAction = "grant" | "revoke";

interface MonetizationTestAccessResult {
    schemaVersion: 1;
    accepted: true;
    action: MonetizationTestAccessAction;
    accessType: MonetizationTestAccessType;
    expiresAt?: number;
    refreshTokenRequired: true;
    duplicate: boolean;
}

type MonetizationTestAccessMutationParams = {
    db?: Firestore;
    auth?: MonetizationTestAccessAuth;
    actor: SupportActor;
    targetUid: string;
    environment: MonetizationEnvironment;
    reasonCode: string;
    ticketId: string;
    action: MonetizationTestAccessAction;
    accessType: MonetizationTestAccessType;
    durationHours?: number;
    nowMs?: number;
};

export interface MonetizationTestAccessAuth {
    getUser(uid: string): Promise<{
        disabled: boolean;
        customClaims?: Record<string, unknown>;
    }>;
    setCustomUserClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
    revokeRefreshTokens(uid: string): Promise<void>;
}

function timestampToMillis(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value && typeof value === "object" && "toMillis" in value) {
        const fn = (value as { toMillis?: unknown }).toMillis;
        if (typeof fn === "function") {
            const result = fn.call(value);
            return typeof result === "number" && Number.isFinite(result) ? result : null;
        }
    }
    return null;
}

export async function requireSupportActor(
    request: { auth?: { uid: string; token: unknown } },
    requiredScope: SupportScope,
    dependencies: {
        auth?: Pick<MonetizationTestAccessAuth, "getUser">;
        db?: Firestore;
        nowMs?: number;
    } = {},
): Promise<SupportActor> {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
    const token = request.auth?.token && typeof request.auth.token === "object"
        ? request.auth.token as Record<string, unknown>
        : {};
    if (token.admin === true) {
        const currentUser = await (dependencies.auth ?? getAuth()).getUser(uid).catch(() => null);
        if (!currentUser || currentUser.disabled === true || currentUser.customClaims?.admin !== true) {
            throw new HttpsError(
                "permission-denied",
                "The operator's current server-side account is not an active admin.",
            );
        }
        return { uid, role: "admin" };
    }

    const raw = token[SUPPORT_CLAIM];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new HttpsError("permission-denied", "Support access is required.");
    }
    const claim = raw as Record<string, unknown>;
    const issuedAt = claim.issuedAtEpochSeconds;
    const expiresAt = claim.expiresAtEpochSeconds;
    const scopes = claim.scopes;
    const structurallyValid = claim.version === 1 && claim.role === "support" &&
        claim.subjectUid === uid && typeof claim.grantId === "string" &&
        UUID_PATTERN.test(claim.grantId) && Array.isArray(scopes) &&
        scopes.every((scope) => typeof scope === "string") && scopes.includes(requiredScope) &&
        typeof issuedAt === "number" && Number.isSafeInteger(issuedAt) &&
        typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) &&
        expiresAt > issuedAt && expiresAt - issuedAt <= MAX_SUPPORT_CLAIM_SECONDS;
    const nowMs = dependencies.nowMs ?? Date.now();
    if (!structurallyValid || (expiresAt as number) * 1_000 <= nowMs ||
        (issuedAt as number) * 1_000 > nowMs + 5 * 60 * 1_000) {
        throw new HttpsError("permission-denied", "Support access is invalid or expired.");
    }

    const grantId = hashOpaque(["support-grant-v1", uid]);
    const snapshot = await (dependencies.db ?? getFirestore())
        .collection(SUPPORT_GRANT_COLLECTION).doc(grantId).get();
    const data = snapshot.data();
    if (!snapshot.exists || data?.status !== "active" || data?.subjectUid !== uid ||
        data?.grantId !== claim.grantId || !Array.isArray(data?.scopes) ||
        !data.scopes.includes(requiredScope) ||
        timestampToMillis(data.expiresAt) !== (expiresAt as number) * 1_000 ||
        (timestampToMillis(data.expiresAt) ?? 0) <= nowMs) {
        throw new HttpsError("permission-denied", "Support access is not active.");
    }
    const currentUser = await (dependencies.auth ?? getAuth()).getUser(uid).catch(() => null);
    if (!currentUser || currentUser.disabled === true) {
        throw new HttpsError("permission-denied", "Support access is not active.");
    }
    return { uid, role: "support" };
}

function requireRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpsError("invalid-argument", "request must be an object.");
    }
    return value as Record<string, unknown>;
}

function requireTargetUid(value: unknown): string {
    if (typeof value !== "string" || !SAFE_UID.test(value)) {
        throw new HttpsError("invalid-argument", "targetUid is malformed.");
    }
    return value;
}

function requireEnvironment(value: unknown): MonetizationEnvironment {
    if (value !== "sandbox" && value !== "production") {
        throw new HttpsError("invalid-argument", "environment must be sandbox or production.");
    }
    return value;
}

function requireReason(value: unknown): string {
    if (typeof value !== "string" || !SAFE_REASON.test(value)) {
        throw new HttpsError("invalid-argument", "reasonCode is malformed.");
    }
    return value;
}

function requireTicket(value: unknown): string {
    if (typeof value !== "string" || !SAFE_TICKET.test(value)) {
        throw new HttpsError("invalid-argument", "ticketId is malformed.");
    }
    return value;
}

function auditRecord(params: {
    actor: SupportActor;
    action: string;
    targetUid: string;
    environment: MonetizationEnvironment;
    reasonCode: string;
    ticketId: string;
    metadata?: Record<string, unknown>;
}): Record<string, unknown> {
    return {
        schemaVersion: 1,
        actorUid: params.actor.uid,
        actorRole: params.actor.role,
        action: params.action,
        subjectUid: params.targetUid,
        environment: params.environment,
        reasonCode: params.reasonCode,
        ticketDigest: hashOpaque(["support-ticket-v1", params.ticketId]),
        ...params.metadata,
        createdAt: FieldValue.serverTimestamp(),
    };
}

export const getMonetizationSupportAccount = onCall(
    { cors: true, maxInstances: 10 },
    async (request) => {
        const actor = await requireSupportActor(request, "monetization.read");
        const input = requireRecord(request.data);
        const targetUid = requireTargetUid(input.targetUid);
        const environment = requireEnvironment(input.environment);
        const reasonCode = requireReason(input.reasonCode);
        const ticketId = requireTicket(input.ticketId);
        const db = getFirestore();
        const accountId = accountDocumentId(environment, targetUid);
        const accountRef = db.collection(MONETIZATION_ACCOUNT_STATE_COLLECTION).doc(accountId);
        const usageRef = db.collection(MONETIZATION_USAGE_ACCOUNT_COLLECTION).doc(accountId);
        const [accountSnapshot, reservations, creditLedger, purchases] = await Promise.all([
            accountRef.get(),
            usageRef.collection("reservations").limit(20).get(),
            usageRef.collection("creditLedger").limit(20).get(),
            db.collection(MONETIZATION_APPLE_TRANSACTION_COLLECTION)
                .where("accountDocumentId", "==", accountId).limit(20).get(),
        ]);
        const account = parseAccountState({
            data: accountSnapshot.data(),
            uid: targetUid,
            environment,
        });
        if (!account) throw new HttpsError("not-found", "No monetization account was found.");

        await db.collection(MONETIZATION_ADMIN_AUDIT_COLLECTION).doc(randomUUID()).set(
            auditRecord({
                actor,
                action: "support_account_read",
                targetUid,
                environment,
                reasonCode,
                ticketId,
            }),
        );
        return {
            schemaVersion: 1,
            account: {
                environment,
                accountDigest: hashOpaque(["support-account-v1", accountId]),
                planId: account.planId,
                validUntil: account.validUntilMs,
                creditBalance: account.creditBalance,
                creditDebt: account.creditDebt,
                subscriptionCount: Object.keys(account.subscriptions).length,
            },
            reservations: reservations.docs.map((document) => ({
                authorizationId: document.id,
                status: document.data().status ?? "unknown",
                featureId: document.data().featureId ?? "unknown",
                source: document.data().source ?? "unknown",
                expiresAt: document.data().expiresAtMs ?? null,
                outcome: document.data().outcome ?? null,
            })),
            creditLedger: creditLedger.docs.map((document) => ({
                entryDigest: hashOpaque(["credit-ledger-entry-v1", document.id]),
                type: document.data().type ?? "unknown",
                status: document.data().status ?? "unknown",
                creditDelta: document.data().creditDelta ?? 0,
                balanceAfter: document.data().balanceAfter ?? null,
            })),
            purchases: purchases.docs.map((document) => ({
                transactionDigest: hashOpaque([
                    "support-transaction-v1",
                    String(document.data().transactionId ?? document.id),
                ]),
                productId: document.data().productId ?? "unknown",
                purchaseKind: document.data().purchaseKind ?? "unknown",
                refunded: document.data().refunded === true,
                expiresAt: document.data().expiresAtMs ?? null,
            })),
            serverTime: Date.now(),
        };
    },
);

export const grantMonetizationCourtesyCredits = onCall(
    { cors: true, maxInstances: 10 },
    async (request) => {
        const actor = await requireSupportActor(request, "monetization.credit_grant");
        const input = requireRecord(request.data);
        const targetUid = requireTargetUid(input.targetUid);
        const environment = requireEnvironment(input.environment);
        const reasonCode = requireReason(input.reasonCode);
        const ticketId = requireTicket(input.ticketId);
        const amount = input.amount;
        if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1 ||
            amount > MAX_COURTESY_CREDITS_PER_ACTION) {
            throw new HttpsError("invalid-argument", "amount must be between 1 and 500 credits.");
        }
        await getAuth().getUser(targetUid);
        const result = await grantCourtesyCreditsForSupport({
            db: getFirestore(),
            actor,
            targetUid,
            environment,
            reasonCode,
            ticketId,
            amount,
        });
        return { schemaVersion: 1, accepted: true, ...result, serverTime: Date.now() };
    },
);

/**
 * Applies a support credit grant exactly once for a customer ticket. The actor is
 * intentionally not part of the key so a retry after a support handoff cannot
 * grant the same adjustment twice.
 */
export async function grantCourtesyCreditsForSupport(params: {
    db?: Firestore;
    actor: SupportActor;
    targetUid: string;
    environment: MonetizationEnvironment;
    reasonCode: string;
    ticketId: string;
    amount: number;
    nowMs?: number;
}): Promise<CourtesyCreditGrantResult> {
    const db = params.db ?? getFirestore();
    const nowMs = params.nowMs ?? Date.now();
    await ensureMonetizationAccount({
        uid: params.targetUid,
        environment: params.environment,
        db,
    });
    const accountRef = accountStateRef(params.environment, params.targetUid, db);
    const accountId = accountRef.id;
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const ticketDigest = hashOpaque(["support-ticket-v1", params.ticketId]);
    const idempotencyId = hashOpaque([
        "courtesy-credit-idempotency-v1",
        params.environment,
        params.targetUid,
        params.ticketId,
    ]);
    const requestDigest = hashOpaque([
        "courtesy-credit-request-v1",
        params.environment,
        params.targetUid,
        params.ticketId,
        params.reasonCode,
        String(params.amount),
    ]);
    const usageRef = db.collection(MONETIZATION_USAGE_ACCOUNT_COLLECTION).doc(accountId);
    const grantRef = usageRef.collection("supportCourtesyGrants").doc(idempotencyId);
    const rateRef = db.collection(SUPPORT_RATE_LIMIT_COLLECTION).doc(hashOpaque([
        "courtesy-credit-rate-v1",
        params.actor.uid,
        day,
    ]));
    const ledgerRef = usageRef.collection("creditLedger").doc(idempotencyId);
    const auditRef = db.collection(MONETIZATION_ADMIN_AUDIT_COLLECTION).doc(idempotencyId);

    return db.runTransaction(async (transaction) => {
        const [grantSnapshot, accountSnapshot, rateSnapshot] = await Promise.all([
            transaction.get(grantRef),
            transaction.get(accountRef),
            transaction.get(rateRef),
        ]);
        if (grantSnapshot.exists) {
            const grant = grantSnapshot.data();
            if (grant?.requestDigest !== requestDigest) {
                throw new HttpsError(
                    "failed-precondition",
                    "This ticket was already used for a different courtesy credit request.",
                    { reasonCode: "IDEMPOTENCY_KEY_REUSED" },
                );
            }
            if (!Number.isSafeInteger(grant.amount) || !Number.isSafeInteger(grant.creditBalance) ||
                !Number.isSafeInteger(grant.creditDebt)) {
                throw new Error("Stored courtesy credit result is malformed.");
            }
            return {
                amount: grant.amount as number,
                creditBalance: grant.creditBalance as number,
                creditDebt: grant.creditDebt as number,
                duplicate: true,
            };
        }

        const account = parseAccountState({
            data: accountSnapshot.data(),
            uid: params.targetUid,
            environment: params.environment,
        });
        if (!account) throw new Error("Monetization account is missing.");
        const usedToday = typeof rateSnapshot.data()?.creditsGranted === "number"
            ? rateSnapshot.data()?.creditsGranted as number
            : 0;
        if (usedToday + params.amount > MAX_COURTESY_CREDITS_PER_ACTOR_DAY) {
            throw new HttpsError("resource-exhausted", "Daily courtesy credit limit reached.");
        }
        const netAfter = account.creditBalance - account.creditDebt + params.amount;
        account.creditBalance = Math.max(0, netAfter);
        account.creditDebt = Math.max(0, -netAfter);
        const result = {
            amount: params.amount,
            creditBalance: account.creditBalance,
            creditDebt: account.creditDebt,
        };

        transaction.set(accountRef, {
            creditBalance: account.creditBalance,
            creditDebt: account.creditDebt,
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.set(rateRef, {
            actorUid: params.actor.uid,
            utcDay: day,
            creditsGranted: usedToday + params.amount,
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.create(ledgerRef, {
            schemaVersion: 1,
            type: "support_courtesy_credit",
            status: "settled",
            creditDelta: params.amount,
            balanceAfter: account.creditBalance,
            debtAfter: account.creditDebt,
            reasonCode: params.reasonCode,
            ticketDigest,
            createdAt: FieldValue.serverTimestamp(),
        });
        transaction.create(auditRef, auditRecord({
            actor: params.actor,
            action: "courtesy_credits_granted",
            targetUid: params.targetUid,
            environment: params.environment,
            reasonCode: params.reasonCode,
            ticketId: params.ticketId,
            metadata: { amount: params.amount, balanceAfter: account.creditBalance },
        }));
        transaction.create(grantRef, {
            schemaVersion: 1,
            environment: params.environment,
            subjectUid: params.targetUid,
            ticketDigest,
            requestDigest,
            actorUid: params.actor.uid,
            ...result,
            createdAt: FieldValue.serverTimestamp(),
        });
        return { ...result, duplicate: false };
    });
}

export const releaseMonetizationReservationForSupport = onCall(
    { cors: true, maxInstances: 10 },
    async (request) => {
        const actor = await requireSupportActor(request, "monetization.reservation_release");
        const input = requireRecord(request.data);
        const targetUid = requireTargetUid(input.targetUid);
        const environment = requireEnvironment(input.environment);
        const reasonCode = requireReason(input.reasonCode);
        const ticketId = requireTicket(input.ticketId);
        const authorizationId = input.authorizationId;
        if (typeof authorizationId !== "string" || !/^[0-9a-f]{64}$/.test(authorizationId)) {
            throw new HttpsError("invalid-argument", "authorizationId is malformed.");
        }
        const db = getFirestore();
        return releaseReservationForSupport({
            db,
            actor,
            targetUid,
            environment,
            reasonCode,
            ticketId,
            authorizationId,
        });
    },
);

/** Commits the reservation release and its support audit record atomically. */
export async function releaseReservationForSupport(params: {
    db?: Firestore;
    actor: SupportActor;
    targetUid: string;
    environment: MonetizationEnvironment;
    reasonCode: string;
    ticketId: string;
    authorizationId: string;
    nowMs?: number;
}) {
    const db = params.db ?? getFirestore();
    const nowMs = params.nowMs ?? Date.now();
    const auditRef = db.collection(MONETIZATION_ADMIN_AUDIT_COLLECTION).doc(hashOpaque([
        "support-reservation-release-audit-v1",
        params.environment,
        params.targetUid,
        params.authorizationId,
        params.ticketId,
    ]));
    return db.runTransaction(async (transaction) => {
        const auditSnapshot = await transaction.get(auditRef);
        const released = await finalizeReservationInTransaction({
            transaction,
            db,
            accountId: accountDocumentId(params.environment, params.targetUid),
            reservationId: params.authorizationId,
            outcome: "abandoned",
            nowMs,
            allowExpiredRelease: true,
        });
        if (!auditSnapshot.exists) transaction.create(auditRef, auditRecord({
            actor: params.actor,
            action: "reservation_released",
            targetUid: params.targetUid,
            environment: params.environment,
            reasonCode: params.reasonCode,
            ticketId: params.ticketId,
            metadata: {
                reservationDigest: hashOpaque([
                    "support-reservation-v1",
                    params.authorizationId,
                ]),
                duplicate: released.duplicate,
            },
        }));
        return released;
    });
}

function internalTestClaim(params: {
    targetUid: string;
    environment: MonetizationEnvironment;
    grantId: string;
    reasonCode: string;
    issuedAtSeconds: number;
    expiresAtSeconds: number;
}): Record<string, unknown> {
    return {
        version: 1,
        role: "internal_tester",
        scope: "commercial_limits_only",
        environment: params.environment,
        providerSafetyBypass: false,
        subjectUid: params.targetUid,
        grantId: params.grantId,
        reasonCode: params.reasonCode,
        issuedAtEpochSeconds: params.issuedAtSeconds,
        expiresAtEpochSeconds: params.expiresAtSeconds,
    };
}

function sandboxCommerceClaim(params: {
    targetUid: string;
    grantId: string;
    issuedAtSeconds: number;
    expiresAtSeconds: number;
}): Record<string, unknown> {
    return {
        version: 1,
        role: "sandbox_commerce_tester",
        environment: "sandbox",
        subjectUid: params.targetUid,
        grantId: params.grantId,
        issuedAtEpochSeconds: params.issuedAtSeconds,
        expiresAtEpochSeconds: params.expiresAtSeconds,
    };
}

function testAccessConfiguration(accessType: MonetizationTestAccessType) {
    return accessType === "internal_test"
        ? {
            collection: INTERNAL_TEST_GRANT_COLLECTION,
            claimKey: INTERNAL_TEST_CLAIM,
            role: "internal_tester",
        } as const
        : {
            collection: SANDBOX_COMMERCE_GRANT_COLLECTION,
            claimKey: SANDBOX_COMMERCE_CLAIM,
            role: "sandbox_commerce_tester",
        } as const;
}

function testAccessResultFromStored(
    data: Record<string, unknown>,
): MonetizationTestAccessResult | null {
    const action = data.action;
    const accessType = data.accessType;
    const expiresAt = data.expiresAtMs;
    if ((action !== "grant" && action !== "revoke") ||
        (accessType !== "internal_test" && accessType !== "sandbox_commerce") ||
        (expiresAt !== null && expiresAt !== undefined &&
            (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)))) {
        return null;
    }
    return {
        schemaVersion: 1,
        accepted: true,
        action,
        accessType,
        ...(typeof expiresAt === "number" ? { expiresAt } : {}),
        refreshTokenRequired: true,
        duplicate: true,
    };
}

function claimTargetsEnvironment(params: {
    claim: unknown;
    accessType: MonetizationTestAccessType;
    targetUid: string;
    environment: MonetizationEnvironment;
}): boolean {
    if (!params.claim || typeof params.claim !== "object" || Array.isArray(params.claim)) {
        return false;
    }
    const claim = params.claim as Record<string, unknown>;
    const expectedRole = params.accessType === "internal_test"
        ? "internal_tester"
        : "sandbox_commerce_tester";
    return claim.version === 1 && claim.role === expectedRole &&
        claim.subjectUid === params.targetUid && claim.environment === params.environment;
}

async function markTestAccessOperationFailed(params: {
    db: Firestore;
    operationId: string;
    controlId: string;
    leaseId: string;
    grantRef: FirebaseFirestore.DocumentReference;
    action: MonetizationTestAccessAction;
    grantId: string | null;
    message: string;
}): Promise<void> {
    await params.db.runTransaction(async (transaction) => {
        const controlRef = params.db.collection(TEST_ACCESS_CONTROL_COLLECTION)
            .doc(params.controlId);
        const operationRef = params.db.collection(TEST_ACCESS_OPERATION_COLLECTION)
            .doc(params.operationId);
        const controlSnapshot = await transaction.get(controlRef);
        const control = controlSnapshot.data();
        if (control?.operationId !== params.operationId || control?.leaseId !== params.leaseId) {
            return;
        }
        if (params.action === "grant") {
            transaction.set(params.grantRef, {
                status: "claim_sync_failed",
                grantId: params.grantId,
                claimSyncFailedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
        }
        transaction.set(operationRef, {
            status: "failed",
            failureMessage: params.message.slice(0, 160),
            failedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.set(controlRef, {
            status: "idle",
            leaseId: null,
            leaseExpiresAtMs: 0,
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
    });
}

async function setMonetizationTestAccessWithAuthority(
    params: MonetizationTestAccessMutationParams,
    allowSelfTarget: boolean,
): Promise<MonetizationTestAccessResult> {
    const db = params.db ?? getFirestore();
    const auth = params.auth ?? getAuth();
    const targetUid = requireTargetUid(params.targetUid);
    const environment = requireEnvironment(params.environment);
    const reasonCode = requireReason(params.reasonCode);
    const ticketId = requireTicket(params.ticketId);
    if (params.actor.role !== "admin") {
        throw new HttpsError("permission-denied", "Only an admin may manage test access.");
    }
    requireTargetUid(params.actor.uid);
    if (!allowSelfTarget && targetUid === params.actor.uid) {
        throw new HttpsError(
            "permission-denied",
            "Self-targeted test access must use the audited local operator command.",
            { reasonCode: "SELF_TARGET_REQUIRES_LOCAL_OPERATOR" },
        );
    }
    if (params.accessType === "sandbox_commerce" && environment !== "sandbox") {
        throw new HttpsError("invalid-argument", "Sandbox commerce access is sandbox-only.");
    }

    const nowMs = params.nowMs ?? Date.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new HttpsError("invalid-argument", "nowMs is invalid.");
    }
    let durationHours: number | null = null;
    if (params.action === "grant") {
        durationHours = params.durationHours ?? null;
        if (!Number.isSafeInteger(durationHours) || (durationHours ?? 0) < 1) {
            throw new HttpsError("invalid-argument", "durationHours must be a positive integer.");
        }
        const maximumSeconds = params.accessType === "sandbox_commerce"
            ? MAX_SANDBOX_INTERNAL_TEST_GRANT_SECONDS
            : environment === "sandbox"
                ? MAX_SANDBOX_INTERNAL_TEST_GRANT_SECONDS
                : MAX_PRODUCTION_INTERNAL_TEST_GRANT_SECONDS;
        if ((durationHours as number) * 60 * 60 > maximumSeconds) {
            throw new HttpsError(
                "invalid-argument",
                "The requested test access duration is too long.",
            );
        }
    }

    const [actorUser, targetUser] = await Promise.all([
        auth.getUser(params.actor.uid),
        auth.getUser(targetUid),
    ]);
    if (actorUser.disabled === true || actorUser.customClaims?.admin !== true) {
        throw new HttpsError(
            "permission-denied",
            "The operator's current server-side account is not an active admin.",
        );
    }
    if (targetUser.disabled === true) {
        throw new HttpsError("failed-precondition", "Test access cannot target a disabled user.");
    }

    const config = testAccessConfiguration(params.accessType);
    const operationId = hashOpaque([
        "test-access-operation-v1",
        environment,
        targetUid,
        params.accessType,
        ticketId,
    ]);
    const requestDigest = hashOpaque([
        "test-access-request-v1",
        environment,
        targetUid,
        params.accessType,
        params.action,
        reasonCode,
        String(durationHours ?? 0),
    ]);
    const controlId = hashOpaque([
        "test-access-control-v1",
        targetUid,
        config.claimKey,
    ]);
    const operationRef = db.collection(TEST_ACCESS_OPERATION_COLLECTION).doc(operationId);
    const controlRef = db.collection(TEST_ACCESS_CONTROL_COLLECTION).doc(controlId);
    const grantRef = db.collection(config.collection)
        .doc(accountDocumentId(environment, targetUid));
    const oppositeGrantRef = params.accessType === "internal_test"
        ? db.collection(config.collection).doc(accountDocumentId(
            environment === "sandbox" ? "production" : "sandbox",
            targetUid,
        ))
        : null;
    const leaseId = randomUUID();
    const proposedGrantId = params.action === "grant" ? randomUUID() : null;
    const proposedIssuedAtMs = Math.floor(nowMs / 1_000) * 1_000;
    const proposedExpiresAtMs = durationHours === null
        ? null
        : proposedIssuedAtMs + durationHours * 60 * 60 * 1_000;

    const prepared = await db.runTransaction(async (transaction) => {
        const reads = await Promise.all([
            transaction.get(operationRef),
            transaction.get(controlRef),
            ...(oppositeGrantRef ? [transaction.get(oppositeGrantRef)] : []),
        ]);
        const operationSnapshot = reads[0];
        const controlSnapshot = reads[1];
        const oppositeSnapshot = oppositeGrantRef ? reads[2] : null;
        const operation = operationSnapshot.data();
        const control = controlSnapshot.data();

        if (operationSnapshot.exists) {
            if (operation?.requestDigest !== requestDigest) {
                throw new HttpsError(
                    "failed-precondition",
                    "This ticket was already used for a different test-access request.",
                    { reasonCode: "IDEMPOTENCY_KEY_REUSED" },
                );
            }
            if (operation?.status === "completed") {
                const result = testAccessResultFromStored(operation);
                if (!result) throw new Error("Stored test-access result is malformed.");
                return { duplicateResult: result };
            }
            if (operation?.status === "superseded" ||
                control?.latestOperationId !== operationId ||
                control?.generation !== operation?.generation) {
                throw new HttpsError(
                    "failed-precondition",
                    "This test-access operation was superseded by a newer request.",
                    { reasonCode: "TEST_ACCESS_OPERATION_SUPERSEDED" },
                );
            }
        }

        if (control?.status === "processing" &&
            typeof control.leaseExpiresAtMs === "number" &&
            control.leaseExpiresAtMs > nowMs) {
            throw new HttpsError(
                "aborted",
                "Another test-access operation is already in progress for this user.",
                { reasonCode: "TEST_ACCESS_OPERATION_IN_PROGRESS" },
            );
        }

        const existingGeneration = typeof control?.generation === "number" &&
            Number.isSafeInteger(control.generation) ? control.generation as number : 0;
        const generation = operationSnapshot.exists
            ? operation?.generation as number
            : existingGeneration + 1;
        const grantId = operationSnapshot.exists && typeof operation?.grantId === "string"
            ? operation.grantId
            : proposedGrantId;
        const issuedAtMs = operationSnapshot.exists &&
            typeof operation?.issuedAtMs === "number"
            ? operation.issuedAtMs as number
            : proposedIssuedAtMs;
        const expiresAtMs = operationSnapshot.exists &&
            typeof operation?.expiresAtMs === "number"
            ? operation.expiresAtMs as number
            : proposedExpiresAtMs;
        if (params.action === "grant" &&
            (typeof grantId !== "string" || typeof expiresAtMs !== "number" ||
                expiresAtMs <= nowMs)) {
            throw new HttpsError(
                "failed-precondition",
                "This grant request has expired; use a new support ticket to issue another grant.",
                { reasonCode: "TEST_ACCESS_REQUEST_EXPIRED" },
            );
        }

        if (!operationSnapshot.exists && control?.status === "processing" &&
            typeof control.operationId === "string") {
            transaction.set(
                db.collection(TEST_ACCESS_OPERATION_COLLECTION).doc(control.operationId),
                {
                    status: "superseded",
                    supersededByOperationId: operationId,
                    supersededAt: FieldValue.serverTimestamp(),
                },
                { merge: true },
            );
        }

        transaction.set(controlRef, {
            schemaVersion: 1,
            status: "processing",
            subjectUid: targetUid,
            claimKey: config.claimKey,
            generation,
            latestOperationId: operationId,
            operationId,
            leaseId,
            leaseExpiresAtMs: nowMs + TEST_ACCESS_OPERATION_LEASE_MS,
            updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.set(operationRef, {
            schemaVersion: 1,
            status: params.action === "grant" ? "grant_pending_claim" : "revoke_pending_claim",
            requestDigest,
            operationId,
            generation,
            action: params.action,
            accessType: params.accessType,
            environment,
            subjectUid: targetUid,
            reasonCode,
            ticketDigest: hashOpaque(["support-ticket-v1", ticketId]),
            actorUid: params.actor.uid,
            grantId,
            issuedAtMs: params.action === "grant" ? issuedAtMs : null,
            expiresAtMs: params.action === "grant" ? expiresAtMs : null,
            leaseId,
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        if (params.action === "grant") {
            const issuedAt = Timestamp.fromMillis(issuedAtMs);
            const expiresAt = Timestamp.fromMillis(expiresAtMs as number);
            transaction.set(grantRef, {
                schemaVersion: 1,
                status: "pending_claim",
                role: config.role,
                ...(params.accessType === "internal_test" ? {
                    scope: "commercial_limits_only",
                    providerSafetyBypass: false,
                    reasonCode,
                } : {}),
                environment,
                subjectUid: targetUid,
                grantId,
                issuedAt,
                expiresAt,
                operationId,
                generation,
                preparedBy: params.actor.uid,
                preparedAt: FieldValue.serverTimestamp(),
            });
            if (oppositeGrantRef && oppositeSnapshot?.exists) {
                transaction.set(oppositeGrantRef, {
                    status: "superseded",
                    supersededByGrantId: grantId,
                    supersededByOperationId: operationId,
                    supersededAt: FieldValue.serverTimestamp(),
                }, { merge: true });
            }
        } else {
            transaction.set(grantRef, {
                schemaVersion: 1,
                status: "revoked",
                environment,
                subjectUid: targetUid,
                operationId,
                generation,
                revokedAt: FieldValue.serverTimestamp(),
                revokedBy: params.actor.uid,
                reasonCode,
            }, { merge: true });
        }
        return {
            duplicateResult: null,
            grantId,
            issuedAtMs,
            expiresAtMs,
            generation,
        };
    });

    if (prepared.duplicateResult) return prepared.duplicateResult;

    try {
        const latestTarget = await auth.getUser(targetUid);
        if (latestTarget.disabled === true) {
            throw new HttpsError(
                "failed-precondition",
                "Test access cannot target a disabled user.",
            );
        }
        const claims = { ...(latestTarget.customClaims ?? {}) };
        if (params.action === "grant") {
            const issuedAtSeconds = Math.floor(prepared.issuedAtMs / 1_000);
            const expiresAtSeconds = Math.floor((prepared.expiresAtMs as number) / 1_000);
            claims[config.claimKey] = params.accessType === "internal_test"
                ? internalTestClaim({
                    targetUid,
                    environment,
                    grantId: prepared.grantId as string,
                    reasonCode,
                    issuedAtSeconds,
                    expiresAtSeconds,
                })
                : sandboxCommerceClaim({
                    targetUid,
                    grantId: prepared.grantId as string,
                    issuedAtSeconds,
                    expiresAtSeconds,
                });
            await auth.setCustomUserClaims(targetUid, claims);
        } else if (claimTargetsEnvironment({
            claim: claims[config.claimKey],
            accessType: params.accessType,
            targetUid,
            environment,
        })) {
            delete claims[config.claimKey];
            await auth.setCustomUserClaims(targetUid, claims);
            await auth.revokeRefreshTokens(targetUid);
        }

        const result: MonetizationTestAccessResult = {
            schemaVersion: 1,
            accepted: true,
            action: params.action,
            accessType: params.accessType,
            ...(params.action === "grant"
                ? { expiresAt: prepared.expiresAtMs as number }
                : {}),
            refreshTokenRequired: true,
            duplicate: false,
        };
        await db.runTransaction(async (transaction) => {
            const [controlSnapshot, operationSnapshot, grantSnapshot] = await Promise.all([
                transaction.get(controlRef),
                transaction.get(operationRef),
                transaction.get(grantRef),
            ]);
            const control = controlSnapshot.data();
            const operation = operationSnapshot.data();
            const grant = grantSnapshot.data();
            const stillOwned = control?.status === "processing" &&
                control?.operationId === operationId && control?.leaseId === leaseId &&
                control?.generation === prepared.generation &&
                operation?.requestDigest === requestDigest && operation?.leaseId === leaseId;
            const grantMatches = params.action === "revoke"
                ? grant?.status === "revoked" && grant?.operationId === operationId
                : grant?.status === "pending_claim" && grant?.operationId === operationId &&
                    grant?.grantId === prepared.grantId;
            if (!stillOwned || !grantMatches) {
                throw new HttpsError(
                    "aborted",
                    "The test-access operation lost ownership before completion.",
                    { reasonCode: "TEST_ACCESS_OPERATION_LOST" },
                );
            }
            if (params.action === "grant") {
                transaction.update(grantRef, {
                    status: "active",
                    activatedAt: FieldValue.serverTimestamp(),
                });
            }
            transaction.set(operationRef, {
                status: "completed",
                ...result,
                completedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            transaction.set(controlRef, {
                status: "idle",
                leaseId: null,
                leaseExpiresAtMs: 0,
                updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            transaction.set(
                db.collection(MONETIZATION_ADMIN_AUDIT_COLLECTION).doc(operationId),
                auditRecord({
                    actor: params.actor,
                    action: `${params.accessType}_${params.action === "grant" ? "granted" : "revoked"}`,
                    targetUid,
                    environment,
                    reasonCode,
                    ticketId,
                    metadata: {
                        operationId,
                        grantId: prepared.grantId,
                        expiresAtMs: params.action === "grant" ? prepared.expiresAtMs : null,
                    },
                }),
            );
        });
        logger.info("Monetization test access changed", {
            actorDigest: hashOpaque(["support-actor-v1", params.actor.uid]),
            subjectDigest: hashOpaque(["support-subject-v1", targetUid]),
            action: params.action,
            accessType: params.accessType,
            environment,
            operationDigest: hashOpaque(["test-access-log-v1", operationId]),
        });
        return result;
    } catch (error) {
        if (params.action === "grant") {
            const latestTarget = await auth.getUser(targetUid).catch(() => null);
            const latestClaim = latestTarget?.customClaims?.[config.claimKey];
            if (latestTarget && latestClaim && typeof latestClaim === "object" &&
                !Array.isArray(latestClaim) &&
                (latestClaim as Record<string, unknown>).grantId === prepared.grantId) {
                const claims = { ...(latestTarget.customClaims ?? {}) };
                delete claims[config.claimKey];
                await auth.setCustomUserClaims(targetUid, claims).catch(() => undefined);
            }
        }
        await markTestAccessOperationFailed({
            db,
            operationId,
            controlId,
            leaseId,
            grantRef,
            action: params.action,
            grantId: prepared.grantId,
            message: error instanceof Error ? error.message : "Test-access claim sync failed.",
        });
        throw error;
    }
}

/**
 * Performs a remotely requested Firestore/Auth test-access update. Firebase
 * custom-claim writes replace the whole claim map and offer no compare-and-set
 * precondition, so the remote path rejects self-targeting rather than risk
 * restoring its caller's concurrently removed admin claim.
 */
export async function setMonetizationTestAccessForAdmin(
    params: MonetizationTestAccessMutationParams,
): Promise<MonetizationTestAccessResult> {
    return setMonetizationTestAccessWithAuthority(params, false);
}

/**
 * Local-operator-only entry point used by the audited Admin SDK command. Its
 * caller already holds project credentials capable of managing Auth claims;
 * never expose this function through an HTTPS or other user-controlled route.
 */
export async function setMonetizationTestAccessForTrustedLocalOperator(
    params: MonetizationTestAccessMutationParams,
): Promise<MonetizationTestAccessResult> {
    return setMonetizationTestAccessWithAuthority(params, true);
}

export const setMonetizationTestAccess = onCall(
    { cors: true, maxInstances: 5 },
    async (request) => {
        const actor = await requireSupportActor(request, "monetization.test_access");
        const input = requireRecord(request.data);
        const action = input.action;
        const accessType = input.accessType;
        if (action !== "grant" && action !== "revoke") {
            throw new HttpsError("invalid-argument", "action must be grant or revoke.");
        }
        if (accessType !== "internal_test" && accessType !== "sandbox_commerce") {
            throw new HttpsError("invalid-argument", "accessType is invalid.");
        }
        return setMonetizationTestAccessForAdmin({
            actor,
            targetUid: requireTargetUid(input.targetUid),
            environment: requireEnvironment(input.environment),
            reasonCode: requireReason(input.reasonCode),
            ticketId: requireTicket(input.ticketId),
            action,
            accessType,
            ...(input.durationHours === undefined ? {} : { durationHours: input.durationHours as number }),
        });
    },
);
