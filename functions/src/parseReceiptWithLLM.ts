/**
 * Server-side Gemini proxy for receipt parsing.
 *
 * The GEMINI_API_KEY is stored in Firebase Functions Secret Manager and
 * is never exposed to client builds.  Clients call this function via an
 * authenticated HTTP POST with their Firebase ID token.
 */

import { getAuth } from "firebase-admin/auth";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";

const geminiApiKeySecret = defineSecret("GEMINI_API_KEY");

interface ParseReceiptRequest {
    rawText?: string;
}

const RECEIPT_PROMPT_PREFIX = `
You are a highly accurate receipt parsing assistant. 
I am going to provide you with the raw Optical Character Recognition (OCR) text of a receipt.
Your task is to extract the line items (name, price, quantity), the subtotal, tax, tip, total, merchant name, and date into a structured format.

Rules:
1. Ignore items that are not actual merchandise or food (e.g. do not treat "Subtotal", "Tax", "Tip", "Total", "Visa XXXX", "Approval Code", "Total Items Sold" as line items).
2. Clean up item names to be concise and readable. Correct obvious OCR errors in spelling if you are extremely confident.
3. If quantity is missing but implied by the item, default to 1.
4. Ensure the prices are numbers (e.g., 5.99).
5. Only return the final calculated structured data.

Raw OCR Text:
"""
`;

const GENERATION_CONFIG = {
    temperature: 0.1,
    responseMimeType: "application/json",
    responseSchema: {
        type: "OBJECT",
        properties: {
            items: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        name: { type: "STRING" },
                        price: { type: "NUMBER" },
                        quantity: { type: "NUMBER" },
                    },
                    required: ["name", "price", "quantity"],
                },
            },
            subtotal: { type: "NUMBER", nullable: true },
            tax: { type: "NUMBER", nullable: true },
            tip: { type: "NUMBER", nullable: true },
            total: { type: "NUMBER", nullable: true },
            merchantName: { type: "STRING", nullable: true },
            date: { type: "STRING", nullable: true },
        },
        required: ["items"],
    },
};

const getBearerToken = (header: string | undefined): string | null => {
    if (!header) return null;
    const [scheme, token] = header.trim().split(" ");
    if (scheme !== "Bearer" || !token) return null;
    return token;
};

export const parseReceiptWithLLM = onRequest(
    {
        cors: true,
        secrets: [geminiApiKeySecret],
        // Limit payload size to prevent abuse (receipts shouldn't be huge)
        maxInstances: 20,
    },
    async (req, res) => {
        res.set("Cache-Control", "no-store");

        if (req.method === "OPTIONS") {
            res.status(204).send("");
            return;
        }

        if (req.method !== "POST") {
            res.status(405).json({ error: "Method not allowed. Use POST." });
            return;
        }

        // ── Authentication ──────────────────────────────────────
        const bearerToken = getBearerToken(req.get("Authorization") ?? undefined);
        if (!bearerToken) {
            res.status(401).json({ error: "Missing or invalid Authorization header." });
            return;
        }

        let uid: string;
        try {
            const decoded = await getAuth().verifyIdToken(bearerToken);
            uid = decoded.uid;
        } catch {
            res.status(401).json({ error: "Invalid Firebase ID token." });
            return;
        }

        // ── Input validation ────────────────────────────────────
        const body = (typeof req.body === "object" && req.body !== null)
            ? req.body as ParseReceiptRequest
            : {};

        const rawText = typeof body.rawText === "string" ? body.rawText.trim() : "";

        if (!rawText) {
            res.status(400).json({ error: "Missing required field: rawText" });
            return;
        }

        // Limit input size to prevent abuse (100KB should be plenty for OCR text)
        if (rawText.length > 100_000) {
            res.status(400).json({ error: "rawText exceeds maximum allowed length." });
            return;
        }

        // ── Call Gemini ─────────────────────────────────────────
        const apiKey = geminiApiKeySecret.value()?.trim();
        if (!apiKey) {
            logger.error("GEMINI_API_KEY secret is not configured.");
            res.status(500).json({ error: "Server misconfiguration." });
            return;
        }

        const prompt = `${RECEIPT_PROMPT_PREFIX}${rawText}\n"""`;

        try {
            const geminiResponse = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: GENERATION_CONFIG,
                    }),
                },
            );

            if (!geminiResponse.ok) {
                const errText = await geminiResponse.text();
                logger.error("Gemini API error", {
                    status: geminiResponse.status,
                    body: errText.slice(0, 500),
                    uid,
                });
                res.status(502).json({ error: "Upstream AI service error." });
                return;
            }

            const data = await geminiResponse.json() as {
                candidates?: Array<{
                    content?: { parts?: Array<{ text?: string }> };
                }>;
            };

            const jsonString = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!jsonString) {
                res.status(502).json({ error: "No parsed data returned from AI service." });
                return;
            }

            // Validate that it's actually valid JSON before forwarding
            const parsed = JSON.parse(jsonString);

            logger.info("Receipt parsed successfully", { uid, itemCount: parsed.items?.length ?? 0 });

            res.status(200).json({
                success: true,
                parsedData: parsed,
            });
        } catch (error) {
            logger.error("parseReceiptWithLLM error", {
                uid,
                message: error instanceof Error ? error.message : "Unknown error",
            });
            res.status(500).json({ error: "Internal server error." });
        }
    },
);
