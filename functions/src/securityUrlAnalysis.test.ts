import { describe, expect, it, vi } from "vitest";
import { analyzeUrl, collectDomainEnrichment, isPrivateOrReservedAddress } from "./securityUrlAnalysis";

describe("phishing URL analysis", () => {
    it("detects a brand lookalike without requesting the untrusted URL", async () => {
        const fetchImpl = vi.fn(async (input: string | URL | Request) => {
            expect(String(input)).toMatch(/^https:\/\/webrisk\.googleapis\.com\//);
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }) as unknown as typeof fetch;

        const result = await analyzeUrl("https://paypa1.com/login?redirect=https://example.net", {
            fetchImpl,
            apiKey: "test-key",
            now: 1_700_000_000_000,
            enrichNetwork: false,
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(result.indicators.map((entry) => entry.code)).toEqual(
            expect.arrayContaining(["lookalike", "credential_words", "redirect"]),
        );
        expect(result.safeToOpen).toBe(false);
        expect(result.risk.likelyRisks).toContain("impersonation");
    });

    it("treats a Web Risk match as a high-confidence malicious signal", async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            threat: { threatTypes: ["SOCIAL_ENGINEERING"] },
        }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

        const result = await analyzeUrl("https://example.test/path", {
            fetchImpl,
            apiKey: "test-key",
            now: 1_700_000_000_000,
            enrichNetwork: false,
        });
        expect(result.indicators).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "web_risk" }),
        ]));
        expect(result.risk.confidence).toBeGreaterThan(0.9);
        expect(result.safeToOpen).toBe(false);
    });

    it("rejects executable and credential-bearing URL schemes", async () => {
        await expect(analyzeUrl("javascript:alert(1)", { apiKey: "", enrichNetwork: false })).rejects.toThrow();
        await expect(analyzeUrl("https://user:secret@example.com", { apiKey: "", enrichNetwork: false })).rejects.toThrow();
    });

    it("blocks private and reserved DNS answers before live TLS inspection", () => {
        expect(isPrivateOrReservedAddress("127.0.0.1")).toBe(true);
        expect(isPrivateOrReservedAddress("169.254.169.254")).toBe(true);
        expect(isPrivateOrReservedAddress("::ffff:10.0.0.2")).toBe(true);
        expect(isPrivateOrReservedAddress("2001:db8::1")).toBe(true);
        expect(isPrivateOrReservedAddress("8.8.8.8")).toBe(false);
        expect(isPrivateOrReservedAddress("2606:4700:4700::1111")).toBe(false);
    });

    it("combines bounded RDAP, certificate transparency, and TLS evidence", async () => {
        const fetchImpl = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.startsWith("https://rdap.org/domain/")) {
                return new Response(JSON.stringify({
                    events: [{ eventAction: "registration", eventDate: "2026-08-12T00:00:00Z" }],
                }), { status: 200 });
            }
            if (url.startsWith("https://crt.sh/")) {
                return new Response(JSON.stringify([{ not_before: "2026-08-12T12:00:00Z" }]), { status: 200 });
            }
            throw new Error(`Unexpected URL ${url}`);
        }) as typeof fetch;
        const enrichment = await collectDomainEnrichment("example.com", fetchImpl, {
            lookupImpl: async () => [{ address: "8.8.8.8" }],
            tlsInspector: async () => ({ authorized: false, validTo: Date.parse("2027-01-01T00:00:00Z") }),
        });
        expect(enrichment).toMatchObject({
            status: "success",
            dnsAddressCount: 1,
            registeredAt: Date.parse("2026-08-12T00:00:00Z"),
            latestCtCertificateAt: Date.parse("2026-08-12T12:00:00Z"),
            certificate: { authorized: false },
        });

        const result = await analyzeUrl("https://paypa1.com/signin", {
            apiKey: "",
            now: Date.parse("2026-08-13T00:00:00Z"),
            domainEnrichment: enrichment,
        });
        expect(result.indicators).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "new_domain" }),
            expect.objectContaining({ code: "tls_invalid" }),
            expect.objectContaining({ code: "new_certificate" }),
        ]));
        expect(result.safeToOpen).toBe(false);
    });

    it("fails enrichment closed when DNS resolves only to private infrastructure", async () => {
        const enrichment = await collectDomainEnrichment("internal.example", fetch, {
            lookupImpl: async () => [{ address: "10.0.0.2" }, { address: "::1" }],
            tlsInspector: vi.fn(),
        });
        expect(enrichment).toEqual({ status: "failed", dnsAddressCount: 0 });
    });
});
