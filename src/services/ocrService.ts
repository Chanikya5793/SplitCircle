/**
 * OCR Service for Receipt Data Extraction
 *
 * This service calls a trusted backend OCR endpoint and never embeds
 * provider secrets in the mobile client bundle.
 */

import { getAuth } from 'firebase/auth';


export interface OCRResult {
    success: boolean;
    extractedText?: string;
    parsedData?: {
        total?: number | null;
        subtotal?: number | null;
        tax?: number | null;
        tip?: number | null;
        date?: string | null;
        title?: string | null;
        merchantName?: string | null;
        items?: { name: string; price: number; quantity?: number }[];
    };
    error?: string;
}

// Regex patterns for common receipt formats
const TOTAL_PATTERNS = [
    /(?:total|grand total|amount due|balance due|subtotal)[\s:]*\$?(\d+\.?\d*)/i,
    /\$(\d+\.\d{2})\s*(?:total|due|paid)/i,
    /(?:^|\s)\$(\d+\.\d{2})(?:\s|$)/gm,
];

const DATE_PATTERNS = [
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/,
    /(\w{3,9}\s+\d{1,2},?\s+\d{4})/i,
    /(\d{4}[\/\-]\d{2}[\/\-]\d{2})/,
];

const OCR_PROXY_ENDPOINT = process.env.EXPO_PUBLIC_OCR_PROXY_ENDPOINT?.trim() ?? '';

const isLocalDevelopmentHost = (hostname: string): boolean => {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
};

const getValidatedOcrEndpoint = (): URL | null => {
    if (!OCR_PROXY_ENDPOINT) {
        return null;
    }

    let endpoint: URL;
    try {
        endpoint = new URL(OCR_PROXY_ENDPOINT);
    } catch {
        throw new Error('OCR endpoint URL is invalid.');
    }

    const isSecure = endpoint.protocol === 'https:';
    const allowLocalDev = __DEV__ && endpoint.protocol === 'http:' && isLocalDevelopmentHost(endpoint.hostname);
    if (!isSecure && !allowLocalDev) {
        throw new Error('OCR endpoint must use HTTPS in non-development environments.');
    }

    return endpoint;
};

const extractTextFromOcrPayload = (payload: unknown): string => {
    if (!payload || typeof payload !== 'object') {
        return '';
    }

    const data = payload as Record<string, unknown>;

    if (typeof data.extractedText === 'string') {
        return data.extractedText;
    }

    if (typeof data.text === 'string') {
        return data.text;
    }

    const responses = data.responses;
    if (Array.isArray(responses)) {
        const first = responses[0] as { fullTextAnnotation?: { text?: unknown } } | undefined;
        if (typeof first?.fullTextAnnotation?.text === 'string') {
            return first.fullTextAnnotation.text;
        }
    }

    return '';
};

/**
 * Extract receipt data from an image using a trusted backend OCR endpoint.
 *
 * @param imageUri - Local URI of the image to process
 * @returns OCRResult with extracted and parsed data
 */
export const extractReceiptData = async (imageUri: string): Promise<OCRResult> => {
    try {
        const endpoint = getValidatedOcrEndpoint();
        if (!endpoint) {
            return {
                success: false,
                error: 'OCR service is not configured for this build.',
            };
        }

        const currentUser = getAuth().currentUser;
        if (!currentUser) {
            return {
                success: false,
                error: 'You must be signed in to use receipt scanning.',
            };
        }

        const idToken = await currentUser.getIdToken();

        // Convert image to base64 for backend OCR processing.
        const response = await fetch(imageUri);
        const blob = await response.blob();
        const base64 = await blobToBase64(blob);

        const ocrResponse = await fetch(endpoint.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${idToken}`,
            },
            body: JSON.stringify({
                imageBase64: base64,
                mimeType: blob.type || 'application/octet-stream',
            }),
        });

        const payload = await ocrResponse.json().catch(() => null);
        if (!ocrResponse.ok) {
            const backendError =
                typeof (payload as { error?: unknown } | null)?.error === 'string'
                    ? String((payload as { error: string }).error)
                    : 'OCR request failed.';

            return {
                success: false,
                error: backendError,
            };
        }

        const extractedText = extractTextFromOcrPayload(payload);
        if (!extractedText) {
            return {
                success: false,
                error: 'No text detected in image',
            };
        }

        const parsedData = parseReceiptText(extractedText);
        return {
            success: true,
            extractedText,
            parsedData,
        };
    } catch (error) {
        console.error('OCR Error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error during OCR',
        };
    }
};

/**
 * Parse receipt text to extract structured data
 */
const parseReceiptText = (text: string): OCRResult['parsedData'] => {
    const result: OCRResult['parsedData'] = { items: [] };

    // Extract total amount
    for (const pattern of TOTAL_PATTERNS) {
        const match = text.match(pattern);
        if (match && match[1]) {
            const amount = parseFloat(match[1]);
            if (!isNaN(amount) && amount > 0) {
                result.total = amount;
                break;
            }
        }
    }

    // If no total found via patterns, try to find the largest dollar amount
    if (!result.total) {
        const allAmounts = text.match(/\$(\d+\.\d{2})/g);
        if (allAmounts && allAmounts.length > 0) {
            const amounts = allAmounts
                .map((value) => parseFloat(value.replace('$', '')))
                .filter((value) => !isNaN(value) && value > 0);
            if (amounts.length > 0) {
                result.total = Math.max(...amounts);
            }
        }
    }

    // Extract date
    for (const pattern of DATE_PATTERNS) {
        const match = text.match(pattern);
        if (match && match[1]) {
            result.date = match[1];
            break;
        }
    }

    // Extract title (use first non-empty line as merchant hint)
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length > 0) {
        result.title = lines[0].trim().slice(0, 50);
    }

    // Extract line items — lines with a price pattern that aren't summary lines
    const summaryKeywords = [
        'subtotal', 'sub total', 'total', 'tax', 'tip', 'gratuity',
        'change', 'cash', 'credit', 'debit', 'visa', 'mastercard',
        'balance', 'amount due', 'amount paid', 'tendered', 'thank',
        'receipt', 'invoice', 'card ending', 'approval', 'auth',
    ];
    const priceRegex = /\$?\s*(\d+\.\d{2})/;

    for (const line of lines) {
        const trimmed = line.trim();
        const lower = trimmed.toLowerCase();

        // Skip empty or summary lines
        if (trimmed.length < 3) continue;
        if (summaryKeywords.some((kw) => lower.includes(kw))) continue;

        const priceMatch = trimmed.match(priceRegex);
        if (priceMatch && priceMatch[1]) {
            const price = parseFloat(priceMatch[1]);
            if (isNaN(price) || price <= 0) continue;

            // Extract item name by removing the price portion
            let itemName = trimmed
                .replace(/\$?\s*\d+\.\d{2}/, '')
                .replace(/^[\s.\-:]+|[\s.\-:]+$/g, '')
                .trim();

            if (itemName.length >= 2) {
                result.items!.push({ name: itemName, price });
            }
        }
    }

    return result;
};

/**
 * Convert Blob to base64 string
 */
const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64Data = reader.result as string;
            const base64 = base64Data.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
};

/**
 * Infer category from receipt text
 */
export const inferCategoryFromText = (text: string): string => {
    const lowerText = text.toLowerCase();

    const categoryKeywords: Record<string, string[]> = {
        Food: ['restaurant', 'cafe', 'coffee', 'pizza', 'burger', 'sushi', 'taco', 'food', 'dining', 'kitchen'],
        Transport: ['uber', 'lyft', 'taxi', 'gas', 'fuel', 'parking', 'transit'],
        Shopping: ['amazon', 'walmart', 'target', 'store', 'shop', 'mall', 'retail'],
        Entertainment: ['movie', 'cinema', 'theatre', 'concert', 'spotify', 'netflix', 'game'],
        Utilities: ['electric', 'water', 'gas', 'internet', 'phone', 'bill'],
        Health: ['pharmacy', 'medical', 'doctor', 'hospital', 'clinic', 'cvs', 'walgreens'],
        Travel: ['hotel', 'flight', 'airline', 'airbnb', 'booking', 'expedia'],
    };

    for (const [category, keywords] of Object.entries(categoryKeywords)) {
        if (keywords.some((keyword) => lowerText.includes(keyword))) {
            return category;
        }
    }

    return 'General';
};

/**
 * Call the ultra-fast Gemini 2.5 Flash model directly from the client to structure the receipt.
 */
export const parseStructuredReceiptWithAI = async (rawText: string): Promise<OCRResult> => {
    try {
        const apiKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error("EXPO_PUBLIC_GEMINI_API_KEY is not set in .env");
        }

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

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
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
                                        quantity: { type: "NUMBER" }
                                    },
                                    required: ["name", "price", "quantity"]
                                }
                            },
                            subtotal: { type: "NUMBER", nullable: true },
                            tax: { type: "NUMBER", nullable: true },
                            tip: { type: "NUMBER", nullable: true },
                            total: { type: "NUMBER", nullable: true },
                            merchantName: { type: "STRING", nullable: true },
                            date: { type: "STRING", nullable: true }
                        },
                        required: ["items"]
                    }
                }
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Gemini API Error: ${response.status} ${err}`);
        }

        const data = await response.json();
        const jsonString = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!jsonString) {
            throw new Error("No parsed data returned from Gemini");
        }

        const parsedData = JSON.parse(jsonString);

        return {
            success: true,
            extractedText: rawText,
            parsedData,
        };
    } catch (error) {
        console.error('AI Parsing Error:', error);
        return {
            success: false,
            extractedText: rawText, // return text so we can fallback natively if needed
            error: error instanceof Error ? error.message : 'Unknown error during AI breakdown',
        };
    }
};
