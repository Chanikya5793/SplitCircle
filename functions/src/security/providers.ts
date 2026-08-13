import { createHash } from "node:crypto";
import type {
    NormalizedSecurityFinding,
    ProviderScanResult,
    SecurityIdentityType,
} from "./types";

const HIBP_BASE_URL = "https://haveibeenpwned.com/api/v3";
const FLARE_BASE_URL = "https://api.flare.io";
const REQUEST_TIMEOUT_MS = 12_000;

export interface SecurityProviderScanContext {
    type: SecurityIdentityType;
    value: string;
    providerReference?: string;
    providerManaged?: boolean;
    signal?: AbortSignal;
}

export interface SecurityProviderAdapter {
    readonly id: ProviderScanResult["provider"];
    scan(context: SecurityProviderScanContext): Promise<ProviderScanResult & { providerReference?: string; providerManaged?: boolean }>;
    remove?(providerReference: string): Promise<void>;
}

const safeText = (value: unknown, fallback: string, max = 160): string => {
    if (typeof value !== "string") return fallback;
    const cleaned = value
        .replace(/<[^>]*>/g, " ")
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return cleaned ? cleaned.slice(0, max) : fallback;
};

const safeStringArray = (value: unknown, max = 24): string[] =>
    Array.isArray(value)
        ? [...new Set(value.map((item) => safeText(item, "", 64)).filter(Boolean))].slice(0, max)
        : [];

const toTimestamp = (value: unknown, fallback: number): number => {
    if (typeof value !== "string") return fallback;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const requestJson = async <T>(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
): Promise<{ status: number; headers: Headers; body: T | null }> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
        const contentType = response.headers.get("content-type") ?? "";
        const body = contentType.includes("json") ? await response.json() as T : null;
        return { status: response.status, headers: response.headers, body };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
    }
};

type HibpBreach = {
    Name?: unknown;
    Title?: unknown;
    Domain?: unknown;
    BreachDate?: unknown;
    AddedDate?: unknown;
    DataClasses?: unknown;
    IsVerified?: unknown;
    IsSpamList?: unknown;
};

type HibpRangeEntry = { hashSuffix?: unknown; websites?: unknown };
type HibpPaste = { Source?: unknown; Id?: unknown; Date?: unknown; EmailCount?: unknown };

export class HibpProvider implements SecurityProviderAdapter {
    readonly id = "hibp" as const;
    private breachCatalog: HibpBreach[] | null = null;

    constructor(private readonly apiKey: string) {}

    async scan(context: SecurityProviderScanContext): Promise<ProviderScanResult> {
        const started = Date.now();
        if (!this.apiKey) {
            return { provider: this.id, status: "not_configured", latencyMs: 0, findings: [], safeMessage: "HIBP API key is not configured." };
        }
        if (context.type !== "email") {
            return { provider: this.id, status: "unsupported_identity", latencyMs: 0, findings: [] };
        }

        try {
            const headers = {
                "hibp-api-key": this.apiKey,
                "user-agent": "ManaSplit-Security-Monitoring/1.0",
            };
            const sha1 = createHash("sha1").update(context.value.toLowerCase(), "utf8").digest("hex").toUpperCase();
            const prefix = sha1.slice(0, 6);
            const suffix = sha1.slice(6);

            // Keep account-specific calls sequential. HIBP rate limits vary by
            // subscription, and firing four requests at once turns one scan
            // into a needless burst. The public breach catalog is reused for
            // every identity scanned by this provider instance.
            const range = await requestJson<HibpRangeEntry[]>(
                `${HIBP_BASE_URL}/breachedaccount/range/${prefix}`,
                { headers },
                context.signal,
            );
            if (range.status === 429) {
                const retrySeconds = Number(range.headers.get("retry-after") ?? 60);
                return {
                    provider: this.id,
                    status: "rate_limited",
                    latencyMs: Date.now() - started,
                    findings: [],
                    retryAfterMs: Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 60_000,
                };
            }
            let catalogStatus = 200;
            if (!this.breachCatalog) {
                const catalog = await requestJson<HibpBreach[]>(`${HIBP_BASE_URL}/breaches`, { headers }, context.signal);
                catalogStatus = catalog.status;
                if (catalog.status === 429) {
                    const retrySeconds = Number(catalog.headers.get("retry-after") ?? 60);
                    return {
                        provider: this.id,
                        status: "rate_limited",
                        latencyMs: Date.now() - started,
                        findings: [],
                        retryAfterMs: Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 60_000,
                    };
                }
                if (catalog.status === 200 && Array.isArray(catalog.body)) this.breachCatalog = catalog.body;
            }
            const pastes = await requestJson<HibpPaste[]>(
                `${HIBP_BASE_URL}/pasteAccount/${encodeURIComponent(context.value)}`,
                { headers },
                context.signal,
            );
            if (pastes.status === 429) {
                const retrySeconds = Number(pastes.headers.get("retry-after") ?? 60);
                return {
                    provider: this.id,
                    status: "rate_limited",
                    latencyMs: Date.now() - started,
                    findings: [],
                    retryAfterMs: Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 60_000,
                };
            }
            const stealer = await requestJson<string[]>(
                `${HIBP_BASE_URL}/stealerLogsByEmail/${encodeURIComponent(context.value)}`,
                { headers },
                context.signal,
            );

            if (stealer.status === 429) {
                const retrySeconds = Number(stealer.headers.get("retry-after") ?? 60);
                return {
                    provider: this.id,
                    status: "rate_limited",
                    latencyMs: Date.now() - started,
                    findings: [],
                    retryAfterMs: Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 60_000,
                };
            }

            const matchedRange = Array.isArray(range.body)
                ? range.body.find((entry) => safeText(entry.hashSuffix, "", 40).toUpperCase() === suffix)
                : undefined;
            const breachNames = new Set(safeStringArray(matchedRange?.websites));
            const catalogByName = new Map(
                (this.breachCatalog ?? []).map((breach) => [safeText(breach.Name, "", 80), breach]),
            );
            const now = Date.now();
            const findings: NormalizedSecurityFinding[] = [];

            for (const name of breachNames) {
                const breach = catalogByName.get(name);
                const dataClasses = safeStringArray(breach?.DataClasses);
                findings.push({
                    source: this.id,
                    sourceReference: `breach:${name}`,
                    kind: "breach",
                    title: safeText(breach?.Title, name || "Known data breach", 96),
                    summary: "This monitored email appears in a known breach record.",
                    observedAt: now,
                    occurredAt: toTimestamp(breach?.BreachDate, now),
                    exposedDataClasses: dataClasses,
                    providerConfidence: breach?.IsVerified === false ? 0.62 : 0.94,
                    evidence: [
                        { key: "source", label: "Source", value: "Have I Been Pwned" },
                        { key: "domain", label: "Affected service", value: safeText(breach?.Domain, "Not provided", 120) },
                        { key: "verification", label: "Provider verification", value: breach?.IsVerified === false ? "Unverified" : "Verified" },
                    ],
                    indicators: { passwordExposure: dataClasses.some((value) => /password/i.test(value)) },
                });
            }

            if (Array.isArray(pastes.body)) {
                for (const paste of pastes.body.slice(0, 20)) {
                    const source = safeText(paste.Source, "Paste source", 48);
                    const id = safeText(paste.Id, "unknown", 96);
                    findings.push({
                        source: this.id,
                        sourceReference: `paste:${source}:${id}`,
                        kind: "paste",
                        title: "Email mentioned in a public paste",
                        summary: "A paste index contains the monitored email. Raw paste content is never retrieved or stored.",
                        observedAt: now,
                        occurredAt: toTimestamp(paste.Date, now),
                        exposedDataClasses: ["email address"],
                        providerConfidence: 0.82,
                        evidence: [
                            { key: "source", label: "Source", value: `Have I Been Pwned · ${source}` },
                            { key: "emailCount", label: "Email addresses in paste", value: String(Number(paste.EmailCount) || 0) },
                        ],
                    });
                }
            }

            if (Array.isArray(stealer.body)) {
                for (const domain of safeStringArray(stealer.body, 50)) {
                    findings.push({
                        source: this.id,
                        sourceReference: `stealer:${domain}`,
                        kind: "infostealer",
                        title: "Credentials captured by an infostealer",
                        summary: "The provider links this monitored email to credentials used on an affected service. No password or token is returned or stored.",
                        observedAt: now,
                        exposedDataClasses: ["email address", "credential metadata"],
                        providerConfidence: 0.97,
                        evidence: [
                            { key: "source", label: "Source", value: "Have I Been Pwned stealer logs" },
                            { key: "affectedService", label: "Affected service", value: domain },
                        ],
                        indicators: { infostealer: true, passwordExposure: true },
                    });
                }
            }

            const partial = range.status !== 200 || catalogStatus !== 200 ||
                ![200, 404, 403].includes(pastes.status) || ![200, 404, 403].includes(stealer.status);
            return {
                provider: this.id,
                status: partial ? "partial" : "success",
                latencyMs: Date.now() - started,
                findings,
                ...(stealer.status === 403 ? { safeMessage: "Stealer-log access requires an eligible HIBP plan and verified domain." } : {}),
            };
        } catch (error) {
            return {
                provider: this.id,
                status: context.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "failed" : "failed",
                latencyMs: Date.now() - started,
                findings: [],
                safeMessage: "HIBP did not complete this scan.",
            };
        }
    }
}

type FlareIdentifier = { id?: unknown; name?: unknown; type?: unknown };
type FlareEvent = {
    metadata?: {
        uid?: unknown;
        type?: unknown;
        severity?: unknown;
        estimated_created_at?: unknown;
        matched_at?: unknown;
    };
};

export class FlareProvider implements SecurityProviderAdapter {
    readonly id = "flare" as const;

    constructor(private readonly apiKey: string) {}

    private async token(signal?: AbortSignal): Promise<string> {
        const response = await requestJson<{ token?: unknown }>(
            `${FLARE_BASE_URL}/tokens/generate`,
            { method: "POST", headers: { Authorization: this.apiKey, "content-type": "application/json" }, body: "{}" },
            signal,
        );
        const token = safeText(response.body?.token, "", 4096);
        if (response.status !== 200 || !token) throw new Error("Flare authentication failed");
        return token;
    }

    private async ensureIdentifier(
        token: string,
        context: SecurityProviderScanContext,
    ): Promise<{ providerReference: string; providerManaged: boolean }> {
        if (context.providerReference && /^\d+$/.test(context.providerReference)) {
            return { providerReference: context.providerReference, providerManaged: context.providerManaged === true };
        }
        const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
        const search = await requestJson<{ items?: FlareIdentifier[] }>(
            `${FLARE_BASE_URL}/firework/v3/identifiers/?q=${encodeURIComponent(context.value)}&exact_matches_only=true&size=20`,
            { headers },
            context.signal,
        );
        const existing = Array.isArray(search.body?.items)
            ? search.body.items.find((entry) => safeText(entry.name, "", 320).toLowerCase() === context.value.toLowerCase())
            : undefined;
        if (existing && Number.isSafeInteger(Number(existing.id))) {
            return { providerReference: String(existing.id), providerManaged: false };
        }

        const create = await requestJson<{ asset?: FlareIdentifier }>(
            `${FLARE_BASE_URL}/firework/v2/assets/`,
            {
                method: "POST",
                headers,
                body: JSON.stringify({
                    data: {},
                    name: context.value,
                    type: context.type,
                    search_types: ["leaks", "paste", "illicit_networks", "infected_devices", "domains"],
                }),
            },
            context.signal,
        );
        const id = Number(create.body?.asset?.id);
        if (create.status !== 200 || !Number.isSafeInteger(id)) throw new Error("Flare identifier enrollment failed");
        return { providerReference: String(id), providerManaged: true };
    }

    async scan(context: SecurityProviderScanContext): Promise<ProviderScanResult & { providerReference?: string; providerManaged?: boolean }> {
        const started = Date.now();
        if (!this.apiKey) {
            return { provider: this.id, status: "not_configured", latencyMs: 0, findings: [], safeMessage: "Flare API key is not configured." };
        }
        if (!["email", "username", "domain"].includes(context.type)) {
            return { provider: this.id, status: "unsupported_identity", latencyMs: 0, findings: [] };
        }

        try {
            const token = await this.token(context.signal);
            const { providerReference, providerManaged } = await this.ensureIdentifier(token, context);
            const response = await requestJson<{ items?: FlareEvent[] }>(
                `${FLARE_BASE_URL}/firework/v4/events/identifiers/${providerReference}/_search`,
                {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
                    body: JSON.stringify({
                        query: {},
                        size: 100,
                        order: "desc",
                        filters: { type: ["leaked_credential", "paste", "forum_post", "chat_message", "stealer_log", "domain"] },
                    }),
                },
                context.signal,
            );
            if (response.status === 429) {
                return { provider: this.id, status: "rate_limited", latencyMs: Date.now() - started, findings: [], providerReference, providerManaged, retryAfterMs: 60_000 };
            }
            if (response.status !== 200) throw new Error("Flare event feed failed");

            const now = Date.now();
            const findings: NormalizedSecurityFinding[] = (Array.isArray(response.body?.items) ? response.body!.items! : [])
                .map((event): NormalizedSecurityFinding | null => {
                    const type = safeText(event.metadata?.type, "", 48);
                    const uid = safeText(event.metadata?.uid, "", 180);
                    if (!type || !uid) return null;
                    const infostealer = type === "stealer_log";
                    const impersonation = type === "domain";
                    const kind: NormalizedSecurityFinding["kind"] = infostealer
                        ? "infostealer"
                        : impersonation
                            ? "impersonation"
                            : type === "paste"
                                ? "paste"
                                : type === "leaked_credential"
                                    ? "credential_exposure"
                                    : "breach";
                    return {
                        source: this.id,
                        sourceReference: uid,
                        kind,
                        title: infostealer
                            ? "Infostealer exposure detected"
                            : impersonation
                                ? "Possible lookalike domain detected"
                                : "Dark-web exposure detected",
                        summary: "Flare matched a monitored identifier. ManaSplit retained only normalized metadata, not the raw event or exposed secret.",
                        observedAt: now,
                        occurredAt: toTimestamp(event.metadata?.estimated_created_at ?? event.metadata?.matched_at, now),
                        exposedDataClasses: infostealer ? ["credential metadata", "infected-device metadata"] : [type.replace(/_/g, " ")],
                        providerConfidence: ["critical", "high"].includes(safeText(event.metadata?.severity, "", 16)) ? 0.94 : 0.82,
                        evidence: [
                            { key: "source", label: "Source", value: "Flare" },
                            { key: "eventType", label: "Event class", value: type.replace(/_/g, " ") },
                            { key: "providerSeverity", label: "Provider severity", value: safeText(event.metadata?.severity, "Not provided", 24) },
                        ],
                        indicators: { infostealer, impersonation, passwordExposure: type === "leaked_credential" },
                    };
                })
                .filter((finding): finding is NormalizedSecurityFinding => finding !== null);

            return { provider: this.id, status: "success", latencyMs: Date.now() - started, findings, providerReference, providerManaged };
        } catch {
            return { provider: this.id, status: "failed", latencyMs: Date.now() - started, findings: [], safeMessage: "Flare did not complete this scan." };
        }
    }

    async remove(providerReference: string): Promise<void> {
        if (!/^\d+$/.test(providerReference)) return;
        if (!this.apiKey) throw new Error("Flare API key is not configured for provider deletion");
        const token = await this.token();
        const response = await requestJson<unknown>(
            `${FLARE_BASE_URL}/firework/v3/identifiers/${providerReference}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
        );
        if (![200, 204, 404].includes(response.status)) throw new Error("Flare identifier removal failed");
    }
}

export const securityFindingDedupeKey = (identityId: string, finding: NormalizedSecurityFinding): string =>
    createHash("sha256")
        .update(`v1\0${identityId}\0${finding.source}\0${finding.sourceReference}\0${finding.kind}`, "utf8")
        .digest("base64url");
