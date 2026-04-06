"use strict";
/**
 * Server-side Gemini proxy for receipt parsing.
 *
 * The GEMINI_API_KEY is stored in Firebase Functions Secret Manager and
 * is never exposed to client builds.  Clients call this function via an
 * authenticated HTTP POST with their Firebase ID token.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseReceiptWithLLM = void 0;
const auth_1 = require("firebase-admin/auth");
const logger = __importStar(require("firebase-functions/logger"));
const params_1 = require("firebase-functions/params");
const https_1 = require("firebase-functions/v2/https");
const geminiApiKeySecret = (0, params_1.defineSecret)("GEMINI_API_KEY");
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
const getBearerToken = (header) => {
    if (!header)
        return null;
    const [scheme, token] = header.trim().split(" ");
    if (scheme !== "Bearer" || !token)
        return null;
    return token;
};
exports.parseReceiptWithLLM = (0, https_1.onRequest)({
    cors: true,
    secrets: [geminiApiKeySecret],
    // Limit payload size to prevent abuse (receipts shouldn't be huge)
    maxInstances: 20,
}, async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
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
    const bearerToken = getBearerToken((_a = req.get("Authorization")) !== null && _a !== void 0 ? _a : undefined);
    if (!bearerToken) {
        res.status(401).json({ error: "Missing or invalid Authorization header." });
        return;
    }
    let uid;
    try {
        const decoded = await (0, auth_1.getAuth)().verifyIdToken(bearerToken);
        uid = decoded.uid;
    }
    catch (_k) {
        res.status(401).json({ error: "Invalid Firebase ID token." });
        return;
    }
    // ── Input validation ────────────────────────────────────
    const body = (typeof req.body === "object" && req.body !== null)
        ? req.body
        : {};
    const rawText = typeof body.rawText === "string" ? body.rawText.trim() : "";
    if (!rawText) {
        res.status(400).json({ error: "Missing required field: rawText" });
        return;
    }
    // Limit input size to prevent abuse (100KB should be plenty for OCR text)
    if (rawText.length > 100000) {
        res.status(400).json({ error: "rawText exceeds maximum allowed length." });
        return;
    }
    // ── Call Gemini ─────────────────────────────────────────
    const apiKey = (_b = geminiApiKeySecret.value()) === null || _b === void 0 ? void 0 : _b.trim();
    if (!apiKey) {
        logger.error("GEMINI_API_KEY secret is not configured.");
        res.status(500).json({ error: "Server misconfiguration." });
        return;
    }
    const prompt = `${RECEIPT_PROMPT_PREFIX}${rawText}\n"""`;
    try {
        const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: GENERATION_CONFIG,
            }),
        });
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
        const data = await geminiResponse.json();
        const jsonString = (_g = (_f = (_e = (_d = (_c = data.candidates) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.content) === null || _e === void 0 ? void 0 : _e.parts) === null || _f === void 0 ? void 0 : _f[0]) === null || _g === void 0 ? void 0 : _g.text;
        if (!jsonString) {
            res.status(502).json({ error: "No parsed data returned from AI service." });
            return;
        }
        // Validate that it's actually valid JSON before forwarding
        const parsed = JSON.parse(jsonString);
        logger.info("Receipt parsed successfully", { uid, itemCount: (_j = (_h = parsed.items) === null || _h === void 0 ? void 0 : _h.length) !== null && _j !== void 0 ? _j : 0 });
        res.status(200).json({
            success: true,
            parsedData: parsed,
        });
    }
    catch (error) {
        logger.error("parseReceiptWithLLM error", {
            uid,
            message: error instanceof Error ? error.message : "Unknown error",
        });
        res.status(500).json({ error: "Internal server error." });
    }
});
//# sourceMappingURL=parseReceiptWithLLM.js.map