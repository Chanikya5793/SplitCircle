import type {
    NormalizedSecurityFinding,
    SecurityFindingSeverity,
    SecurityRiskAssessment,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

const severityForScore = (score: number): SecurityFindingSeverity => {
    if (score >= 80) return "critical";
    if (score >= 60) return "high";
    if (score >= 35) return "medium";
    if (score >= 15) return "low";
    return "info";
};

const addFactor = (
    factors: SecurityRiskAssessment["factors"],
    code: string,
    label: string,
    points: number,
): void => {
    if (factors.some((factor) => factor.code === code)) return;
    factors.push({ code, label, points });
};

/**
 * Authoritative, deterministic risk scoring. Models may explain this output,
 * but they never choose the score, severity, confidence, or next action.
 */
export function assessSecurityRisk(
    finding: NormalizedSecurityFinding,
    context: {
        now?: number;
        repeatedExposureCount?: number;
        mfaEnabled?: boolean;
        passkeyEnabled?: boolean;
    } = {},
): SecurityRiskAssessment {
    const now = context.now ?? Date.now();
    const factors: SecurityRiskAssessment["factors"] = [];
    const likelyRisks = new Set<SecurityRiskAssessment["likelyRisks"][number]>();
    const dataClasses = new Set(finding.exposedDataClasses.map((value) => value.toLowerCase()));

    if (finding.indicators?.infostealer || finding.kind === "infostealer") {
        addFactor(factors, "infostealer", "Infostealer evidence", 38);
        likelyRisks.add("account_takeover");
        likelyRisks.add("credential_stuffing");
    }
    if (finding.indicators?.sessionTokenExposure || [...dataClasses].some((value) => /cookie|session|token/.test(value))) {
        addFactor(factors, "session_token", "Session or authentication token exposure", 36);
        likelyRisks.add("account_takeover");
    }
    if (finding.indicators?.passwordExposure || dataClasses.has("passwords") || dataClasses.has("password")) {
        addFactor(factors, "password", "Password data exposed", 26);
        likelyRisks.add("credential_stuffing");
        likelyRisks.add("account_takeover");
    }
    if (finding.kind === "phishing" || finding.indicators?.maliciousUrl) {
        addFactor(factors, "malicious_url", "Known malicious or deceptive link", 34);
        likelyRisks.add("targeted_phishing");
        likelyRisks.add("scam");
    }
    if (finding.kind === "impersonation" || finding.indicators?.impersonation) {
        addFactor(factors, "impersonation", "Lookalike or impersonation signal", 25);
        likelyRisks.add("impersonation");
        likelyRisks.add("targeted_phishing");
    }

    const ageMs = Math.max(0, now - (finding.occurredAt ?? finding.observedAt));
    if (ageMs <= 7 * DAY_MS) {
        addFactor(factors, "fresh", "Observed within the last 7 days", 16);
    } else if (ageMs <= 30 * DAY_MS) {
        addFactor(factors, "recent", "Observed within the last 30 days", 10);
    } else if (ageMs <= 365 * DAY_MS) {
        addFactor(factors, "current_year", "Observed within the last year", 4);
    }

    const repeatedExposureCount = Math.max(0, context.repeatedExposureCount ?? 0);
    if (repeatedExposureCount >= 3) {
        addFactor(factors, "repeated", "Repeated exposure across sources", 12);
        likelyRisks.add("credential_stuffing");
    } else if (repeatedExposureCount >= 1) {
        addFactor(factors, "corroborated", "Corroborated by another finding", 6);
    }

    if (context.mfaEnabled) addFactor(factors, "mfa", "Multi-factor authentication is enabled", -8);
    if (context.passkeyEnabled) addFactor(factors, "passkey", "A passkey reduces reusable-credential risk", -8);

    const score = Math.max(0, Math.min(100, factors.reduce((total, factor) => total + factor.points, 0)));
    const confidence = Math.max(
        0,
        Math.min(1, finding.providerConfidence * (repeatedExposureCount > 0 ? 1 : 0.94)),
    );

    const recommendedActions: string[] = [];
    if (finding.indicators?.sessionTokenExposure || [...dataClasses].some((value) => /cookie|session|token/.test(value))) {
        recommendedActions.push("Sign out every active session from the service's official security page.");
    }
    if (finding.indicators?.passwordExposure || dataClasses.has("passwords") || dataClasses.has("password")) {
        recommendedActions.push("Change the affected account's password and every account that reused it.");
    }
    if (finding.indicators?.infostealer || finding.kind === "infostealer") {
        recommendedActions.push("Run a trusted malware scan on devices that accessed the affected account.");
    }
    if (finding.kind === "phishing" || finding.kind === "impersonation") {
        recommendedActions.push("Do not open the link; reach the service from its official app or a saved bookmark.");
    }
    if (!context.mfaEnabled && !context.passkeyEnabled) {
        recommendedActions.push("Enable a passkey or multi-factor authentication on the official account page.");
    }
    if (recommendedActions.length === 0) {
        recommendedActions.push("Review the evidence and confirm the account's recovery details are current.");
    }

    return {
        score,
        severity: severityForScore(score),
        confidence,
        factors,
        likelyRisks: [...likelyRisks],
        recommendedActions,
    };
}

