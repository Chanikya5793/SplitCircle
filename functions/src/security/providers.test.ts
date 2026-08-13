import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlareProvider, HibpProvider, securityFindingDedupeKey } from "./providers";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });

afterEach(() => vi.unstubAllGlobals());

describe("HIBP provider normalization", () => {
    it("matches the k-anonymous email suffix and discards unrelated range entries", async () => {
        const email = "owner@example.com";
        const digest = createHash("sha1").update(email).digest("hex").toUpperCase();
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("/breachedaccount/range/")) {
                expect(url.endsWith(digest.slice(0, 6))).toBe(true);
                expect(url).not.toContain(email);
                return json([
                    { hashSuffix: "0".repeat(34), websites: ["Unrelated"] },
                    { hashSuffix: digest.slice(6), websites: ["ExampleBreach"] },
                ]);
            }
            if (url.endsWith("/breaches")) {
                return json([
                    { Name: "ExampleBreach", Title: "Example Service", Domain: "example.com", BreachDate: "2026-08-01", DataClasses: ["Email addresses", "Passwords"], IsVerified: true },
                    { Name: "Unrelated", Title: "Should be discarded", Domain: "other.test", DataClasses: ["Passwords"] },
                ]);
            }
            if (url.includes("/pasteAccount/")) return json([], 404);
            if (url.includes("/stealerLogsByEmail/")) return json(["accounts.example.com"]);
            throw new Error(`Unexpected URL ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);

        const result = await new HibpProvider("0".repeat(32)).scan({ type: "email", value: email });
        expect(result.status).toBe("success");
        expect(result.findings).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "breach", title: "Example Service" }),
            expect.objectContaining({ kind: "infostealer", indicators: expect.objectContaining({ infostealer: true }) }),
        ]));
        expect(JSON.stringify(result)).not.toContain("Should be discarded");
        expect(JSON.stringify(result)).not.toContain(email);
    });

    it("keeps partial stealer-plan failures separate from successful breach results", async () => {
        const email = "owner@example.com";
        const digest = createHash("sha1").update(email).digest("hex").toUpperCase();
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes("/breachedaccount/range/")) return json([{ hashSuffix: digest.slice(6), websites: [] }]);
            if (url.endsWith("/breaches")) return json([]);
            if (url.includes("/stealerLogsByEmail/")) return json({ message: "plan required" }, 403);
            return json([], 404);
        }));
        const result = await new HibpProvider("0".repeat(32)).scan({ type: "email", value: email });
        expect(result.status).toBe("success");
        expect(result.safeMessage).toMatch(/eligible HIBP plan/);
    });
});

describe("Flare provider normalization", () => {
    it("creates a real identifier, scans the v4 feed, and drops raw secrets", async () => {
        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith("/tokens/generate")) return json({ token: "short-lived-token" });
            if (url.includes("/firework/v3/identifiers/?")) return json({ items: [] });
            if (url.endsWith("/firework/v2/assets/")) {
                expect(init?.method).toBe("POST");
                return json({ asset: { id: 42, name: "owner@example.com", type: "email" } });
            }
            if (url.endsWith("/firework/v4/events/identifiers/42/_search")) {
                return json({ items: [{
                    metadata: { uid: "stealer/event/123", type: "stealer_log", severity: "critical", estimated_created_at: "2026-08-10T00:00:00Z" },
                    password: "NEVER-PERSIST-THIS",
                    cookie: "NEVER-PERSIST-COOKIE",
                    raw_dump: "NEVER-PERSIST-DUMP",
                }] });
            }
            throw new Error(`Unexpected URL ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);

        const result = await new FlareProvider("flare-key").scan({ type: "email", value: "owner@example.com" });
        expect(result.status).toBe("success");
        expect(result.providerReference).toBe("42");
        expect(result.findings[0]).toMatchObject({ kind: "infostealer", sourceReference: "stealer/event/123" });
        expect(JSON.stringify(result)).not.toMatch(/NEVER-PERSIST|short-lived-token|owner@example\.com/);
    });

    it("requires provider credentials to honor deletion", async () => {
        await expect(new FlareProvider("").remove("42")).rejects.toThrow(/not configured/);
    });
});

describe("finding deduplication", () => {
    it("is stable for the same identity/source and isolated across identities", () => {
        const finding = {
            source: "flare" as const,
            sourceReference: "event/1",
            kind: "infostealer" as const,
            title: "Exposure",
            summary: "Safe",
            observedAt: 1,
            exposedDataClasses: [],
            providerConfidence: 1,
            evidence: [],
        };
        expect(securityFindingDedupeKey("i1", finding)).toBe(securityFindingDedupeKey("i1", finding));
        expect(securityFindingDedupeKey("i1", finding)).not.toBe(securityFindingDedupeKey("i2", finding));
    });
});
