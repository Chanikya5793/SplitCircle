"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseReceiptWithAI = void 0;
const logger = __importStar(require("firebase-functions/logger"));
const params_1 = require("firebase-functions/params");
const https_1 = require("firebase-functions/v2/https");
const openai_1 = __importDefault(require("openai"));
const openAiApiKeySecret = (0, params_1.defineSecret)("OPENAI_API_KEY");
const getSecretOrEnv = (secret, envName) => {
    var _a, _b;
    try {
        const secretValue = secret.value().trim();
        if (secretValue.length > 0)
            return secretValue;
    }
    catch (_c) {
        // Fall back to env var in local testing
    }
    return (_b = (_a = process.env[envName]) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
};
exports.parseReceiptWithAI = (0, https_1.onCall)({
    secrets: [openAiApiKeySecret],
    timeoutSeconds: 30, // LLMs can be slightly slow
    memory: "256MiB",
}, async (request) => {
    var _a, _b, _c, _d;
    // Require authentication
    if (!((_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid)) {
        throw new https_1.HttpsError("unauthenticated", "You must be signed in to parse receipts.");
    }
    const rawText = (_b = request.data) === null || _b === void 0 ? void 0 : _b.rawText;
    if (typeof rawText !== "string" || !rawText.trim()) {
        throw new https_1.HttpsError("invalid-argument", "Missing or invalid rawText from receipt.");
    }
    const apiKey = getSecretOrEnv(openAiApiKeySecret, "OPENAI_API_KEY");
    if (!apiKey) {
        logger.error("parseReceiptWithAI: OPENAI_API_KEY is not configured.");
        throw new https_1.HttpsError("internal", "AI Service correctly not configured (Missing API Key). Please ask the administrator to set it.");
    }
    const openai = new openai_1.default({ apiKey });
    try {
        logger.info("parseReceiptWithAI: Processing receipt text of length " + rawText.length);
        const prompt = `
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
${rawText}
"""
`;
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "ReceiptExtraction",
                    schema: {
                        type: "object",
                        properties: {
                            items: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        name: { type: "string" },
                                        price: { type: "number" },
                                        quantity: { type: "number" }
                                    },
                                    required: ["name", "price", "quantity"],
                                    additionalProperties: false
                                }
                            },
                            subtotal: { type: ["number", "null"] },
                            tax: { type: ["number", "null"] },
                            tip: { type: ["number", "null"] },
                            total: { type: ["number", "null"] },
                            merchantName: { type: ["string", "null"] },
                            date: { type: ["string", "null"] }
                        },
                        required: ["items", "subtotal", "tax", "tip", "total", "merchantName", "date"],
                        additionalProperties: false
                    },
                    strict: true
                }
            },
            temperature: 0.1,
        });
        const aiResponse = (_d = (_c = completion.choices[0]) === null || _c === void 0 ? void 0 : _c.message) === null || _d === void 0 ? void 0 : _d.content;
        if (!aiResponse) {
            throw new Error("No response from AI model.");
        }
        const parsedData = JSON.parse(aiResponse);
        return parsedData;
    }
    catch (error) {
        logger.error("parseReceiptWithAI: Failed to generate response", error);
        throw new https_1.HttpsError("internal", "Failed to parse receipt with AI.");
    }
});
//# sourceMappingURL=receiptParser.js.map