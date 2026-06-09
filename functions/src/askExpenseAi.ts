/**
 * askExpenseAi.ts — App-facing callable bridge to the AI layer's RAG service.
 *
 * The RAG Cloud Run service is internal (shared-secret + IAM hop); the mobile
 * app must never hold that secret. This callable is the app's entry point: the
 * uid comes from the verified Firebase token (never from args, Critical Rule #2),
 * the question is validated, and the request is proxied server-side.
 *
 * Gated like the rest of the AI layer: without AI_LAYER_ENABLED=true and
 * RAG_SERVICE_URL/RAG_SHARED_SECRET in the runtime env it fails with
 * `failed-precondition`, so it is safe to deploy before the backend exists.
 */

import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

export interface AskExpenseAiInput {
    question: string;
    groupId?: string;
    topK?: number;
}

export interface AskExpenseAiResult {
    answer: string;
    sources: unknown[];
    confidence: number;
}

/** Validate + normalize the callable payload (pure; unit-tested). */
export function validateAskInput(data: unknown): AskExpenseAiInput {
    const d = (data ?? {}) as Record<string, unknown>;
    const question = typeof d.question === "string" ? d.question.trim() : "";
    if (!question) {
        throw new HttpsError("invalid-argument", "question is required");
    }
    if (question.length > 500) {
        throw new HttpsError("invalid-argument", "question is too long (max 500 chars)");
    }
    const groupId = typeof d.groupId === "string" && d.groupId ? d.groupId : undefined;
    const topKRaw = Number(d.topK);
    const topK = Number.isInteger(topKRaw) && topKRaw > 0 && topKRaw <= 25 ? topKRaw : undefined;
    return { question, groupId, topK };
}

/** Read the AI-layer gate + RAG endpoint from env (pure given an env; tested). */
export function readRagConfig(env: NodeJS.ProcessEnv): { url: string; secret: string } | null {
    if (env.AI_LAYER_ENABLED !== "true") return null;
    const url = (env.RAG_SERVICE_URL || "").replace(/\/$/, "");
    const secret = env.RAG_SHARED_SECRET || "";
    if (!url || !secret) return null;
    return { url, secret };
}

export const askExpenseAi = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Sign in to ask about your expenses.");
    }

    const config = readRagConfig(process.env);
    if (!config) {
        throw new HttpsError(
            "failed-precondition",
            "The AI assistant isn't available yet. Please try again later.",
        );
    }

    const input = validateAskInput(request.data);

    let res: Response;
    try {
        res = await fetch(`${config.url}/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-rag-secret": config.secret },
            body: JSON.stringify({
                query: input.question,
                userId: uid, // from the verified token — never from the client payload
                groupId: input.groupId,
                topK: input.topK,
            }),
        });
    } catch (err) {
        logger.error("askExpenseAi: RAG service unreachable", {
            error: err instanceof Error ? err.message : "unknown",
        });
        throw new HttpsError("unavailable", "The AI assistant is temporarily unavailable.");
    }

    if (!res.ok) {
        // Never log question text (PII, Critical Rule #3) — status only.
        logger.error("askExpenseAi: RAG service error", { status: res.status });
        throw new HttpsError("internal", "The AI assistant hit an error. Please try again.");
    }

    const body = (await res.json()) as {
        answer?: string;
        sources?: unknown[];
        confidence?: number;
    };
    const result: AskExpenseAiResult = {
        answer: body.answer ?? "",
        sources: Array.isArray(body.sources) ? body.sources : [],
        confidence: Number(body.confidence) || 0,
    };
    return result;
});
