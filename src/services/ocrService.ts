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
        total?: number;
        date?: string;
        title?: string;
        items?: { name: string; price: number }[];
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
    const result: OCRResult['parsedData'] = {};

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
