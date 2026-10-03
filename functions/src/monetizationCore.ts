import { createHash } from "node:crypto";
import {
    METERED_FEATURES,
    MONETIZATION_CATALOG_VERSION,
    MONETIZATION_SCHEMA_VERSION,
    type ExecutionRoute,
    type MeteredFeatureDefinition,
    type MeteredFeatureId,
    type MonetizationEnvironment,
    type PlanId,
    type QuotaCadence,
    type QuotaRule,
    isExecutionRoute,
    isMeteredFeatureId,
    isMonetizationEnvironment,
    isPlanId,
} from "./monetizationCatalog";

export const INTERNAL_TEST_CLAIM = "manasplitInternalTest" as const;
export const MAX_SANDBOX_INTERNAL_TEST_GRANT_SECONDS = 31 * 24 * 60 * 60;
export const MAX_PRODUCTION_INTERNAL_TEST_GRANT_SECONDS = 7 * 24 * 60 * 60;
export const SHADOW_INGESTION_LIMIT_PER_UTC_DAY = 1_000;

const UUID_V4_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_V4_SOURCE}$`, "i");
const OPERATION_ID_PATTERN = new RegExp(`^(?:siri-)?${UUID_V4_SOURCE}$`, "i");
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}$/;
const OUTCOMES = ["completed", "failed", "cancelled", "abandoned"] as const;
const CONNECTIVITY = ["online", "offline_reconciled"] as const;
const PLATFORMS = ["ios", "android"] as const;
const DISTRIBUTIONS = [
    "debug",
    "development",
    "ad_hoc",
    "testflight",
    "app_store",
    "play_internal",
    "play_production",
] as const;

export type UsageOutcome = (typeof OUTCOMES)[number];
export type UsageConnectivity = (typeof CONNECTIVITY)[number];
export type AppPlatform = (typeof PLATFORMS)[number];
export type AppDistribution = (typeof DISTRIBUTIONS)[number];

export class MonetizationInputError extends Error {
    readonly reasonCode: string;

    constructor(reasonCode: string, message: string) {
        super(message);
        this.name = "MonetizationInputError";
        this.reasonCode = reasonCode;
    }
}

export interface SanitizedAppContext {
    platform: AppPlatform;
    version?: string;
    build?: string;
    distribution?: AppDistribution;
}

export interface SanitizedUsageInput {
    operationId: string;
    featureId: MeteredFeatureId;
    outcome: UsageOutcome;
    variant?: string;
    executionRoute: ExecutionRoute;
    connectivity: UsageConnectivity;
    app?: SanitizedAppContext;
}

export interface InternalTestAccess {
    kind: "standard" | "internal_test";
    commercialQuotaBypass: boolean;
    providerSafetyBypass: false;
    grantId: string | null;
    grantExpiresAt: number | null;
}

export type InternalTestClaimStatus =
    | "active"
    | "not_present"
    | "malformed"
    | "subject_mismatch"
    | "environment_mismatch"
    | "expired"
    | "duration_exceeded"
    | "not_yet_valid"
    | "grant_not_found"
    | "grant_inactive"
    | "grant_mismatch";

export interface InternalTestClaimDetails {
    reasonCode: string;
    issuedAtEpochSeconds: number;
    expiresAtEpochSeconds: number;
}

export interface ResolvedInternalTestAccess {
    access: InternalTestAccess;
    status: InternalTestClaimStatus;
    claimDetails?: InternalTestClaimDetails;
}

export interface WindowBounds {
    startMs: number;
    endMs: number;
    key: string;
}

export type ShadowDecisionSource =
    | "preview"
    | "included_use"
    | "unlimited"
    | "measurement_only"
    | "internal_test"
    | "quota_exhausted"
    | "not_counted";

export interface ShadowDecision {
    wouldAllow: boolean;
    source: ShadowDecisionSource;
    reasonCode:
        | "preview_available"
        | "quota_available"
        | "quota_exhausted"
        | "unlimited_local"
        | "measurement_pending"
        | "internal_test_access"
        | "terminal_outcome_not_billable";
    limit: number | null;
    usedBefore: number;
    usedAfter: number;
    remaining: number | null;
    windowStart: number | null;
    resetsAt: number | null;
    countedTowardQuota: boolean;
    claimedPreview: boolean;
}

export interface EvaluateShadowDecisionInput {
    planId: PlanId;
    feature: MeteredFeatureDefinition;
    outcome: UsageOutcome;
    access: InternalTestAccess;
    usedBefore: number;
    previewAvailable: boolean;
    window: WindowBounds | null;
}

export interface ServerPlanState {
    planId: PlanId;
    source: "default_free" | "server_projection";
}

function includesString<T extends string>(values: readonly T[], value: unknown): value is T {
    return typeof value === "string" && (values as readonly string[]).includes(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new MonetizationInputError("INVALID_PAYLOAD", `${field} must be an object.`);
    }
    return value as Record<string, unknown>;
}

function optionalSafeVersion(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !SAFE_VERSION_PATTERN.test(value)) {
        throw new MonetizationInputError("INVALID_APP_CONTEXT", `${field} is invalid.`);
    }
    return value;
}

export function sanitizeUsageInput(value: unknown): SanitizedUsageInput {
    const input = requireRecord(value ?? {}, "request");
    const operationId = input.operationId;
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
        throw new MonetizationInputError(
            "INVALID_OPERATION_ID",
            "operationId must be a client-generated UUID v4, optionally Siri-namespaced, and reused for retries.",
        );
    }

    if (!isMeteredFeatureId(input.featureId)) {
        throw new MonetizationInputError("UNKNOWN_FEATURE", "featureId is not in the active catalog.");
    }
    const feature = METERED_FEATURES[input.featureId];

    if (!includesString(OUTCOMES, input.outcome)) {
        throw new MonetizationInputError("INVALID_OUTCOME", "outcome is invalid.");
    }
    if (!isExecutionRoute(input.executionRoute) ||
        !feature.allowedExecutionRoutes.includes(input.executionRoute)) {
        throw new MonetizationInputError(
            "INVALID_EXECUTION_ROUTE",
            "executionRoute is not valid for this feature.",
        );
    }
    if (!includesString(CONNECTIVITY, input.connectivity)) {
        throw new MonetizationInputError("INVALID_CONNECTIVITY", "connectivity is invalid.");
    }
    if (input.connectivity === "offline_reconciled" && input.executionRoute === "provider") {
        throw new MonetizationInputError(
            "OFFLINE_PROVIDER_MISMATCH",
            "A provider-backed result cannot be recorded as offline-reconciled.",
        );
    }

    let variant: string | undefined;
    if (feature.variants) {
        if (typeof input.variant !== "string" || !feature.variants.includes(input.variant)) {
            throw new MonetizationInputError("INVALID_VARIANT", "A supported feature variant is required.");
        }
        variant = input.variant;
    } else if (input.variant !== undefined) {
        throw new MonetizationInputError("UNEXPECTED_VARIANT", "This feature does not accept a variant.");
    }

    let app: SanitizedAppContext | undefined;
    if (input.app !== undefined) {
        const rawApp = requireRecord(input.app, "app");
        if (!includesString(PLATFORMS, rawApp.platform)) {
            throw new MonetizationInputError("INVALID_APP_CONTEXT", "app.platform is invalid.");
        }
        if (rawApp.distribution !== undefined && !includesString(DISTRIBUTIONS, rawApp.distribution)) {
            throw new MonetizationInputError("INVALID_APP_CONTEXT", "app.distribution is invalid.");
        }
        const version = optionalSafeVersion(rawApp.version, "app.version");
        const build = optionalSafeVersion(rawApp.build, "app.build");
        app = {
            platform: rawApp.platform,
            ...(version ? { version } : {}),
            ...(build ? { build } : {}),
            ...(rawApp.distribution ? { distribution: rawApp.distribution } : {}),
        };
    }

    return {
        operationId,
        featureId: input.featureId,
        outcome: input.outcome,
        variant,
        executionRoute: input.executionRoute,
        connectivity: input.connectivity,
        app,
    };
}

export function resolveMonetizationEnvironment(env: NodeJS.ProcessEnv): MonetizationEnvironment {
    const configured = env.MANASPLIT_MONETIZATION_ENVIRONMENT?.trim().toLowerCase();
    if (configured !== undefined && configured !== "") {
        if (!isMonetizationEnvironment(configured)) {
            throw new Error("MANASPLIT_MONETIZATION_ENVIRONMENT must be sandbox or production.");
        }
        return configured;
    }
    return env.FUNCTIONS_EMULATOR === "true" ? "sandbox" : "production";
}

const standardAccess = (): InternalTestAccess => ({
    kind: "standard",
    commercialQuotaBypass: false,
    providerSafetyBypass: false,
    grantId: null,
    grantExpiresAt: null,
});

/**
 * Resolves the only internal-test role accepted by the monetization layer.
 *
 * The claim is attached by Firebase Auth to one exact UID. It is deliberately
 * environment-bound, short-lived, narrowly scoped to commercial quotas, and
 * unable to bypass provider or abuse budgets. Email addresses and client flags
 * are never consulted. Production grants have a stricter seven-day maximum.
 */
export function resolveInternalTestAccess(params: {
    uid: string;
    token: Record<string, unknown>;
    environment: MonetizationEnvironment;
    nowMs: number;
}): ResolvedInternalTestAccess {
    const raw = params.token[INTERNAL_TEST_CLAIM];
    if (raw === undefined) return { access: standardAccess(), status: "not_present" };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { access: standardAccess(), status: "malformed" };
    }

    const claim = raw as Record<string, unknown>;
    const issuedAt = claim.issuedAtEpochSeconds;
    const expiresAt = claim.expiresAtEpochSeconds;
    const structurallyValid = claim.version === 1 &&
        claim.role === "internal_tester" &&
        claim.scope === "commercial_limits_only" &&
        isMonetizationEnvironment(claim.environment) &&
        claim.providerSafetyBypass === false &&
        typeof claim.subjectUid === "string" &&
        typeof claim.grantId === "string" && UUID_PATTERN.test(claim.grantId) &&
        typeof claim.reasonCode === "string" && /^[A-Z0-9_]{3,40}$/.test(claim.reasonCode) &&
        typeof issuedAt === "number" && Number.isSafeInteger(issuedAt) &&
        typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) &&
        expiresAt > issuedAt;
    if (!structurallyValid) return { access: standardAccess(), status: "malformed" };
    const issuedAtSeconds = issuedAt as number;
    const expiresAtSeconds = expiresAt as number;
    if (claim.subjectUid !== params.uid) {
        return { access: standardAccess(), status: "subject_mismatch" };
    }
    if (claim.environment !== params.environment) {
        return { access: standardAccess(), status: "environment_mismatch" };
    }
    const maximumDuration = claim.environment === "production"
        ? MAX_PRODUCTION_INTERNAL_TEST_GRANT_SECONDS
        : MAX_SANDBOX_INTERNAL_TEST_GRANT_SECONDS;
    if (expiresAtSeconds - issuedAtSeconds > maximumDuration) {
        return { access: standardAccess(), status: "duration_exceeded" };
    }

    const nowSeconds = Math.floor(params.nowMs / 1_000);
    // Five minutes accommodates issuer/server skew without allowing a future
    // dated grant to sit dormant and later become valid unexpectedly.
    if (issuedAtSeconds > nowSeconds + 5 * 60) {
        return { access: standardAccess(), status: "not_yet_valid" };
    }
    if (expiresAtSeconds <= nowSeconds) {
        return { access: standardAccess(), status: "expired" };
    }

    return {
        status: "active",
        claimDetails: {
            reasonCode: claim.reasonCode as string,
            issuedAtEpochSeconds: issuedAtSeconds,
            expiresAtEpochSeconds: expiresAtSeconds,
        },
        access: {
            kind: "internal_test",
            commercialQuotaBypass: true,
            providerSafetyBypass: false,
            grantId: claim.grantId as string,
            grantExpiresAt: expiresAtSeconds * 1_000,
        },
    };
}

function timestampToMillis(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value && typeof value === "object" && "toMillis" in value) {
        const toMillis = (value as { toMillis?: unknown }).toMillis;
        if (typeof toMillis === "function") {
            const result = toMillis.call(value);
            return typeof result === "number" && Number.isFinite(result) ? result : null;
        }
    }
    return null;
}

/**
 * Cross-checks the signed claim against the server-only grant document.
 * Disabling that document takes effect on the next callable even if an old ID
 * token still contains the claim.
 */
export function verifyInternalTestGrantDocument(params: {
    resolvedClaim: ResolvedInternalTestAccess;
    grantData: unknown;
    uid: string;
    environment: MonetizationEnvironment;
    nowMs: number;
}): ResolvedInternalTestAccess {
    if (params.resolvedClaim.status !== "active" || !params.resolvedClaim.claimDetails) {
        return params.resolvedClaim;
    }
    if (!params.grantData || typeof params.grantData !== "object" || Array.isArray(params.grantData)) {
        return { access: standardAccess(), status: "grant_not_found" };
    }

    const data = params.grantData as Record<string, unknown>;
    if (data.status !== "active") {
        return { access: standardAccess(), status: "grant_inactive" };
    }
    const issuedAtMs = timestampToMillis(data.issuedAt);
    const expiresAtMs = timestampToMillis(data.expiresAt);
    const details = params.resolvedClaim.claimDetails;
    const matches = data.schemaVersion === 1 &&
        data.role === "internal_tester" &&
        data.scope === "commercial_limits_only" &&
        data.environment === params.environment &&
        data.providerSafetyBypass === false &&
        data.subjectUid === params.uid &&
        data.grantId === params.resolvedClaim.access.grantId &&
        data.reasonCode === details.reasonCode &&
        issuedAtMs === details.issuedAtEpochSeconds * 1_000 &&
        expiresAtMs === details.expiresAtEpochSeconds * 1_000;
    if (!matches) return { access: standardAccess(), status: "grant_mismatch" };
    if (expiresAtMs === null || expiresAtMs <= params.nowMs) {
        return { access: standardAccess(), status: "expired" };
    }
    return params.resolvedClaim;
}

export function getWindowBounds(cadence: QuotaCadence, nowMs: number): WindowBounds {
    const now = new Date(nowMs);
    let startMs: number;
    let endMs: number;

    if (cadence === "day") {
        startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        endMs = startMs + 24 * 60 * 60 * 1_000;
    } else if (cadence === "week") {
        const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        const mondayBasedDay = (now.getUTCDay() + 6) % 7;
        startMs = midnight - mondayBasedDay * 24 * 60 * 60 * 1_000;
        endMs = startMs + 7 * 24 * 60 * 60 * 1_000;
    } else {
        startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
        endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    }

    return {
        startMs,
        endMs,
        key: `${cadence}_${new Date(startMs).toISOString().slice(0, 10)}`,
    };
}

export function getRuleWindow(rule: QuotaRule, nowMs: number): WindowBounds | null {
    return rule.kind === "unlimited_local" ? null : getWindowBounds(rule.cadence, nowMs);
}

const remainingFor = (rule: QuotaRule, used: number): number | null =>
    rule.kind === "metered" ? Math.max(0, rule.limit - used) : null;

export function evaluateShadowDecision(input: EvaluateShadowDecisionInput): ShadowDecision {
    const rule = input.feature.quotaByPlan[input.planId];
    const limit = rule.kind === "metered" ? rule.limit : null;
    const windowStart = input.window?.startMs ?? null;
    const resetsAt = input.window?.endMs ?? null;

    if (input.outcome !== "completed") {
        return {
            wouldAllow: true,
            source: "not_counted",
            reasonCode: "terminal_outcome_not_billable",
            limit,
            usedBefore: input.usedBefore,
            usedAfter: input.usedBefore,
            remaining: remainingFor(rule, input.usedBefore),
            windowStart,
            resetsAt,
            countedTowardQuota: false,
            claimedPreview: false,
        };
    }

    if (input.access.commercialQuotaBypass) {
        return {
            wouldAllow: true,
            source: "internal_test",
            reasonCode: "internal_test_access",
            limit,
            usedBefore: input.usedBefore,
            usedAfter: input.usedBefore,
            remaining: remainingFor(rule, input.usedBefore),
            windowStart,
            resetsAt,
            countedTowardQuota: false,
            claimedPreview: false,
        };
    }

    if (input.planId === "free" && input.previewAvailable) {
        return {
            wouldAllow: true,
            source: "preview",
            reasonCode: "preview_available",
            limit,
            usedBefore: input.usedBefore,
            usedAfter: input.usedBefore,
            remaining: remainingFor(rule, input.usedBefore),
            windowStart,
            resetsAt,
            countedTowardQuota: false,
            claimedPreview: true,
        };
    }

    if (rule.kind === "unlimited_local") {
        return {
            wouldAllow: true,
            source: "unlimited",
            reasonCode: "unlimited_local",
            limit: null,
            usedBefore: input.usedBefore,
            usedAfter: input.usedBefore,
            remaining: null,
            windowStart: null,
            resetsAt: null,
            countedTowardQuota: false,
            claimedPreview: false,
        };
    }

    if (rule.kind === "measure_only") {
        return {
            wouldAllow: true,
            source: "measurement_only",
            reasonCode: "measurement_pending",
            limit: null,
            usedBefore: input.usedBefore,
            usedAfter: input.usedBefore + 1,
            remaining: null,
            windowStart,
            resetsAt,
            countedTowardQuota: true,
            claimedPreview: false,
        };
    }

    const wouldAllow = input.usedBefore < rule.limit;
    const usedAfter = input.usedBefore + 1;
    return {
        wouldAllow,
        source: wouldAllow ? "included_use" : "quota_exhausted",
        reasonCode: wouldAllow ? "quota_available" : "quota_exhausted",
        limit: rule.limit,
        usedBefore: input.usedBefore,
        usedAfter,
        remaining: Math.max(0, rule.limit - usedAfter),
        windowStart,
        resetsAt,
        countedTowardQuota: true,
        claimedPreview: false,
    };
}

export function getPreviewKey(input: SanitizedUsageInput): string | null {
    const feature = METERED_FEATURES[input.featureId];
    if (!feature.freePreview || !input.variant) return null;
    return `${input.featureId}:${input.variant}`;
}

export function hashOpaque(parts: readonly string[]): string {
    return createHash("sha256").update(parts.join("\u001f"), "utf8").digest("hex");
}

export function usageEventId(
    environment: MonetizationEnvironment,
    uid: string,
    operationId: string,
): string {
    return hashOpaque(["usage-event-v1", environment, uid, operationId]);
}

export function monetizationAccountDocumentId(
    environment: MonetizationEnvironment,
    uid: string,
): string {
    return `${environment}_${hashOpaque(["monetization-account-v1", uid]).slice(0, 48)}`;
}

export function usagePayloadDigest(input: SanitizedUsageInput): string {
    return hashOpaque([
        "usage-payload-v1",
        input.featureId,
        input.outcome,
        input.variant ?? "",
        input.executionRoute,
        input.connectivity,
    ]);
}

/**
 * Only this explicit projection may be persisted. In particular, arbitrary
 * request keys such as group ids, expense ids, amounts, receipt text, names,
 * messages, URLs, and monitored identities are discarded before storage.
 */
export function projectPrivacySafeUsage(input: SanitizedUsageInput): Record<string, unknown> {
    return {
        schemaVersion: MONETIZATION_SCHEMA_VERSION,
        catalogVersion: MONETIZATION_CATALOG_VERSION,
        featureId: input.featureId,
        outcome: input.outcome,
        ...(input.variant ? { variant: input.variant } : {}),
        executionRoute: input.executionRoute,
        connectivity: input.connectivity,
        ...(input.app ? { app: input.app } : {}),
    };
}

/** Paid plans are accepted only from the future server-owned projection. */
export function resolveServerPlanState(params: {
    data: unknown;
    uid: string;
    environment: MonetizationEnvironment;
    nowMs: number;
}): ServerPlanState {
    const fallback: ServerPlanState = { planId: "free", source: "default_free" };
    if (!params.data || typeof params.data !== "object" || Array.isArray(params.data)) return fallback;
    const data = params.data as Record<string, unknown>;
    if (data.schemaVersion !== 1 || data.uid !== params.uid || data.environment !== params.environment ||
        data.status !== "active" || !isPlanId(data.planId)) {
        return fallback;
    }
    if (data.planId === "free") return fallback;
    const validUntilMs = timestampToMillis(data.validUntil);
    if (validUntilMs === null || validUntilMs <= params.nowMs) return fallback;
    return { planId: data.planId, source: "server_projection" };
}
