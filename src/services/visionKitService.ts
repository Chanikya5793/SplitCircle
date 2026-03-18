/**
 * VisionKit Receipt Scanner Service
 *
 * TypeScript wrapper around the native iOS VisionKit module.
 * Provides on-device document scanning + OCR for receipt data extraction.
 * Falls back gracefully on non-iOS platforms.
 */

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

// ── Types ───────────────────────────────────────────────────────────────────

export interface VisionKitScannedItem {
  name: string;
  price: number;
  quantity: number;
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
 * Check if VisionKit document scanning is available on the current device.
 * Returns false on Android and older iOS devices.
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
 * Launch the native iOS document scanner and perform on-device OCR.
 *
 * @param onProgress - Optional callback for scan progress updates
 * @returns Parsed receipt data with items, totals, and scanned image URI.
 *          Returns null if VisionKit is not available (Android, old iOS).
 */
export const scanReceiptWithVisionKit = async (
  onProgress?: (event: ScanProgressEvent) => void,
): Promise<VisionKitScanResult | null> => {
  if (Platform.OS !== 'ios' || !VisionKitNative) {
    return null;
  }

  let subscription: { remove: () => void } | null = null;

  try {
    // Subscribe to progress events
    if (onProgress && VisionKitEventEmitter) {
      subscription = VisionKitEventEmitter.addListener(
        'onScanProgress',
        onProgress,
      );
    }

    const result = await VisionKitNative.scanDocument();

    // Normalize nulls from native side
    return {
      cancelled: result.cancelled === true,
      imageUri: result.imageUri || undefined,
      rawText: result.rawText || undefined,
      items: Array.isArray(result.items)
        ? result.items.map((item: any) => ({
            name: typeof item.name === 'string' ? item.name : '',
            price: typeof item.price === 'number' ? item.price : 0,
            quantity: typeof item.quantity === 'number' ? item.quantity : 1,
          }))
        : [],
      subtotal: typeof result.subtotal === 'number' ? result.subtotal : null,
      tax: typeof result.tax === 'number' ? result.tax : null,
      tip: typeof result.tip === 'number' ? result.tip : null,
      total: typeof result.total === 'number' ? result.total : null,
      merchantName: typeof result.merchantName === 'string' ? result.merchantName : null,
      date: typeof result.date === 'string' ? result.date : null,
    } as VisionKitScanResult;
  } finally {
    subscription?.remove();
  }
};
