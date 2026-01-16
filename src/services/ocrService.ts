/**
 * OCR Service for Receipt Data Extraction
 * 
 * This service uses Google Cloud Vision API to extract text from receipt images
 * and parse relevant data (total, date, items).
 * 
 * Note: Requires a Google Cloud Vision API key configured in environment variables.
 */

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
    /(?:^|\s)\$(\d+\.\d{2})(?:\s|$)/gm, // Standalone dollar amounts
];

const DATE_PATTERNS = [
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/,
    /(\w{3,9}\s+\d{1,2},?\s+\d{4})/i,
    /(\d{4}[\/\-]\d{2}[\/\-]\d{2})/,
];

/**
 * Extract receipt data from an image using Google Cloud Vision API
 * 
 * @param imageUri - Local URI of the image to process
 * @returns OCRResult with extracted and parsed data
 */
export const extractReceiptData = async (imageUri: string): Promise<OCRResult> => {
    try {
        // Get the API key from environment
        const apiKey = process.env.EXPO_PUBLIC_GOOGLE_VISION_API_KEY;

        if (!apiKey) {
            console.warn('Google Vision API key not configured. OCR disabled.');
            return {
                success: false,
                error: 'OCR service not configured. Please add EXPO_PUBLIC_GOOGLE_VISION_API_KEY to your environment.',
            };
        }

        // Convert image to base64
        const response = await fetch(imageUri);
        const blob = await response.blob();
        const base64 = await blobToBase64(blob);

        // Call Google Cloud Vision API
        const visionResponse = await fetch(
            `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    requests: [
                        {
                            image: { content: base64 },
                            features: [{ type: 'TEXT_DETECTION' }],
                        },
                    ],
                }),
            }
        );

        const data = await visionResponse.json();

        if (data.error) {
            return {
                success: false,
                error: data.error.message || 'Vision API error',
            };
        }

        const extractedText = data.responses?.[0]?.fullTextAnnotation?.text || '';

        if (!extractedText) {
            return {
                success: false,
                error: 'No text detected in image',
            };
        }

        // Parse the extracted text
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
                .map(a => parseFloat(a.replace('$', '')))
                .filter(a => !isNaN(a) && a > 0);
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

    // Extract title (use first line or merchant name if found)
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    if (lines.length > 0) {
        // Use first non-empty line as potential title/merchant
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
            const base64data = reader.result as string;
            // Remove the data URL prefix (e.g., "data:image/jpeg;base64,")
            const base64 = base64data.split(',')[1];
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
        'Food': ['restaurant', 'cafe', 'coffee', 'pizza', 'burger', 'sushi', 'taco', 'food', 'dining', 'kitchen'],
        'Transport': ['uber', 'lyft', 'taxi', 'gas', 'fuel', 'parking', 'transit'],
        'Shopping': ['amazon', 'walmart', 'target', 'store', 'shop', 'mall', 'retail'],
        'Entertainment': ['movie', 'cinema', 'theatre', 'concert', 'spotify', 'netflix', 'game'],
        'Utilities': ['electric', 'water', 'gas', 'internet', 'phone', 'bill'],
        'Health': ['pharmacy', 'medical', 'doctor', 'hospital', 'clinic', 'cvs', 'walgreens'],
        'Travel': ['hotel', 'flight', 'airline', 'airbnb', 'booking', 'expedia'],
    };

    for (const [category, keywords] of Object.entries(categoryKeywords)) {
        if (keywords.some(keyword => lowerText.includes(keyword))) {
            return category;
        }
    }

    return 'General';
};
