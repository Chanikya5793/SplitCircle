import { createHash } from "node:crypto";
import { domainToUnicode } from "node:url";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assessSecurityRisk } from "./security/riskEngine";
import type { NormalizedSecurityFinding } from "./security/types";

const webRiskApiKey = defineSecret("GOOGLE_WEB_RISK_API_KEY");
const MAX_URL_LENGTH = 2048;
const LOOKUP_TIMEOUT_MS = 10_000;

const OFFICIAL_DOMAINS: Record<string, string> = {
    apple: "apple.com",
    google: "google.com",
    microsoft: "microsoft.com",
    paypal: "paypal.com",
    amazon: "amazon.com",
    facebook: "facebook.com",
    instagram: "instagram.com",
    netflix: "netflix.com",
    chase: "chase.com",
    coinbase: "coinbase.com",
};

const secretValue = (): string => {
    try {
        return webRiskApiKey.value().trim();
    } catch {
        return process.env.GOOGLE_WEB_RISK_API_KEY?.trim() ?? "";
    }
};

const editDistance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        let previous = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const old = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = old;
        }
    }
    return row[b.length];
};

const registrableLabel = (hostname: string): string => {
    const parts = hostname.split(".").filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : hostname;
};

export interface UrlAnalysisResult {
    hostname: string;
    risk: ReturnType<typeof assessSecurityRisk>;
    indicators: Array<{ code: string; label: string; evidence: string }>;
    providerStatus: "success" | "not_configured" | "failed";
    safeToOpen: boolean;
    checkedAt: number;
}

export async function analyzeUrl(
    rawUrl: string,
    options: { fetchImpl?: typeof fetch; apiKey?: string; now?: number } = {},
): Promise<UrlAnalysisResult> {
    if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) throw new HttpsError("invalid-argument", "Enter a valid link.");
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    let parsed: URL;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new HttpsError("invalid-argument", "Enter a valid web link.");
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new HttpsError("invalid-argument", "Only ordinary http or https links can be analyzed.");
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const unicodeHost = domainToUnicode(hostname);
    const label = registrableLabel(hostname);
    const indicators: UrlAnalysisResult["indicators"] = [];
    const add = (code: string, title: string, evidence: string) => {
        if (!indicators.some((entry) => entry.code === code)) indicators.push({ code, label: title, evidence });
    };

    if (parsed.protocol !== "https:") add("no_https", "No HTTPS", "The link does not request an encrypted HTTPS connection.");
    if (hostname.includes("xn--") || /[^\x00-\x7F]/.test(unicodeHost)) {
        add("idn", "Internationalized hostname", "The hostname uses Unicode or punycode characters that can hide lookalikes.");
    }
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(":")) {
        add("ip_host", "IP address instead of a domain", "The link identifies a server directly rather than a recognizable domain.");
    }
    if (hostname.split(".").length > 4) add("deep_subdomain", "Excessive subdomains", "Important brand text may be buried in a long hostname.");
    if (/(?:login|signin|verify|secure|account|wallet|password|recovery)/i.test(parsed.pathname + parsed.search)) {
        add("credential_words", "Credential-themed path", "The link asks attention toward sign-in, verification, or recovery content.");
    }
    if ([...parsed.searchParams.keys()].some((key) => /^(?:url|u|redirect|redirect_uri|continue|next|dest(?:ination)?)$/i.test(key))) {
        add("redirect", "Redirect parameter", "The link contains a parameter that may send the browser somewhere else.");
    }

    for (const [brand, officialDomain] of Object.entries(OFFICIAL_DOMAINS)) {
        if (hostname === officialDomain || hostname.endsWith(`.${officialDomain}`)) continue;
        const distance = editDistance(label.replace(/[-_]/g, ""), brand);
        if (label.includes(brand) || distance === 1) {
            add("lookalike", "Possible brand lookalike", `The hostname resembles ${brand}, but it is not under ${officialDomain}.`);
            break;
        }
    }

    let providerStatus: UrlAnalysisResult["providerStatus"] = "not_configured";
    const apiKey = options.apiKey ?? secretValue();
    if (apiKey) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
        try {
            const params = new URLSearchParams({ uri: parsed.toString(), key: apiKey });
            for (const threatType of ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"]) {
                params.append("threatTypes", threatType);
            }
            const response = await (options.fetchImpl ?? fetch)(`https://webrisk.googleapis.com/v1/uris:search?${params}`, {
                method: "GET",
                signal: controller.signal,
                redirect: "error",
            });
            if (!response.ok) throw new Error("Web Risk lookup failed");
            const body = await response.json() as { threat?: { threatTypes?: unknown } };
            const threats = Array.isArray(body.threat?.threatTypes)
                ? body.threat!.threatTypes!.filter((value): value is string => typeof value === "string")
                : [];
            if (threats.length > 0) {
                add("web_risk", "Google Web Risk match", `Threat lists matched: ${threats.slice(0, 4).join(", ").replace(/_/g, " ").toLowerCase()}.`);
            }
            providerStatus = "success";
        } catch {
            providerStatus = "failed";
        } finally {
            clearTimeout(timer);
        }
    }

    const now = options.now ?? Date.now();
    const finding: NormalizedSecurityFinding = {
        source: indicators.some((entry) => entry.code === "web_risk") ? "google_web_risk" : "manasplit",
        sourceReference: createHash("sha256").update(hostname).digest("base64url"),
        kind: indicators.some((entry) => entry.code === "lookalike" || entry.code === "idn") ? "impersonation" : "phishing",
        title: indicators.length > 0 ? "Suspicious link indicators detected" : "No known link threat detected",
        summary: indicators.length > 0
            ? "ManaSplit found risk signals without opening the link in a browser."
            : "No deterministic or configured reputation signal matched. This is not a guarantee that the link is safe.",
        observedAt: now,
        exposedDataClasses: [],
        providerConfidence: indicators.some((entry) => entry.code === "web_risk") ? 0.98 : indicators.length > 0 ? 0.72 : 0.55,
        evidence: indicators.map((entry) => ({ key: entry.code, label: entry.label, value: entry.evidence })),
        indicators: {
            maliciousUrl: indicators.some((entry) => entry.code === "web_risk"),
            impersonation: indicators.some((entry) => entry.code === "lookalike" || entry.code === "idn"),
        },
    };
    const risk = assessSecurityRisk(finding, { now });
    return { hostname, risk, indicators, providerStatus, safeToOpen: indicators.length === 0 && providerStatus === "success", checkedAt: now };
}

export const analyzeSecurityUrl = onCall({ secrets: [webRiskApiKey] }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
    const result = await analyzeUrl(typeof request.data?.url === "string" ? request.data.url.trim() : "");
    const rootRef = getFirestore().collection("securityMonitors").doc(uid);
    if (result.indicators.length > 0) {
        const findingId = createHash("sha256").update(`url:v1:${result.hostname}`).digest("base64url");
        await rootRef.collection("findings").doc(findingId).set({
            findingId,
            identityId: "url-analysis",
            identityHint: result.hostname,
            source: result.providerStatus === "success" ? "google_web_risk" : "manasplit",
            sourceReference: findingId,
            kind: result.risk.likelyRisks.includes("impersonation") ? "impersonation" : "phishing",
            title: "Suspicious link indicators detected",
            summary: "ManaSplit found risk signals without opening the link in a browser.",
            observedAt: result.checkedAt,
            occurredAt: null,
            exposedDataClasses: [],
            evidence: result.indicators.map((entry) => ({ key: entry.code, label: entry.label, value: entry.evidence })),
            assessment: result.risk,
            state: "active",
            firstSeenAt: FieldValue.serverTimestamp(),
            lastSeenAt: FieldValue.serverTimestamp(),
            occurrenceCount: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        await rootRef.collection("timeline").add({ type: "url_analyzed", findingId, createdAt: FieldValue.serverTimestamp() });
    }
    return result;
});

export const securityUrlSecrets = { webRiskApiKey };

