export type SecurityIdentityType = "email" | "username" | "phone" | "domain";

export type SecurityFindingKind =
    | "breach"
    | "paste"
    | "infostealer"
    | "credential_exposure"
    | "phishing"
    | "impersonation";

export type SecurityFindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export type SecurityFindingState = "active" | "acknowledged" | "remediated" | "resolved" | "muted";

export type SecurityProviderId = "hibp" | "flare" | "google_web_risk" | "manasplit";

export interface NormalizedSecurityFinding {
    source: SecurityProviderId;
    sourceReference: string;
    kind: SecurityFindingKind;
    title: string;
    summary: string;
    observedAt: number;
    occurredAt?: number;
    exposedDataClasses: string[];
    providerConfidence: number;
    evidence: Array<{
        key: string;
        label: string;
        value: string;
    }>;
    indicators?: {
        passwordExposure?: boolean;
        sessionTokenExposure?: boolean;
        infostealer?: boolean;
        maliciousUrl?: boolean;
        impersonation?: boolean;
    };
}

export interface SecurityRiskAssessment {
    score: number;
    severity: SecurityFindingSeverity;
    confidence: number;
    factors: Array<{
        code: string;
        label: string;
        points: number;
    }>;
    likelyRisks: Array<"credential_stuffing" | "account_takeover" | "targeted_phishing" | "impersonation" | "scam">;
    recommendedActions: string[];
}

export interface ProviderScanResult {
    provider: SecurityProviderId;
    status: "success" | "not_configured" | "unsupported_identity" | "rate_limited" | "partial" | "failed";
    latencyMs: number;
    findings: NormalizedSecurityFinding[];
    safeMessage?: string;
    retryAfterMs?: number;
}

