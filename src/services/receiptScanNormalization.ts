const MERCHANT_BLOCKLIST = [
  'receipt',
  'invoice',
  'merchant copy',
  'customer copy',
  'guest copy',
  'thank you',
  'feedback',
  'survey',
  'subtotal',
  'tax',
  'tip',
  'total',
  'balance due',
  'amount due',
  'cash',
  'credit',
  'debit',
  'visa',
  'mastercard',
  'amex',
  'apple pay',
  'google pay',
];

const MERCHANT_GENERIC_ONLY = new Set([
  'market',
  'marketplace',
  'grocery',
  'supermarket',
  'supercenter',
  'mart',
  'shop',
  'store',
  'restaurant',
  'cafe',
  'pharmacy',
]);

const URL_OR_EMAIL_RE = /\b(?:www\.|https?:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\.com\b|\.org\b|\.net\b)/i;
const PHONE_RE = /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/;
const DATE_RE = /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{2}[/-]\d{2})\b/;
const PRICE_RE = /\$?\s*\d{1,6}\.\d{2}/;
const STORE_NUMBER_RE = /\b(?:store|location|branch)\s*#?\s*\d+\b/gi;
const WELCOME_PREFIX_RE = /^(welcome to|thank you for shopping at)\s+/i;

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const toDisplayCase = (value: string): string => {
  const letters = value.replace(/[^A-Za-z]/g, '');
  const uppercaseRatio = letters.length > 0
    ? value.replace(/[^A-Z]/g, '').length / letters.length
    : 0;

  if (uppercaseRatio < 0.85) {
    return value;
  }

  return value
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

const isPlausibleMerchantText = (value: string): boolean => {
  const lower = value.toLowerCase();
  const letters = value.replace(/[^A-Za-z]/g, '').length;
  const digits = value.replace(/[^0-9]/g, '').length;
  const words = lower.split(/\s+/).filter(Boolean);

  if (letters < 3) return false;
  if (digits > Math.max(2, Math.floor(value.length * 0.25))) return false;
  if (words.length === 0 || words.length > 6) return false;
  if (URL_OR_EMAIL_RE.test(value) || PHONE_RE.test(value) || DATE_RE.test(value) || PRICE_RE.test(value)) return false;
  if (MERCHANT_BLOCKLIST.some((token) => lower.includes(token))) return false;
  if (words.every((token) => MERCHANT_GENERIC_ONLY.has(token))) return false;

  return true;
};

export const normalizeScannedMerchantName = (
  merchantName: string | null | undefined,
  confidence?: number | null,
): string | null => {
  if (!merchantName) return null;

  let normalized = merchantName
    .replace(WELCOME_PREFIX_RE, '')
    .replace(STORE_NUMBER_RE, '')
    .replace(/[.*#/$@,;:[\]{}()]+/g, ' ')
    .trim();

  normalized = normalizeWhitespace(normalized);

  if (!normalized) return null;
  if (confidence != null && confidence < 0.32) return null;
  if (!isPlausibleMerchantText(normalized)) return null;

  return toDisplayCase(normalized);
};

export const shouldAutofillExpenseTitleFromMerchant = (
  merchantName: string | null | undefined,
  confidence?: number | null,
): boolean => {
  const normalized = normalizeScannedMerchantName(merchantName, confidence);
  if (!normalized) return false;
  if (confidence == null) return true;
  return confidence >= 0.58;
};
