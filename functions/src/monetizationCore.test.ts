import { describe, expect, it } from "vitest";
import {
    METERED_FEATURES,
    MONETIZATION_CATALOG,
    type MonetizationEnvironment,
} from "./monetizationCatalog";
import {
    MAX_PRODUCTION_INTERNAL_TEST_GRANT_SECONDS,
    MAX_SANDBOX_INTERNAL_TEST_GRANT_SECONDS,
    MonetizationInputError,
    evaluateShadowDecision,
    getRuleWindow,
    getWindowBounds,
    monetizationAccountDocumentId,
    projectPrivacySafeUsage,
    resolveInternalTestAccess,
    resolveMonetizationEnvironment,
    resolveServerPlanState,
    sanitizeUsageInput,
    usageEventId,
    usagePayloadDigest,
    verifyInternalTestGrantDocument,
} from "./monetizationCore";

const NOW_MS = Date.parse("2026-09-06T18:30:00.000Z");
const VALID_OPERATION_ID = "4d5aa868-b56c-4f48-97a2-62cd84220311";
const VALID_GRANT_ID = "74d84a8c-1a66-4ed1-8f42-ad4fd0b66f86";

const standardAccess = {
    kind: "standard" as const,
    commercialQuotaBypass: false,
    providerSafetyBypass: false as const,
    grantId: null,
    grantExpiresAt: null,
};

function validUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        operationId: VALID_OPERATION_ID,
        featureId: "advanced_split.completion",
        outcome: "completed",
        variant: "income",
        executionRoute: "local_deterministic",
        connectivity: "online",
        app: {
            platform: "ios",
            version: "1.2.3",
            build: "42",
            distribution: "testflight",
        },
        ...overrides,
    };
}

function validInternalClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const issuedAt = Math.floor(NOW_MS / 1_000) - 60;
    return {
        version: 1,
        role: "internal_tester",
        scope: "commercial_limits_only",
        environment: "sandbox",
        providerSafetyBypass: false,
        subjectUid: "owner-uid",
        grantId: VALID_GRANT_ID,
        reasonCode: "OWNER_TESTING",
        issuedAtEpochSeconds: issuedAt,
        expiresAtEpochSeconds: issuedAt + 24 * 60 * 60,
        ...overrides,
    };
}

describe("server-owned monetization catalog", () => {
    it("publishes only server-owned storefront products for checkout", () => {
        expect(MONETIZATION_CATALOG.enforcementMode).toBe("enforced");
        expect(MONETIZATION_CATALOG.telemetry).toEqual({
            trust: "server_authoritative",
            appCheckEnforced: false,
            eligibleForBillingOrEnforcement: true,
        });
        expect(MONETIZATION_CATALOG.pricing).toMatchObject({
            status: "storefront",
            currency: "USD",
            checkoutDisplayAllowed: true,
            localizedStorefrontPriceRequired: true,
        });
        expect(MONETIZATION_CATALOG.exclusions.purchasedCreditChargingEnabled).toBe(true);
        expect(JSON.stringify(MONETIZATION_CATALOG)).toMatch(/productId/i);
    });

    it("limits early local tiers and marks only Max local work unlimited", () => {
        const advanced = METERED_FEATURES["advanced_split.completion"];
        expect(advanced.quotaByPlan.free).toEqual({ kind: "metered", limit: 3, cadence: "week" });
        expect(advanced.quotaByPlan.power).toEqual({ kind: "metered", limit: 1_000, cadence: "month" });
        expect(advanced.quotaByPlan.max).toEqual({ kind: "unlimited_local" });
        expect(METERED_FEATURES["provider.ai_or_ocr_job"].quotaByPlan.max).toEqual({
            kind: "metered",
            limit: 500,
            cadence: "month",
        });
    });

    it("excludes randomized and uncleared split modes from billable variants", () => {
        const advanced = METERED_FEATURES["advanced_split.completion"];
        expect(advanced.variants).toEqual(["itemized", "income", "consumption", "timeBased", "itemType"]);
        expect(advanced.variants).not.toContain("roulette");
        expect(advanced.variants).not.toContain("weightedRoulette");
        expect(advanced.variants).not.toContain("scrooge");
    });
});

describe("privacy-safe usage validation", () => {
    it("accepts a catalog operation and persists only the explicit projection", () => {
        const sanitized = sanitizeUsageInput(validUsage({
            groupId: "private-group",
            expenseId: "private-expense",
            amount: 812.43,
            participantNames: ["Alice", "Bob"],
            receiptText: "private receipt contents",
            message: "private message",
        }));
        const projected = projectPrivacySafeUsage(sanitized);
        const serialized = JSON.stringify(projected);

        expect(projected).toMatchObject({
            featureId: "advanced_split.completion",
            outcome: "completed",
            variant: "income",
            executionRoute: "local_deterministic",
            connectivity: "online",
        });
        expect(serialized).not.toMatch(/private|812|participant|receipt|message|operationId/);
    });

    it("requires a UUID v4 operation key and an eligible advanced variant", () => {
        expect(() => sanitizeUsageInput(validUsage({ operationId: "expense-123" })))
            .toThrowError(MonetizationInputError);
        expect(() => sanitizeUsageInput(validUsage({ variant: "roulette" })))
            .toThrowError(/supported feature variant/i);
        expect(() => sanitizeUsageInput(validUsage({ variant: undefined })))
            .toThrowError(/supported feature variant/i);
    });

    it("accepts the UUID-v4 identifier emitted by the Siri expense queue", () => {
        const input = sanitizeUsageInput(validUsage({
            operationId: `siri-${VALID_OPERATION_ID.toUpperCase()}`,
        }));
        expect(input.operationId).toBe(`siri-${VALID_OPERATION_ID.toUpperCase()}`);
    });

    it("rejects route confusion and impossible offline provider use", () => {
        expect(() => sanitizeUsageInput(validUsage({ executionRoute: "provider" })))
            .toThrowError(/executionRoute/i);
        expect(() => sanitizeUsageInput(validUsage({
            featureId: "provider.ai_or_ocr_job",
            variant: undefined,
            executionRoute: "provider",
            connectivity: "offline_reconciled",
        }))).toThrowError(/provider-backed result/i);
    });

    it("does not let one idempotency key describe two different operations", () => {
        const original = sanitizeUsageInput(validUsage());
        const retry = sanitizeUsageInput(validUsage());
        const changed = sanitizeUsageInput(validUsage({ outcome: "failed" }));
        expect(usagePayloadDigest(retry)).toBe(usagePayloadDigest(original));
        expect(usagePayloadDigest(changed)).not.toBe(usagePayloadDigest(original));
    });

    it("separates sandbox and production event ids without storing the raw UUID", () => {
        const sandbox = usageEventId("sandbox", "owner-uid", VALID_OPERATION_ID);
        const production = usageEventId("production", "owner-uid", VALID_OPERATION_ID);
        expect(sandbox).toHaveLength(64);
        expect(sandbox).not.toBe(production);
        expect(sandbox).not.toContain(VALID_OPERATION_ID);
        expect(sandbox).not.toContain("owner-uid");
        expect(monetizationAccountDocumentId("sandbox", "owner-uid"))
            .toMatch(/^sandbox_[0-9a-f]{48}$/);
        expect(monetizationAccountDocumentId("production", "owner-uid"))
            .toMatch(/^production_[0-9a-f]{48}$/);
    });
});

describe("internal-test access", () => {
    function resolve(
        environment: MonetizationEnvironment,
        claim: unknown,
        uid = "owner-uid",
    ) {
        return resolveInternalTestAccess({
            uid,
            environment,
            nowMs: NOW_MS,
            token: { manasplitInternalTest: claim },
        });
    }

    it("accepts only the exact, expiring, UID-bound sandbox claim", () => {
        const result = resolve("sandbox", validInternalClaim());
        expect(result.status).toBe("active");
        expect(result.access).toMatchObject({
            kind: "internal_test",
            commercialQuotaBypass: true,
            providerSafetyBypass: false,
            grantId: VALID_GRANT_ID,
        });
        expect(typeof result.access.grantExpiresAt).toBe("number");
    });

    it("rejects a sandbox grant on a production deployment", () => {
        const result = resolve("production", validInternalClaim());
        expect(result.status).toBe("environment_mismatch");
        expect(result.access.commercialQuotaBypass).toBe(false);
    });

    it("accepts an exact production grant for at most seven days", () => {
        const issuedAt = Math.floor(NOW_MS / 1_000) - 60;
        const claim = validInternalClaim({
            environment: "production",
            issuedAtEpochSeconds: issuedAt,
            expiresAtEpochSeconds: issuedAt + 24 * 60 * 60,
        });
        expect(resolve("production", claim).status).toBe("active");
        expect(resolve("production", validInternalClaim({
            environment: "production",
            issuedAtEpochSeconds: issuedAt,
            expiresAtEpochSeconds: issuedAt + MAX_PRODUCTION_INTERNAL_TEST_GRANT_SECONDS + 1,
        })).status).toBe("duration_exceeded");
    });

    it("requires a matching active server grant for immediate revocation", () => {
        const claim = resolve("sandbox", validInternalClaim());
        const issuedAt = Math.floor(NOW_MS / 1_000) - 60;
        const matchingGrant = {
            schemaVersion: 1,
            status: "active",
            role: "internal_tester",
            scope: "commercial_limits_only",
            environment: "sandbox",
            providerSafetyBypass: false,
            subjectUid: "owner-uid",
            grantId: VALID_GRANT_ID,
            reasonCode: "OWNER_TESTING",
            issuedAt: issuedAt * 1_000,
            expiresAt: (issuedAt + 24 * 60 * 60) * 1_000,
        };
        expect(verifyInternalTestGrantDocument({
            resolvedClaim: claim,
            grantData: matchingGrant,
            uid: "owner-uid",
            environment: "sandbox",
            nowMs: NOW_MS,
        }).status).toBe("active");
        expect(verifyInternalTestGrantDocument({
            resolvedClaim: claim,
            grantData: { ...matchingGrant, status: "revoked" },
            uid: "owner-uid",
            environment: "sandbox",
            nowMs: NOW_MS,
        })).toMatchObject({
            status: "grant_inactive",
            access: { commercialQuotaBypass: false },
        });
        expect(verifyInternalTestGrantDocument({
            resolvedClaim: claim,
            grantData: { ...matchingGrant, grantId: "43d5e53b-9b49-44b8-976c-8317e1adca5a" },
            uid: "owner-uid",
            environment: "sandbox",
            nowMs: NOW_MS,
        }).status).toBe("grant_mismatch");
    });

    it("requires the production grant document to match the production claim", () => {
        const issuedAt = Math.floor(NOW_MS / 1_000) - 60;
        const expiresAt = issuedAt + 24 * 60 * 60;
        const claim = resolve("production", validInternalClaim({
            environment: "production",
            issuedAtEpochSeconds: issuedAt,
            expiresAtEpochSeconds: expiresAt,
        }));
        const grant = {
            schemaVersion: 1,
            status: "active",
            role: "internal_tester",
            scope: "commercial_limits_only",
            environment: "production",
            providerSafetyBypass: false,
            subjectUid: "owner-uid",
            grantId: VALID_GRANT_ID,
            reasonCode: "OWNER_TESTING",
            issuedAt: issuedAt * 1_000,
            expiresAt: expiresAt * 1_000,
        };
        expect(verifyInternalTestGrantDocument({
            resolvedClaim: claim,
            grantData: grant,
            uid: "owner-uid",
            environment: "production",
            nowMs: NOW_MS,
        }).status).toBe("active");
        expect(verifyInternalTestGrantDocument({
            resolvedClaim: claim,
            grantData: { ...grant, environment: "sandbox" },
            uid: "owner-uid",
            environment: "production",
            nowMs: NOW_MS,
        }).status).toBe("grant_mismatch");
    });

    it("rejects UID mismatch, provider bypass, expiry, and overlong grants", () => {
        expect(resolve("sandbox", validInternalClaim(), "different-uid").status).toBe("subject_mismatch");
        expect(resolve("sandbox", validInternalClaim({ providerSafetyBypass: true })).status).toBe("malformed");
        expect(resolve("sandbox", validInternalClaim({ expiresAtEpochSeconds: Math.floor(NOW_MS / 1_000) })).status)
            .toBe("expired");
        const issuedAt = Math.floor(NOW_MS / 1_000) - 60;
        expect(resolve("sandbox", validInternalClaim({
            issuedAtEpochSeconds: issuedAt,
            expiresAtEpochSeconds: issuedAt + MAX_SANDBOX_INTERNAL_TEST_GRANT_SECONDS + 1,
        })).status).toBe("duration_exceeded");
    });

    it("ignores an email address or a client-like boolean without the signed role object", () => {
        const result = resolveInternalTestAccess({
            uid: "owner-uid",
            environment: "sandbox",
            nowMs: NOW_MS,
            token: { email: "owner@example.com", admin: true, internalTest: true },
        });
        expect(result).toMatchObject({
            status: "not_present",
            access: { kind: "standard", commercialQuotaBypass: false },
        });
    });
});

describe("shadow quota decisions", () => {
    const advanced = METERED_FEATURES["advanced_split.completion"];

    it("uses UTC day, Monday-week, and month boundaries deterministically", () => {
        expect(getWindowBounds("day", NOW_MS)).toMatchObject({
            startMs: Date.parse("2026-09-06T00:00:00.000Z"),
            endMs: Date.parse("2026-09-07T00:00:00.000Z"),
        });
        expect(getWindowBounds("week", NOW_MS)).toMatchObject({
            startMs: Date.parse("2026-08-31T00:00:00.000Z"),
            endMs: Date.parse("2026-09-07T00:00:00.000Z"),
        });
        expect(getWindowBounds("month", NOW_MS)).toMatchObject({
            startMs: Date.parse("2026-09-01T00:00:00.000Z"),
            endMs: Date.parse("2026-10-01T00:00:00.000Z"),
        });
    });

    it("uses a first-mode preview without consuming the pooled Free quota", () => {
        const rule = advanced.quotaByPlan.free;
        const decision = evaluateShadowDecision({
            planId: "free",
            feature: advanced,
            outcome: "completed",
            access: standardAccess,
            usedBefore: 2,
            previewAvailable: true,
            window: getRuleWindow(rule, NOW_MS),
        });
        expect(decision).toMatchObject({
            wouldAllow: true,
            source: "preview",
            usedBefore: 2,
            usedAfter: 2,
            remaining: 1,
            countedTowardQuota: false,
            claimedPreview: true,
        });
        expect(decision.windowStart).toBe(Date.parse("2026-08-31T00:00:00.000Z"));
        expect(decision.resetsAt).toBe(Date.parse("2026-09-07T00:00:00.000Z"));
    });

    it("records shadow overage while leaving enforcement off to the callable", () => {
        const rule = advanced.quotaByPlan.free;
        const decision = evaluateShadowDecision({
            planId: "free",
            feature: advanced,
            outcome: "completed",
            access: standardAccess,
            usedBefore: 3,
            previewAvailable: false,
            window: getRuleWindow(rule, NOW_MS),
        });
        expect(decision).toMatchObject({
            wouldAllow: false,
            source: "quota_exhausted",
            usedBefore: 3,
            usedAfter: 4,
            remaining: 0,
            countedTowardQuota: true,
        });
    });

    it("does not count failures and does not commercially limit internal testers", () => {
        const rule = advanced.quotaByPlan.free;
        const failed = evaluateShadowDecision({
            planId: "free",
            feature: advanced,
            outcome: "failed",
            access: standardAccess,
            usedBefore: 3,
            previewAvailable: false,
            window: getRuleWindow(rule, NOW_MS),
        });
        expect(failed).toMatchObject({ source: "not_counted", usedAfter: 3, countedTowardQuota: false });

        const internal = evaluateShadowDecision({
            planId: "free",
            feature: advanced,
            outcome: "completed",
            access: {
                kind: "internal_test",
                commercialQuotaBypass: true,
                providerSafetyBypass: false,
                grantId: VALID_GRANT_ID,
                grantExpiresAt: Date.parse("2026-09-07T00:00:00.000Z"),
            },
            usedBefore: 99,
            previewAvailable: false,
            window: getRuleWindow(rule, NOW_MS),
        });
        expect(internal).toMatchObject({
            wouldAllow: true,
            source: "internal_test",
            usedAfter: 99,
            countedTowardQuota: false,
        });
    });

    it("keeps a finite Max provider budget separate from unlimited local work", () => {
        const provider = METERED_FEATURES["provider.ai_or_ocr_job"];
        const rule = provider.quotaByPlan.max;
        const decision = evaluateShadowDecision({
            planId: "max",
            feature: provider,
            outcome: "completed",
            access: standardAccess,
            usedBefore: 40,
            previewAvailable: false,
            window: getRuleWindow(rule, NOW_MS),
        });
        expect(decision).toMatchObject({
            wouldAllow: true,
            source: "included_use",
            reasonCode: "quota_available",
            limit: 500,
            usedAfter: 41,
        });
    });
});

describe("server-owned plan projection", () => {
    it("accepts an active exact-environment server projection", () => {
        expect(resolveServerPlanState({
            data: {
                schemaVersion: 1,
                uid: "user-1",
                environment: "sandbox",
                status: "active",
                planId: "pro",
                validUntil: NOW_MS + 60_000,
            },
            uid: "user-1",
            environment: "sandbox",
            nowMs: NOW_MS,
        })).toEqual({ planId: "pro", source: "server_projection" });
    });

    it("fails closed to Free for stale, cross-environment, or malformed state", () => {
        const base = {
            schemaVersion: 1,
            uid: "user-1",
            environment: "sandbox",
            status: "active",
            planId: "pro",
            validUntil: NOW_MS + 60_000,
        };
        for (const data of [
            { ...base, validUntil: NOW_MS },
            { ...base, environment: "production" },
            { ...base, uid: "other-user" },
            { ...base, planId: "owner" },
        ]) {
            expect(resolveServerPlanState({
                data,
                uid: "user-1",
                environment: "sandbox",
                nowMs: NOW_MS,
            })).toEqual({ planId: "free", source: "default_free" });
        }
    });
});

describe("runtime environment", () => {
    it("is controlled by server configuration, never request data", () => {
        expect(resolveMonetizationEnvironment({ MANASPLIT_MONETIZATION_ENVIRONMENT: "sandbox" }))
            .toBe("sandbox");
        expect(resolveMonetizationEnvironment({ MANASPLIT_MONETIZATION_ENVIRONMENT: "production" }))
            .toBe("production");
        expect(resolveMonetizationEnvironment({ FUNCTIONS_EMULATOR: "true" })).toBe("sandbox");
        expect(resolveMonetizationEnvironment({})).toBe("production");
        expect(() => resolveMonetizationEnvironment({ MANASPLIT_MONETIZATION_ENVIRONMENT: "staging" }))
            .toThrow(/sandbox or production/i);
    });
});
