import { describe, expect, it } from "vitest";
import { sanitizeProviderStatus, securityNotificationCopy } from "./securityMonitoring";

describe("security provider health aggregation", () => {
    it("keeps totals and the worst health state across multiple identities", () => {
        const status = sanitizeProviderStatus([
            { provider: "hibp", status: "success", latencyMs: 10, findings: [] },
            {
                provider: "hibp",
                status: "partial",
                latencyMs: 25,
                findings: [{
                    source: "hibp",
                    sourceReference: "breach:one",
                    kind: "breach",
                    title: "One",
                    summary: "One",
                    observedAt: 1,
                    exposedDataClasses: [],
                    providerConfidence: 1,
                    evidence: [],
                }],
                safeMessage: "One endpoint was unavailable.",
            },
            { provider: "flare", status: "not_configured", latencyMs: 0, findings: [] },
        ]) as Record<string, { status: string; latencyMs: number; findingCount: number; message?: string }>;

        expect(status.hibp).toMatchObject({ status: "partial", latencyMs: 35, findingCount: 1 });
        expect(status.hibp.message).toMatch(/unavailable/);
        expect(status.flare).toMatchObject({ status: "not_configured", latencyMs: 0, findingCount: 0 });
    });
});

describe("security notification privacy", () => {
    it("never includes identity, provider, or exposure details in lock-screen copy", () => {
        for (const detailed of [false, true]) {
            const copy = JSON.stringify(securityNotificationCopy(detailed)).toLowerCase();
            expect(copy).not.toMatch(/@|password|cookie|token|breach|infostealer|flare|pwned/);
        }
        expect(securityNotificationCopy(false)).toEqual({
            title: "ManaSplit",
            body: "Open ManaSplit to review a protected security alert.",
        });
    });
});
