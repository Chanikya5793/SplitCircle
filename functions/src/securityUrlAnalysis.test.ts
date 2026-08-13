import { describe, expect, it, vi } from "vitest";
import { analyzeUrl } from "./securityUrlAnalysis";

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
        });
        expect(result.indicators).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "web_risk" }),
        ]));
        expect(result.risk.confidence).toBeGreaterThan(0.9);
        expect(result.safeToOpen).toBe(false);
    });

    it("rejects executable and credential-bearing URL schemes", async () => {
        await expect(analyzeUrl("javascript:alert(1)", { apiKey: "" })).rejects.toThrow();
        await expect(analyzeUrl("https://user:secret@example.com", { apiKey: "" })).rejects.toThrow();
    });
});

