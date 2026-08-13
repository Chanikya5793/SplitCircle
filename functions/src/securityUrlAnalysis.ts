import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { connect } from "node:tls";
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
    enrichmentStatus: "success" | "partial" | "failed";
    safeToOpen: boolean;
    checkedAt: number;
}

export interface DomainEnrichment {
    status: UrlAnalysisResult["enrichmentStatus"];
    dnsAddressCount: number;
    registeredAt?: number;
    certificate?: {
        authorized: boolean;
        validFrom?: number;
        validTo?: number;
        issuer?: string;
    };
    latestCtCertificateAt?: number;
}

export const isPrivateOrReservedAddress = (address: string): boolean => {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPrivateOrReservedAddress(normalized.slice(7));
    if (normalized.includes(":")) {
        return normalized === "::1" || normalized === "::" ||
            normalized.startsWith("fc") || normalized.startsWith("fd") ||
            /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") ||
            normalized.startsWith("2001:db8:");
    }
    const parts = normalized.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
        (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
        (parts[0] === 169 && parts[1] === 254) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && (parts[1] === 0 || parts[1] === 168)) ||
        (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || parts[1] === 51)) ||
        (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
        parts[0] >= 224;
};

const boundedJson = async <T>(response: Response, maxBytes = 1_000_000): Promise<T> => {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error("Enrichment response exceeded limit");
    return JSON.parse(text) as T;
};

const inspectTlsCertificate = async (hostname: string, address: string): Promise<DomainEnrichment["certificate"]> =>
    new Promise((resolve, reject) => {
        const socket = connect({
            host: address,
            port: 443,
            servername: hostname,
            rejectUnauthorized: false,
            timeout: 5_000,
        }, () => {
            const certificate = socket.getPeerCertificate();
            const validFrom = Date.parse(certificate.valid_from ?? "");
            const validTo = Date.parse(certificate.valid_to ?? "");
            const issuer = typeof certificate.issuer?.O === "string" ? certificate.issuer.O.slice(0, 96) : undefined;
            resolve({
                authorized: socket.authorized,
                ...(Number.isFinite(validFrom) ? { validFrom } : {}),
                ...(Number.isFinite(validTo) ? { validTo } : {}),
                ...(issuer ? { issuer } : {}),
            });
            socket.end();
        });
        socket.once("timeout", () => socket.destroy(new Error("TLS inspection timed out")));
        socket.once("error", reject);
    });

export const collectDomainEnrichment = async (
    hostname: string,
    fetchImpl: typeof fetch,
    dependencies: {
        lookupImpl?: (hostname: string) => Promise<Array<{ address: string }>>;
        tlsInspector?: (hostname: string, address: string) => Promise<DomainEnrichment["certificate"]>;
    } = {},
): Promise<DomainEnrichment> => {
    let addresses: Array<{ address: string }> = [];
    try {
        addresses = dependencies.lookupImpl
            ? await dependencies.lookupImpl(hostname)
            : await lookup(hostname, { all: true, verbatim: true });
    } catch {
        return { status: "failed", dnsAddressCount: 0 };
    }
    const publicAddresses = addresses.filter((entry) => !isPrivateOrReservedAddress(entry.address));
    if (publicAddresses.length === 0) return { status: "failed", dnsAddressCount: 0 };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
        const [rdap, ct, certificate] = await Promise.allSettled([
            fetchImpl(`https://rdap.org/domain/${encodeURIComponent(hostname)}`, {
                method: "GET",
                headers: { accept: "application/rdap+json, application/json" },
                signal: controller.signal,
            }).then(async (response) => {
                if (!response.ok) throw new Error("RDAP failed");
                return boundedJson<{ events?: Array<{ eventAction?: unknown; eventDate?: unknown }> }>(response);
            }),
            fetchImpl(`https://crt.sh/?q=${encodeURIComponent(hostname)}&exclude=expired&output=json`, {
                method: "GET",
                headers: { accept: "application/json" },
                signal: controller.signal,
                redirect: "error",
            }).then(async (response) => {
                if (!response.ok) throw new Error("Certificate Transparency lookup failed");
                return boundedJson<Array<{ not_before?: unknown }>>(response);
            }),
            (dependencies.tlsInspector ?? inspectTlsCertificate)(hostname, publicAddresses[0].address),
        ]);
        const rdapBody = rdap.status === "fulfilled" ? rdap.value : null;
        const registration = rdapBody?.events?.find((event) => event.eventAction === "registration");
        const registeredAt = typeof registration?.eventDate === "string" ? Date.parse(registration.eventDate) : Number.NaN;
        const ctBody = ct.status === "fulfilled" && Array.isArray(ct.value) ? ct.value : [];
        const latestCtCertificateAt = ctBody.reduce((latest, entry) => {
            const parsed = typeof entry.not_before === "string" ? Date.parse(entry.not_before) : Number.NaN;
            return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
        }, 0);
        const successCount = [rdap, ct, certificate].filter((entry) => entry.status === "fulfilled").length;
        return {
            status: successCount === 3 ? "success" : successCount > 0 ? "partial" : "failed",
            dnsAddressCount: publicAddresses.length,
            ...(Number.isFinite(registeredAt) ? { registeredAt } : {}),
            ...(certificate.status === "fulfilled" ? { certificate: certificate.value } : {}),
            ...(latestCtCertificateAt > 0 ? { latestCtCertificateAt } : {}),
        };
    } finally {
        clearTimeout(timer);
    }
};

export async function analyzeUrl(
    rawUrl: string,
    options: {
        fetchImpl?: typeof fetch;
        apiKey?: string;
        now?: number;
        enrichNetwork?: boolean;
        domainEnrichment?: DomainEnrichment;
    } = {},
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

    const now = options.now ?? Date.now();
    const enrichment = options.domainEnrichment ?? (options.enrichNetwork === false
        ? { status: "failed" as const, dnsAddressCount: 0 }
        : await collectDomainEnrichment(hostname, options.fetchImpl ?? fetch));
    if (enrichment.registeredAt && now - enrichment.registeredAt <= 30 * 24 * 60 * 60 * 1000) {
        add("new_domain", "Newly registered domain", "RDAP reports that the domain was registered within the last 30 days.");
    }
    if (enrichment.certificate) {
        if (!enrichment.certificate.authorized || (enrichment.certificate.validTo ?? Number.POSITIVE_INFINITY) < now) {
            add("tls_invalid", "TLS certificate problem", "The live TLS handshake returned an invalid or expired certificate.");
        } else if ((enrichment.certificate.validTo ?? Number.POSITIVE_INFINITY) - now <= 7 * 24 * 60 * 60 * 1000) {
            add("tls_expiring", "TLS certificate expires soon", "The live certificate expires within seven days.");
        }
    }
    if (enrichment.latestCtCertificateAt && now - enrichment.latestCtCertificateAt <= 7 * 24 * 60 * 60 * 1000 &&
        indicators.some((entry) => entry.code === "lookalike" || entry.code === "idn")) {
        add("new_certificate", "Recent certificate-transparency event", "A recent certificate was observed for a lookalike hostname.");
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
            recentlyRegisteredDomain: indicators.some((entry) => entry.code === "new_domain"),
            certificateRisk: indicators.some((entry) => entry.code.startsWith("tls_") || entry.code === "new_certificate"),
        },
    };
    const risk = assessSecurityRisk(finding, { now });
    return {
        hostname,
        risk,
        indicators,
        providerStatus,
        enrichmentStatus: enrichment.status,
        safeToOpen: indicators.length === 0 && providerStatus === "success" && enrichment.status === "success",
        checkedAt: now,
    };
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
