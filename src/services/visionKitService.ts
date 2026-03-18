/**
 * VisionKit Receipt Scanner Service — v2
 *
 * TypeScript wrapper around the native iOS VisionKit module.
 * Features:
 * - On-device document scanning + OCR
 * - Confidence scores per item
 * - Graceful platform fallback
 */

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

// ── Types ───────────────────────────────────────────────────────────────────

export interface VisionKitScannedItem {
  name: string;
  price: number;
  quantity: number;
  confidence: number; // 0.0 – 1.0
}

export interface VisionKitScanResult {
  cancelled: boolean;
  imageUri?: string;
  rawText?: string;
  items: VisionKitScannedItem[];
  subtotal?: number | null;
  tax?: number | null;
  tip?: number | null;
  total?: number | null;
  merchantName?: string | null;
  date?: string | null;
  parserTelemetry?: string[];
}

export interface ScanProgressEvent {
  status: 'processing' | 'parsing' | 'complete';
  message: string;
  textLinesFound?: number;
  itemCount?: number;
}

// ── Native Module Access ────────────────────────────────────────────────────

const VisionKitNative = Platform.OS === 'ios'
  ? NativeModules.VisionKitReceiptScanner
  : null;

console.log('[VisionKit] Native module available:', !!VisionKitNative, 'Platform:', Platform.OS);

const VisionKitEventEmitter = VisionKitNative
  ? new NativeEventEmitter(VisionKitNative)
  : null;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if VisionKit document scanning is available.
 */
export const isVisionKitAvailable = async (): Promise<boolean> => {
  if (Platform.OS !== 'ios' || !VisionKitNative) {
    console.log('[VisionKit] Not available: platform=', Platform.OS, 'nativeModule=', !!VisionKitNative);
    return false;
  }
  try {
    const supported = await VisionKitNative.isAvailable();
    console.log('[VisionKit] Device supports VisionKit:', supported);
    return supported;
  } catch (error) {
    console.log('[VisionKit] Error checking availability:', error);
    return false;
  }
};

/**
 * Launch native document scanner and perform on-device OCR.
 * Returns parsed receipt data with items, totals, confidence scores, and image URI.
 */
export const scanReceiptWithVisionKit = async (
  onProgress?: (event: ScanProgressEvent) => void,
): Promise<VisionKitScanResult | null> => {
  if (Platform.OS !== 'ios' || !VisionKitNative) return null;

  let subscription: { remove: () => void } | null = null;

  try {
    if (onProgress && VisionKitEventEmitter) {
      subscription = VisionKitEventEmitter.addListener('onScanProgress', onProgress);
    }

    const result = await VisionKitNative.scanDocument();

    console.log('[VisionKit] Raw native result:', JSON.stringify({
      itemCount: result.items?.length,
      total: result.total,
      tax: result.tax,
      subtotal: result.subtotal,
      merchantName: result.merchantName,
      date: result.date,
    }));

    return {
      cancelled: result.cancelled === true,
      imageUri: result.imageUri || undefined,
      rawText: result.rawText || undefined,
      items: Array.isArray(result.items)
        ? result.items.map((item: any) => ({
            name: typeof item.name === 'string' ? item.name : '',
            price: typeof item.price === 'number' ? item.price : 0,
            quantity: typeof item.quantity === 'number' ? item.quantity : 1,
            confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
          }))
        : [],
      subtotal: typeof result.subtotal === 'number' ? result.subtotal : null,
      tax: typeof result.tax === 'number' ? result.tax : null,
      tip: typeof result.tip === 'number' ? result.tip : null,
      total: typeof result.total === 'number' ? result.total : null,
      merchantName: typeof result.merchantName === 'string' ? result.merchantName : null,
      date: typeof result.date === 'string' ? result.date : null,
      parserTelemetry: Array.isArray(result.parserTelemetry)
        ? result.parserTelemetry.filter((line: unknown): line is string => typeof line === 'string')
        : [],
    } as VisionKitScanResult;
  } finally {
    subscription?.remove();
  }
};
