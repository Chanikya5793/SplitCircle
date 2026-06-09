/**
 * askExpenseAi.test.ts — callable bridge: input validation, gating, uid-from-token
 * proxying, and error mapping. firebase-functions + fetch are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("firebase-functions/v2/https", () => {
  class HttpsError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = "HttpsError";
    }
  }
  return { HttpsError, onCall: (handler: unknown) => handler };
});
vi.mock("firebase-functions/logger", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { askExpenseAi, validateAskInput, readRagConfig } from "./askExpenseAi";

type Handler = (request: { auth?: { uid?: string }; data?: unknown }) => Promise<unknown>;
const handler = askExpenseAi as unknown as Handler;

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("validateAskInput", () => {
    it("requires a non-empty question", () => {
        expect(() => validateAskInput({})).toThrow(/question is required/);
        expect(() => validateAskInput({ question: "   " })).toThrow(/question is required/);
    });

    it("caps question length and clamps topK", () => {
        expect(() => validateAskInput({ question: "x".repeat(501) })).toThrow(/too long/);
        expect(validateAskInput({ question: "q", topK: 99 }).topK).toBeUndefined();
        expect(validateAskInput({ question: "q", topK: 5 }).topK).toBe(5);
    });
});

describe("readRagConfig", () => {
    it("is null unless gated on AND fully configured", () => {
        expect(readRagConfig({ NODE_ENV: "test" })).toBeNull();
        expect(readRagConfig({ NODE_ENV: "test", AI_LAYER_ENABLED: "true" })).toBeNull();
        expect(readRagConfig({ NODE_ENV: "test", AI_LAYER_ENABLED: "true", RAG_SERVICE_URL: "https://r/", RAG_SHARED_SECRET: "s" }))
            .toEqual({ url: "https://r", secret: "s" });
    });
});

describe("askExpenseAi handler", () => {
    beforeEach(() => {
        process.env.AI_LAYER_ENABLED = "true";
        process.env.RAG_SERVICE_URL = "https://rag.example";
        process.env.RAG_SHARED_SECRET = "shh";
    });

    it("rejects unauthenticated calls", async () => {
        await expect(handler({ data: { question: "q" } })).rejects.toThrow(/Sign in/);
    });

    it("fails with a precondition error when the AI layer is gated off", async () => {
        process.env.AI_LAYER_ENABLED = "false";
        await expect(handler({ auth: { uid: "u1" }, data: { question: "q" } }))
            .rejects.toThrow(/isn't available yet/);
    });

    it("proxies with the token uid (never the payload) and maps the answer", async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({ answer: "You spent $40 [1].", sources: [{ expenseId: "e1" }], confidence: 0.8 }),
        })) as unknown as typeof fetch;
        globalThis.fetch = fetchMock;

        const res = await handler({
            auth: { uid: "token-uid" },
            data: { question: "food?", groupId: "g1", userId: "spoofed-uid" },
        });

        expect(res).toEqual({ answer: "You spent $40 [1].", sources: [{ expenseId: "e1" }], confidence: 0.8 });
        const [url, init] = (fetchMock as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0];
        expect(url).toBe("https://rag.example/query");
        const body = JSON.parse(init.body);
        expect(body.userId).toBe("token-uid"); // spoofed payload uid ignored
        expect(body.groupId).toBe("g1");
    });

    it("maps RAG failures to a friendly internal error without leaking detail", async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
        await expect(handler({ auth: { uid: "u1" }, data: { question: "q" } }))
            .rejects.toThrow(/hit an error/);
    });
});
