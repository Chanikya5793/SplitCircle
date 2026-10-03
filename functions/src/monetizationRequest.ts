import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { type MonetizationEnvironment } from "./monetizationCatalog";
import {
    MonetizationInputError,
    monetizationAccountDocumentId,
    resolveInternalTestAccess,
    resolveMonetizationEnvironment,
    verifyInternalTestGrantDocument,
    type InternalTestAccess,
} from "./monetizationCore";

const SANDBOX_COMMERCE_CLAIM = "manasplitSandboxCommerce";
const SANDBOX_COMMERCE_GRANT_COLLECTION = "monetizationSandboxCommerceGrants";
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SANDBOX_GRANT_SECONDS = 31 * 24 * 60 * 60;

export interface AuthenticatedMonetizationRequest {
    uid: string;
    token: Record<string, unknown>;
}

export interface RequestMonetizationContext extends AuthenticatedMonetizationRequest {
    environment: MonetizationEnvironment;
    access: InternalTestAccess;
    sandboxCommerce: boolean;
}

const standardAccess = (): InternalTestAccess => ({
    kind: "standard",
    commercialQuotaBypass: false,
    providerSafetyBypass: false,
    grantId: null,
    grantExpiresAt: null,
});

export function requireAuthenticatedMonetizationRequest(request: {
    auth?: { uid: string; token: unknown };
}): AuthenticatedMonetizationRequest {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
    const rawToken = request.auth?.token;
    return {
        uid,
        token: rawToken && typeof rawToken === "object" && !Array.isArray(rawToken)
            ? rawToken as Record<string, unknown>
            : {},
    };
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

async function hasActiveSandboxCommerceGrant(params: {
    uid: string;
    token: Record<string, unknown>;
    nowMs: number;
}): Promise<boolean> {
    const raw = params.token[SANDBOX_COMMERCE_CLAIM];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const claim = raw as Record<string, unknown>;
    const issuedAt = claim.issuedAtEpochSeconds;
    const expiresAt = claim.expiresAtEpochSeconds;
    if (claim.version !== 1 || claim.role !== "sandbox_commerce_tester" ||
        claim.environment !== "sandbox" || claim.subjectUid !== params.uid ||
        typeof claim.grantId !== "string" || !UUID_PATTERN.test(claim.grantId) ||
        typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) ||
        typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) ||
        expiresAt <= issuedAt || expiresAt - issuedAt > MAX_SANDBOX_GRANT_SECONDS) {
        return false;
    }
    const nowSeconds = Math.floor(params.nowMs / 1_000);
    if (issuedAt > nowSeconds + 5 * 60 || expiresAt <= nowSeconds) return false;

    const accountId = monetizationAccountDocumentId("sandbox", params.uid);
    const snapshot = await getFirestore().collection(SANDBOX_COMMERCE_GRANT_COLLECTION)
        .doc(accountId).get();
    const data = snapshot.data();
    return snapshot.exists && data?.schemaVersion === 1 && data?.status === "active" &&
        data?.role === "sandbox_commerce_tester" && data?.environment === "sandbox" &&
        data?.subjectUid === params.uid && data?.grantId === claim.grantId &&
        timestampToMillis(data?.issuedAt) === issuedAt * 1_000 &&
        timestampToMillis(data?.expiresAt) === expiresAt * 1_000 &&
        (timestampToMillis(data?.expiresAt) ?? 0) > params.nowMs;
}

async function verifiedInternalAccess(params: {
    uid: string;
    token: Record<string, unknown>;
    environment: MonetizationEnvironment;
    nowMs: number;
}): Promise<InternalTestAccess> {
    const resolved = resolveInternalTestAccess(params);
    if (resolved.status !== "active") return standardAccess();
    const accountId = monetizationAccountDocumentId(params.environment, params.uid);
    const snapshot = await getFirestore().collection("monetizationInternalTestGrants")
        .doc(accountId).get();
    return verifyInternalTestGrantDocument({
        resolvedClaim: resolved,
        grantData: snapshot.data(),
        uid: params.uid,
        environment: params.environment,
        nowMs: params.nowMs,
    }).access;
}

/**
 * Production functions accept sandbox StoreKit data only for an exact,
 * expiring, server-backed claim. Internal testers may use the existing
 * sandbox claim and receive quota bypass; App Review accounts use the
 * sandbox-commerce claim without any quota bypass.
 */
export async function resolveRequestMonetizationContext(
    request: { auth?: { uid: string; token: unknown } },
    nowMs = Date.now(),
): Promise<RequestMonetizationContext> {
    const authenticated = requireAuthenticatedMonetizationRequest(request);
    const configured = resolveMonetizationEnvironment(process.env);
    if (configured === "sandbox") {
        const access = await verifiedInternalAccess({
            ...authenticated,
            environment: "sandbox",
            nowMs,
        });
        return { ...authenticated, environment: "sandbox", access, sandboxCommerce: true };
    }

    const sandboxInternal = await verifiedInternalAccess({
        ...authenticated,
        environment: "sandbox",
        nowMs,
    });
    if (sandboxInternal.kind === "internal_test") {
        return {
            ...authenticated,
            environment: "sandbox",
            access: sandboxInternal,
            sandboxCommerce: true,
        };
    }
    if (await hasActiveSandboxCommerceGrant({ ...authenticated, nowMs })) {
        return {
            ...authenticated,
            environment: "sandbox",
            access: standardAccess(),
            sandboxCommerce: true,
        };
    }

    const access = await verifiedInternalAccess({
        ...authenticated,
        environment: "production",
        nowMs,
    });
    return {
        ...authenticated,
        environment: "production",
        access,
        sandboxCommerce: false,
    };
}

export function mapMonetizationInputError(error: unknown): never {
    if (error instanceof MonetizationInputError) {
        throw new HttpsError("invalid-argument", error.message, {
            reasonCode: error.reasonCode,
        });
    }
    throw error;
}
