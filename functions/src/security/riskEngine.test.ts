import { describe, expect, it } from "vitest";
import { assessSecurityRisk } from "./riskEngine";
import type { NormalizedSecurityFinding } from "./types";

const base: NormalizedSecurityFinding = {
    source: "hibp",
    sourceReference: "breach:example",
    kind: "breach",
    title: "Example",
    summary: "Normalized finding",
    observedAt: 1_700_000_000_000,
    occurredAt: 1_700_000_000_000,
    exposedDataClasses: ["Email addresses"],
    providerConfidence: 0.9,
    evidence: [],
};

describe("deterministic security risk engine", () => {
    it("makes recent infostealer plus session-token exposure critical", () => {
        const result = assessSecurityRisk({
            ...base,
            kind: "infostealer",
            exposedDataClasses: ["Passwords", "Session cookies"],
            indicators: { infostealer: true, passwordExposure: true, sessionTokenExposure: true },
        }, { now: base.observedAt + 1000, repeatedExposureCount: 2 });

        expect(result.score).toBe(100);
        expect(result.severity).toBe("critical");
        expect(result.likelyRisks).toEqual(expect.arrayContaining(["account_takeover", "credential_stuffing"]));
        expect(result.recommendedActions.join(" ")).toMatch(/Sign out every active session/);
    });

    it("credits passkeys and MFA without allowing a negative score", () => {
        const result = assessSecurityRisk(base, {
            now: base.observedAt + 2 * 365 * 24 * 60 * 60 * 1000,
            mfaEnabled: true,
            passkeyEnabled: true,
        });
        expect(result.score).toBe(0);
        expect(result.severity).toBe("info");
        expect(result.factors.filter((factor) => factor.points < 0)).toHaveLength(2);
    });

    it("is stable for identical evidence and context", () => {
        const context = { now: base.observedAt + 5_000, repeatedExposureCount: 1 };
        expect(assessSecurityRisk(base, context)).toEqual(assessSecurityRisk(base, context));
    });
});

