/**
 * onDeviceReceiptService.ts — structured receipt parsing via Apple's on-device
 * Foundation Models (replaces the Gemini Cloud Function path).
 *
 * Flow: VisionKit OCR `rawText` → on-device Foundation Models `@Generable`
 * parse (biased by the user's learned per-merchant name corrections) →
 * normalized structured data. Fully on-device, no backend, no API bill, and the
 * receipt text never leaves the phone. Eligible hardware only (Apple
 * Intelligence); callers fall back to the native VisionKit parser otherwise.
 */

import { getOnDeviceAiAvailability, parseReceiptStructured } from '../../modules/splitcircle-ai';
import { getReceiptNameHints } from '@/services/receiptLearningService';
import { buildReceiptFewShot, mapOnDeviceReceipt, type OnDeviceReceiptParsed } from '@/utils/receiptParse';

export type { OnDeviceReceiptParsed };

/** True when the on-device model can run (iPhone 15 Pro+ with Apple Intelligence). */
export const isOnDeviceReceiptParsingAvailable = (): boolean =>
  getOnDeviceAiAvailability() === 'available';

/**
 * Parse OCR receipt text into structured data on-device, biased by the user's
 * learned corrections for this merchant. Throws when the model is unavailable.
 */
export const parseReceiptOnDevice = async (
  rawText: string,
  merchantName: string | null | undefined,
): Promise<OnDeviceReceiptParsed> => {
  const hints = await getReceiptNameHints(merchantName);
  const fewShot = buildReceiptFewShot(hints);
  const result = await parseReceiptStructured(rawText, fewShot);
  return mapOnDeviceReceipt(result);
};
