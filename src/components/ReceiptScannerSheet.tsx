/**
 * ReceiptScannerSheet — Full receipt scanning experience
 *
 * Modal component that handles:
 * 1. Triggering VisionKit scanner (iOS) or camera capture (Android)
 * 2. Displaying scan progress with animated feedback
 * 3. Showing extracted items in an editable list
 * 4. Editing tax, tip, and total with mismatch validation
 * 5. Confirming and returning structured receipt data
 */

import { FloatingLabelInput } from '@/components/FloatingLabelInput';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ScanningAnimation } from '@/components/ScanningAnimation';
import { useTheme } from '@/context/ThemeContext';
import { extractReceiptData, inferCategoryFromText } from '@/services/ocrService';
import {
    applyReceiptLearning,
    getStrictReviewMode,
    recordReceiptLearningFeedback,
    type LearningScannedItem,
} from '@/services/receiptLearningService';
import { normalizeScannedMerchantName } from '@/services/receiptScanNormalization';
import {
    isVisionKitAvailable,
    parseReceiptImageWithVisionKit,
    scanReceiptWithVisionKit,
    type ScanProgressEvent,
    type VisionKitScannedItem,
} from '@/services/visionKitService';
import { mediumHaptic, successHaptic } from '@/utils/haptics';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Keyboard,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    TouchableOpacity,
    View,
} from 'react-native';
import { KeyboardAwareScrollView, KeyboardProvider } from 'react-native-keyboard-controller';
import {
    Button,
    Divider,
    Icon,
    IconButton,
    Text,
    TextInput,
} from 'react-native-paper';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ReceiptScannerResult {
  /** Scanned receipt image URI */
  imageUri: string | null;
  /** Extracted line items */
  items: { id: string; name: string; price: number; quantity: number }[];
  /** Tax amount */
  tax: number;
  /** Tip amount */
  tip: number;
  /** Total amount from receipt */
  total: number;
  /** Merchant/store name */
  merchantName: string | null;
  /** Confidence that the detected merchant is usable as a title */
  merchantConfidence: number | null;
  /** Detected date */
  date: string | null;
  /** Category inferred from text */
  inferredCategory: string | null;
  /** Raw OCR text */
  rawText: string | null;
}

interface ReceiptScannerSheetProps {
  onComplete: (result: ReceiptScannerResult) => void;
  onCancel: () => void;
}

type ScanPhase = 'idle' | 'scanning' | 'processing' | 'parsing' | 'complete' | 'review';

type EditableReceiptItem = {
  id: string;
  name: string;
  price: string;
  quantity: number;
  confidence: number;
  reviewed: boolean;
  source: 'scan' | 'learned' | 'manual';
  originalName: string;
};

const LOW_CONFIDENCE_THRESHOLD = 0.75;
const DEBUG_TAP_THRESHOLD = 7;
const HIGH_CONFIDENCE_THRESHOLD = 0.9;
const AUTO_TITLE_MERCHANT_CONFIDENCE = 0.72;

const SUMMARY_EXCLUSION_TOKENS = [
  'subtotal',
  'sub total',
  'total',
  'tax',
  'tip',
  'gratuity',
  'cash',
  'credit',
  'debit',
  'visa',
  'amex',
  'mastercard',
  'change due',
  'account',
  'approval',
  'auth',
  'transaction',
  'terminal',
  'survey',
  'feedback',
  'receipt',
  'items sold',
  'item count',
  'op#',
  'te#',
  'tr#',
  'ref #',
];

const normalizeScanLine = (line: string): string => line.replace(/\s+/g, ' ').trim();

const parseLineAmounts = (line: string): number[] => {
  const matches = line.match(/\d{1,6}\.\d{2}/g);
  if (!matches) return [];
  return matches
    .map((value) => parseFloat(value))
    .filter((value) => Number.isFinite(value) && value > 0 && value < 50000);
};

const parseExpectedItemCountHint = (rawText: string | null | undefined): number | null => {
  if (!rawText) return null;
  const match = rawText.match(/(?:#?\s*items?\s*sold|item\s*count)\s*[:#-]?\s*(\d+)/i);
  if (!match?.[1]) return null;
  const parsed = parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 500 ? parsed : null;
};

const sanitizeTaxValue = (taxValue: number | null, subtotalValue: number | null, totalValue: number | null): number | null => {
  if (taxValue == null || !Number.isFinite(taxValue) || taxValue <= 0) return null;
  if (subtotalValue != null && taxValue >= subtotalValue * 0.5) return null;
  if (totalValue != null && taxValue >= totalValue * 0.5) return null;
  return taxValue;
};

const extractSummaryFromRawText = (rawText: string | null | undefined): {
  subtotal: number | null;
  tax: number | null;
  total: number | null;
} => {
  if (!rawText) {
    return { subtotal: null, tax: null, total: null };
  }

  const lines = rawText.split('\n').map(normalizeScanLine).filter(Boolean);
  let subtotal: number | null = null;
  let tax: number | null = null;
  let total: number | null = null;

  for (const line of lines) {
    const lower = line.toLowerCase();
    const amounts = parseLineAmounts(line);
    if (!amounts.length) continue;

    if (lower.includes('subtotal') || lower.includes('sub total') || lower.includes('sub-total')) {
      subtotal = amounts[amounts.length - 1];
      continue;
    }

    const isTaxLine = /(^|\s)tax\d*([\s:.-]|$)|sales tax|state tax|local tax|vat|gst|hst/i.test(lower);
    if (isTaxLine) {
      // Tax lines sometimes include a percentage (e.g., 6.1000 %) and amount (e.g., 0.38).
      tax = lower.includes('%') && amounts.length > 1 ? Math.min(...amounts) : amounts[amounts.length - 1];
      continue;
    }

    const isTotalLine = lower.includes('total')
      && !lower.includes('subtotal')
      && !lower.includes('sub total')
      && !lower.includes('total purchase')
      && !lower.includes('items sold');
    if (isTotalLine) {
      total = amounts[amounts.length - 1];
      continue;
    }
  }

  return {
    subtotal,
    tax: sanitizeTaxValue(tax, subtotal, total),
    total,
  };
};

const extractItemsFromRawText = (rawText: string | null | undefined): Array<{ name: string; price: number }> => {
  if (!rawText) return [];

  const lines = rawText.split('\n').map(normalizeScanLine).filter(Boolean);
  const recovered: Array<{ name: string; price: number }> = [];
  let pendingName = '';

  for (const line of lines) {
    const lower = line.toLowerCase();
    const hasSummaryToken = SUMMARY_EXCLUSION_TOKENS.some((token) => lower.includes(token));
    const amounts = parseLineAmounts(line);
    const hasPrice = amounts.length > 0;

    if (!hasPrice) {
      if (!hasSummaryToken && /[a-z]{2,}/i.test(line) && line.length >= 3) {
        pendingName = line;
      }
      continue;
    }

    if (hasSummaryToken) {
      pendingName = '';
      continue;
    }

    const price = amounts[amounts.length - 1];
    if (!Number.isFinite(price) || price <= 0) {
      pendingName = '';
      continue;
    }

    const withoutPrices = line
      .replace(/\d{1,6}\.\d{2}/g, ' ')
      .replace(/\b\d{8,}\b/g, ' ')
      .replace(/\b(?:qty|x)\s*\d+\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    let name = withoutPrices;
    if (!/[a-z]{2,}/i.test(name) && /[a-z]{2,}/i.test(pendingName)) {
      name = pendingName;
    }

    name = name
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '')
      .trim();

    if (name.length < 2 || !/[a-z]{2,}/i.test(name)) {
      pendingName = '';
      continue;
    }

    recovered.push({ name, price });
    pendingName = '';
  }

  // De-duplicate by normalized name + price.
  const dedup = new Map<string, { name: string; price: number }>();
  for (const item of recovered) {
    const key = `${item.name.toLowerCase().replace(/\s+/g, ' ').trim()}|${item.price.toFixed(2)}`;
    if (!dedup.has(key)) {
      dedup.set(key, item);
    }
  }

  return Array.from(dedup.values());
};

// ── Component ───────────────────────────────────────────────────────────────

export const ReceiptScannerSheet = ({
  onComplete,
  onCancel,
}: ReceiptScannerSheetProps) => {
  const { theme, isDark } = useTheme();

  // Scan state
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [scanMessage, setScanMessage] = useState('Ready to scan');
  const [scanItemCount, setScanItemCount] = useState(0);

  // Result state
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [items, setItems] = useState<EditableReceiptItem[]>([]);
  const [tax, setTax] = useState('');
  const [tip, setTip] = useState('');
  const [total, setTotal] = useState('');
  const [merchantName, setMerchantName] = useState<string | null>(null);
  const [merchantConfidence, setMerchantConfidence] = useState<number | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  const [parserTelemetry, setParserTelemetry] = useState<string[]>([]);
  const [showDebugTelemetry, setShowDebugTelemetry] = useState(false);
  const [headerTapCount, setHeaderTapCount] = useState(0);
  const [scannedBaselineItems, setScannedBaselineItems] = useState<LearningScannedItem[]>([]);
  const [strictReviewMode, setStrictReviewModeState] = useState(false);

  // Computed values
  const itemsSubtotal = useMemo(
    () => items.reduce((sum, item) => sum + (parseFloat(item.price) || 0) * item.quantity, 0),
    [items],
  );

  const calculatedTotal = useMemo(
    () => itemsSubtotal + (parseFloat(tax) || 0) + (parseFloat(tip) || 0),
    [itemsSubtotal, tax, tip],
  );

  const scannedTotal = parseFloat(total) || 0;
  const hasTotalMismatch = scannedTotal > 0 && Math.abs(calculatedTotal - scannedTotal) > 0.02;

  const lowConfidenceCount = useMemo(
    () => items.filter((item) => !item.reviewed).length,
    [items],
  );

  const orderedItems = useMemo(
    () => [...items].sort((a, b) => Number(a.reviewed) - Number(b.reviewed) || a.confidence - b.confidence),
    [items],
  );

  const confidenceStats = useMemo(() => {
    const low = items.filter((item) => item.confidence < LOW_CONFIDENCE_THRESHOLD).length;
    const medium = items.filter((item) => item.confidence >= LOW_CONFIDENCE_THRESHOLD && item.confidence < HIGH_CONFIDENCE_THRESHOLD).length;
    const high = items.filter((item) => item.confidence >= HIGH_CONFIDENCE_THRESHOLD).length;
    const avg = items.length > 0 ? items.reduce((sum, item) => sum + item.confidence, 0) / items.length : 0;
    return {
      low,
      medium,
      high,
      avg,
      total: items.length,
    };
  }, [items]);

  const parserHealthScore = useMemo(() => {
    if (confidenceStats.total === 0) return 0;
    let score = confidenceStats.avg * 100;
    score -= confidenceStats.low * 6;
    if (hasTotalMismatch) score -= 8;
    score -= lowConfidenceCount * 2;
    return Math.max(0, Math.min(100, Math.round(score)));
  }, [confidenceStats, hasTotalMismatch, lowConfidenceCount]);

  useEffect(() => {
    let isMounted = true;
    const loadStrictMode = async () => {
      const enabled = await getStrictReviewMode();
      if (isMounted) {
        setStrictReviewModeState(enabled);
      }
    };
    void loadStrictMode();
    return () => {
      isMounted = false;
    };
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const generateId = () => `item_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const handleProgressEvent = useCallback((event: ScanProgressEvent) => {
    setScanMessage(event.message);
    if (event.status === 'parsing') {
      setPhase('parsing');
    }
    if (event.itemCount !== undefined) {
      setScanItemCount(event.itemCount);
    }
  }, []);

  const populateFromVisionKit = useCallback(async (result: NonNullable<Awaited<ReturnType<typeof scanReceiptWithVisionKit>>>) => {
    const normalizedMerchant = normalizeScannedMerchantName(result.merchantName, result.merchantConfidence);
    setImageUri(result.imageUri || null);
    setMerchantName(normalizedMerchant);
    setMerchantConfidence(normalizedMerchant && typeof result.merchantConfidence === 'number' ? result.merchantConfidence : null);
    setDate(result.date || null);
    setRawText(result.rawText || null);
    setParserTelemetry(result.parserTelemetry ?? []);

    const expectedItemCount = parseExpectedItemCountHint(result.rawText);
    const rawRecoveredItems = extractItemsFromRawText(result.rawText);
    const rawSummary = extractSummaryFromRawText(result.rawText);

    const taxLooksHallucinated = (
      result.tax != null
      && result.tax > 0
      && ((result.subtotal != null && result.tax >= result.subtotal * 0.5)
        || (result.total != null && result.tax >= result.total * 0.5)
        || (result.subtotal != null && Math.abs(result.tax - result.subtotal) <= 0.01))
    );

    const shouldRecoverItemsFromRaw = (
      rawRecoveredItems.length > 0
      && (
        (expectedItemCount != null && (result.items?.length ?? 0) < expectedItemCount && rawRecoveredItems.length >= expectedItemCount)
        || rawRecoveredItems.length > (result.items?.length ?? 0)
      )
    );

    const normalizedVisionItems = (result.items ?? []).map((item: VisionKitScannedItem) => ({
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      confidence: item.confidence ?? 0.7,
    }));

    const effectiveItems = shouldRecoverItemsFromRaw
      ? rawRecoveredItems.map((item) => ({
          name: item.name,
          price: item.price,
          quantity: 1,
          confidence: 0.64,
        }))
      : normalizedVisionItems;

    const scannedItems = effectiveItems.map((item) => ({
      name: item.name,
      price: item.price,
      confidence: item.confidence,
    }));
    setScannedBaselineItems(scannedItems);

    if (effectiveItems.length > 0) {
      const learnedItems = await applyReceiptLearning(
        normalizedMerchant,
        effectiveItems.map((item) => ({
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          confidence: item.confidence,
        })),
      );

      setItems(
        learnedItems.map((item) => ({
          id: generateId(),
          name: item.name,
          price: item.price.toFixed(2),
          quantity: item.quantity,
          confidence: item.confidence ?? 0.7,
          reviewed: (item.confidence ?? 0.7) >= LOW_CONFIDENCE_THRESHOLD,
          source: item.source,
          originalName: item.originalName,
        })),
      );
    }

    const effectiveSubtotal = rawSummary.subtotal ?? result.subtotal ?? null;
    const effectiveTotal = rawSummary.total ?? result.total ?? null;
    const effectiveTax = taxLooksHallucinated
      ? (rawSummary.tax ?? sanitizeTaxValue(result.tax ?? null, effectiveSubtotal, effectiveTotal))
      : (sanitizeTaxValue(result.tax ?? null, effectiveSubtotal, effectiveTotal) ?? rawSummary.tax);

    if (effectiveTax != null && effectiveTax > 0) {
      setTax(effectiveTax.toFixed(2));
    } else {
      setTax('');
    }

    if (result.tip != null && result.tip > 0) setTip(result.tip.toFixed(2));

    if (effectiveTotal != null && effectiveTotal > 0) {
      setTotal(effectiveTotal.toFixed(2));
    }
  }, []);

  const handleStartScan = async () => {
    mediumHaptic();

    const hasVisionKit = await isVisionKitAvailable();

    if (hasVisionKit) {
      // iOS VisionKit path
      setPhase('scanning');
      setScanMessage('Opening scanner...');

      try {
        const result = await scanReceiptWithVisionKit(handleProgressEvent);

        if (!result || result.cancelled) {
          setPhase('idle');
          setScanMessage('Ready to scan');
          return;
        }

        console.log('[ReceiptScanner] VisionKit result:', JSON.stringify({
          itemCount: result.items?.length,
          total: result.total,
          tax: result.tax,
          merchantName: result.merchantName,
          hasImage: !!result.imageUri,
          rawTextLength: result.rawText?.length,
        }));

        setPhase('complete');
        setScanMessage(`Found ${result.items.length} items!`);
        setScanItemCount(result.items.length);
        successHaptic();

        await populateFromVisionKit(result);

        // Brief delay to show completion, then transition to review
        setTimeout(() => {
          setPhase('review');
        }, 1200);
      } catch (error: any) {
        setPhase('idle');
        setScanMessage('Ready to scan');
        Alert.alert('Scan Error', error.message || 'Failed to scan receipt');
      }
    } else {
      // Android / fallback — use camera + backend OCR
      await handleFallbackScan();
    }
  };

  const handleFallbackScan = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission required', 'Camera permission is needed to scan receipts.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: false,
      quality: 0.85,
    });

    if (result.canceled) return;

    const uri = result.assets[0].uri;
    setImageUri(uri);
    setPhase('processing');
    setScanMessage('Processing receipt...');
    setParserTelemetry([]);

    if (Platform.OS === 'ios') {
      try {
        const nativeResult = await parseReceiptImageWithVisionKit(uri, handleProgressEvent);

        if (nativeResult && !nativeResult.cancelled) {
          setPhase('complete');
          setScanMessage(`Found ${nativeResult.items.length} items!`);
          setScanItemCount(nativeResult.items.length);
          successHaptic();

          await populateFromVisionKit(nativeResult);

          setTimeout(() => {
            setPhase('review');
          }, 1200);
          return;
        }
      } catch (error) {
        console.warn('[ReceiptScanner] Native image parse failed, falling back to OCR service:', error);
      }
    }

    // Check if backend OCR is configured before attempting
    const ocrEndpoint = process.env.EXPO_PUBLIC_OCR_PROXY_ENDPOINT;
    if (!ocrEndpoint) {
      // No OCR service available — go straight to manual review with photo attached
      setPhase('review');
      return;
    }

    try {
      const ocrResult = await extractReceiptData(uri);

      if (ocrResult.success && ocrResult.parsedData) {
        mediumHaptic();

        if (ocrResult.parsedData.items && ocrResult.parsedData.items.length > 0) {
          setScannedBaselineItems(
            ocrResult.parsedData.items.map((item) => ({
              name: item.name,
              price: item.price,
              confidence: 0.5,
            })),
          );
          setItems(
            ocrResult.parsedData.items.map((item) => ({
              id: generateId(),
              name: item.name,
              price: item.price.toFixed(2),
              quantity: 1,
              confidence: 0.5,
              reviewed: false,
              source: 'scan',
              originalName: item.name,
            })),
          );
          setScanItemCount(ocrResult.parsedData.items.length);
        }

        if (ocrResult.parsedData.total) {
          setTotal(ocrResult.parsedData.total.toFixed(2));
        }

        if (ocrResult.extractedText) {
          setRawText(ocrResult.extractedText);
          const titleLine = ocrResult.extractedText.split('\n')[0]?.trim() ?? '';
          setMerchantName(normalizeScannedMerchantName(titleLine.slice(0, 50), null));
          setMerchantConfidence(null);
        }

        setPhase('complete');
        setScanMessage('Receipt processed!');
        successHaptic();

        setTimeout(() => setPhase('review'), 1200);
      } else {
        // OCR returned but couldn't parse — go to manual review
        setPhase('review');
      }
    } catch (error) {
      // OCR failed — still let user add items manually with photo attached
      setPhase('review');
    }
  };

  const handleAddItem = () => {
    mediumHaptic();
    setItems((prev) => [
      ...prev,
      {
        id: generateId(),
        name: '',
        price: '',
        quantity: 1,
        confidence: 1.0,
        reviewed: true,
        source: 'manual',
        originalName: '',
      },
    ]);
  };

  const handleRemoveItem = (id: string) => {
    mediumHaptic();
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  const handleUpdateItem = (id: string, field: 'name' | 'price', value: string) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value, reviewed: true } : item)),
    );
  };

  const handleMarkReviewed = (id: string) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, reviewed: true } : item)));
  };

  const handleHeaderTap = () => {
    if (!__DEV__) return;
    const nextCount = headerTapCount + 1;
    if (nextCount >= DEBUG_TAP_THRESHOLD) {
      setShowDebugTelemetry((prev) => !prev);
      setHeaderTapCount(0);
      return;
    }
    setHeaderTapCount(nextCount);
  };

  const handleConfirm = () => {
    if (lowConfidenceCount > 0) {
      if (strictReviewMode) {
        Alert.alert(
          'Strict Review Enabled',
          `Review all ${lowConfidenceCount} low-confidence item${lowConfidenceCount > 1 ? 's' : ''} before confirming.`,
          [{ text: 'OK' }],
        );
        return;
      }

      Alert.alert(
        'Review Needed',
        `${lowConfidenceCount} low-confidence item${lowConfidenceCount > 1 ? 's are' : ' is'} still unreviewed.`,
        [
          { text: 'Continue Anyway', style: 'destructive', onPress: () => finalizeConfirmation() },
          { text: 'Review First', style: 'cancel' },
        ],
      );
      return;
    }

    finalizeConfirmation();
  };

  const finalizeConfirmation = async () => {
    successHaptic();
    const validItems = items
      .filter((item) => item.name.trim() && parseFloat(item.price) > 0)
      .map((item) => ({
        id: item.id,
        name: item.name.trim(),
        price: parseFloat(item.price) || 0,
        quantity: item.quantity,
      }));

    const inferredCategory = rawText ? inferCategoryFromText(rawText) : null;

    const finalTotal = scannedTotal > 0 ? scannedTotal : calculatedTotal;

    await recordReceiptLearningFeedback({
      merchantName,
      scannedItems: scannedBaselineItems,
      finalItems: validItems.map((item) => ({ name: item.name, price: item.price })),
    });

    onComplete({
      imageUri,
      items: validItems,
      tax: parseFloat(tax) || 0,
      tip: parseFloat(tip) || 0,
      total: finalTotal,
      merchantName,
      merchantConfidence,
      date,
      inferredCategory,
      rawText,
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const getConfidenceColor = (c: number) => c >= 0.8 ? '#4CAF50' : c >= 0.6 ? '#FF9800' : '#F44336';

  const renderItemCard = (item: EditableReceiptItem) => (
    <View
      key={item.id}
      style={[
        styles.itemRow,
        {
          borderColor: item.reviewed ? `${theme.colors.outline}20` : '#FF950060',
          backgroundColor: item.reviewed
            ? (isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)')
            : (isDark ? 'rgba(255,149,0,0.08)' : 'rgba(255,149,0,0.05)'),
        },
      ]}
    >
      <View style={styles.itemTopRow}>
        {/* Confidence indicator */}
        <View style={[
          styles.confidenceDot,
          {
            backgroundColor: getConfidenceColor(item.confidence),
            shadowColor: item.confidence < LOW_CONFIDENCE_THRESHOLD ? '#FF9500' : 'transparent',
            shadowOpacity: item.confidence < LOW_CONFIDENCE_THRESHOLD ? 0.6 : 0,
            shadowRadius: 4,
            shadowOffset: { width: 0, height: 0 },
          }
        ]} />
        <TextInput
          mode="flat"
          placeholder="Item name"
          value={item.name}
          onChangeText={(v) => handleUpdateItem(item.id, 'name', v)}
          style={[styles.itemNameInput, { backgroundColor: 'transparent' }]}
          textColor={theme.colors.onSurface}
          placeholderTextColor={`${theme.colors.onSurfaceVariant}90`}
          underlineColor="transparent"
          activeUnderlineColor={theme.colors.primary}
          returnKeyType="next"
          blurOnSubmit={false}
          dense
        />
        <TextInput
          mode="flat"
          placeholder="0.00"
          value={item.price}
          onChangeText={(v) => handleUpdateItem(item.id, 'price', v)}
          keyboardType="decimal-pad"
          style={[styles.itemPriceInput, { backgroundColor: 'transparent' }]}
          textColor={theme.colors.onSurface}
          placeholderTextColor={`${theme.colors.onSurfaceVariant}90`}
          underlineColor="transparent"
          activeUnderlineColor={theme.colors.primary}
          left={<TextInput.Affix text="$" />}
          blurOnSubmit
          dense
        />
        <View style={styles.itemActions}>
          {!item.reviewed && (
            <IconButton
              icon="check-circle-outline"
              size={18}
              iconColor={theme.colors.primary}
              onPress={() => handleMarkReviewed(item.id)}
              style={styles.reviewBtn}
            />
          )}
          <IconButton
            icon="close-circle-outline"
            size={18}
            iconColor={`${theme.colors.error}B0`}
            onPress={() => handleRemoveItem(item.id)}
            style={styles.removeBtn}
          />
        </View>
      </View>
    </View>
  );

  return (
    <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
      <LiquidBackground>
        {phase === 'idle' && (
          <View style={styles.container}>
            <GlassView style={styles.card} contentStyle={{ gap: 8 }}>
              {/* Header */}
            <View style={styles.header}>
              <IconButton
                icon="close"
                size={24}
                onPress={onCancel}
                iconColor={theme.colors.onSurfaceVariant}
              />
              <Text
                variant="titleLarge"
                style={[styles.headerTitle, { color: theme.colors.onSurface }]}
              >
                Scan Receipt
              </Text>
              <View style={{ width: 40 }} />
            </View>

            {/* Illustration */}
            <View style={styles.idleContent}>
              <View
                style={[
                  styles.illustrationCircle,
                  { backgroundColor: `${theme.colors.primary}12` },
                ]}
              >
                <Icon source="camera-document" size={64} color={theme.colors.primary} />
              </View>

              <Text
                variant="headlineSmall"
                style={[styles.idleTitle, { color: theme.colors.onSurface }]}
              >
                Smart Receipt Scanner
              </Text>

              <Text
                variant="bodyMedium"
                style={[styles.idleSubtitle, { color: theme.colors.onSurfaceVariant }]}
              >
                Take a clear photo of your receipt and we'll automatically extract all items, tax, tip, and total for you.
              </Text>

              {/* Feature pills */}
              <View style={styles.featurePills}>
                {[
                  { icon: 'flash', label: 'Instant scan' },
                  { icon: 'shield-check', label: 'On-device' },
                  { icon: 'format-list-checks', label: 'Auto-itemize' },
                ].map((f) => (
                  <View
                    key={f.label}
                    style={[styles.pill, { backgroundColor: `${theme.colors.primary}10` }]}
                  >
                    <Icon source={f.icon} size={14} color={theme.colors.primary} />
                    <Text
                      variant="labelSmall"
                      style={{ color: theme.colors.primary, fontWeight: '600' }}
                    >
                      {f.label}
                    </Text>
                  </View>
                ))}
              </View>

              <View style={[styles.mismatchBanner, { backgroundColor: isDark ? 'rgba(255,150,0,0.12)' : 'rgba(255,140,0,0.08)', marginHorizontal: 20, marginTop: 24 }]}>
                <Icon source="shield-alert-outline" size={20} color="#FF9500" />
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1, lineHeight: 18 }}>
                  Scanned securely on-device. Auto-extraction may contain errors—please cross-check and correct items if required.
                </Text>
              </View>
            </View>

            {/* Scan button */}
            <Button
              mode="contained"
              icon="camera"
              onPress={handleStartScan}
              style={styles.scanButton}
              contentStyle={styles.scanButtonContent}
              labelStyle={styles.scanButtonLabel}
            >
              Scan Receipt
            </Button>

            <Button
              mode="text"
              icon="pencil-plus"
              onPress={() => setPhase('review')}
              textColor={theme.colors.onSurfaceVariant}
              style={styles.manualButton}
            >
              Add items manually
            </Button>
          </GlassView>
        </View>
        )}

        {phase !== 'idle' && phase !== 'review' && (
          <View style={styles.container}>
            <ScanningAnimation
              phase={phase}
              message={scanMessage}
              itemCount={scanItemCount}
              imageUri={imageUri || undefined}
            />
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', marginTop: 32, paddingHorizontal: 32, opacity: 0.8, lineHeight: 18 }}>
              Processing securely on-device. Please be ready to review and correct any potential misreads.
            </Text>
          </View>
        )}

        {/* Review phase — editable item list */}
        {phase === 'review' && (
          <View style={{ flex: 1 }}>
            <Pressable style={styles.container} onPress={Keyboard.dismiss}>
              <GlassView style={styles.reviewCard} contentStyle={{ flex: 1 }}>
              {/* Header */}
              <View style={styles.header}>
                <IconButton
                  icon="arrow-left"
                  size={24}
                  onPress={onCancel}
                  iconColor={theme.colors.onSurfaceVariant}
                />
                <TouchableOpacity style={{ flex: 1 }} activeOpacity={0.8} onPress={handleHeaderTap}>
                  <Text
                    variant="titleLarge"
                    style={[styles.headerTitle, { color: theme.colors.onSurface }]}
                  >
                    Review Items
                  </Text>
                </TouchableOpacity>
                <IconButton
                  icon="camera-retake-outline"
                  size={22}
                  onPress={() => {
                    setPhase('idle');
                    setItems([]);
                    setTax('');
                    setTip('');
                    setTotal('');
                    setMerchantName(null);
                    setMerchantConfidence(null);
                    setDate(null);
                    setRawText(null);
                    setParserTelemetry([]);
                    setScannedBaselineItems([]);
                  }}
                  iconColor={theme.colors.onSurfaceVariant}
                />
              </View>

              {/* Scrollable content */}
              <KeyboardAwareScrollView
                style={styles.scrollContent}
                contentContainerStyle={[styles.scrollContentContainer, { paddingBottom: 100 }]}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator={false}
                bottomOffset={40}
              >
                <View style={[styles.mismatchBanner, { backgroundColor: isDark ? 'rgba(255,150,0,0.12)' : 'rgba(255,140,0,0.08)', marginBottom: 16, marginTop: 0 }]}>
                  <Icon source="shield-alert-outline" size={18} color="#FF9500" />
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, flex: 1, lineHeight: 18 }}>
                    Processed entirely on-device! Please cross-check and correct any OCR misreads below.
                  </Text>
                </View>

                {merchantName && (
                  <View style={[styles.merchantBanner, { backgroundColor: `${theme.colors.primary}10` }]}>
                    <Icon source="store" size={16} color={theme.colors.primary} />
                    <View style={{ flex: 1 }}>
                      <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '600' }}>
                        {merchantName}
                      </Text>
                      {merchantConfidence != null && merchantConfidence < AUTO_TITLE_MERCHANT_CONFIDENCE && (
                        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                          Possible merchant. Review before using as the expense title.
                        </Text>
                      )}
                    </View>
                    {date && (
                      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        {date}
                      </Text>
                    )}
                  </View>
                )}

                {/* Item list header */}
                <View style={styles.sectionHeader}>
                  <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                    Items ({items.length})
                  </Text>
                  {strictReviewMode && (
                    <View style={[styles.strictBadge, { backgroundColor: `${theme.colors.primary}20` }]}>
                      <Icon source="shield-lock-outline" size={14} color={theme.colors.primary} />
                      <Text variant="labelSmall" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                        Strict
                      </Text>
                    </View>
                  )}
                  {lowConfidenceCount > 0 && (
                    <View style={[styles.reviewBadge, { backgroundColor: isDark ? 'rgba(255,149,0,0.14)' : 'rgba(255,149,0,0.12)' }]}>
                      <Icon source="alert-circle-outline" size={14} color="#FF9500" />
                      <Text variant="labelSmall" style={{ color: '#FF9500', fontWeight: '700' }}>
                        Review {lowConfidenceCount}
                      </Text>
                    </View>
                  )}
                  <TouchableOpacity onPress={handleAddItem} style={styles.addItemBtn}>
                    <Icon source="plus-circle" size={18} color={theme.colors.primary} />
                    <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '600' }}>
                      Add Item
                    </Text>
                  </TouchableOpacity>
                </View>

                {/* Items */}
                {orderedItems.length > 0 ? (
                  <View style={styles.itemListContainer}>
                    {orderedItems.map(renderItemCard)}
                  </View>
                ) : (
                  <TouchableOpacity
                    onPress={handleAddItem}
                    style={[styles.emptyState, { borderColor: `${theme.colors.outline}30` }]}
                  >
                    <Icon source="plus-circle-outline" size={32} color={theme.colors.onSurfaceVariant} />
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                      Tap to add the first item
                    </Text>
                  </TouchableOpacity>
                )}

                {__DEV__ && showDebugTelemetry && (
                  <View style={[styles.debugPanel, { borderColor: `${theme.colors.outline}40`, backgroundColor: `${theme.colors.surfaceVariant}66` }]}>
                    <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '700', marginBottom: 6 }}>
                      Parser Telemetry (Dev)
                    </Text>

                    <View style={styles.healthRow}>
                      <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                        Parser health
                      </Text>
                      <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                        {parserHealthScore}/100
                      </Text>
                    </View>

                    <View style={styles.histogramContainer}>
                      <View style={styles.histogramRow}>
                        <Text variant="labelSmall" style={[styles.histogramLabel, { color: '#F44336' }]}>Low</Text>
                        <View style={[styles.histogramTrack, { backgroundColor: `${theme.colors.onSurface}18` }]}>
                          <View style={[styles.histogramFill, { width: `${confidenceStats.total > 0 ? (confidenceStats.low / confidenceStats.total) * 100 : 0}%`, backgroundColor: '#F44336' }]} />
                        </View>
                        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>{confidenceStats.low}</Text>
                      </View>
                      <View style={styles.histogramRow}>
                        <Text variant="labelSmall" style={[styles.histogramLabel, { color: '#FF9800' }]}>Med</Text>
                        <View style={[styles.histogramTrack, { backgroundColor: `${theme.colors.onSurface}18` }]}>
                          <View style={[styles.histogramFill, { width: `${confidenceStats.total > 0 ? (confidenceStats.medium / confidenceStats.total) * 100 : 0}%`, backgroundColor: '#FF9800' }]} />
                        </View>
                        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>{confidenceStats.medium}</Text>
                      </View>
                      <View style={styles.histogramRow}>
                        <Text variant="labelSmall" style={[styles.histogramLabel, { color: '#4CAF50' }]}>High</Text>
                        <View style={[styles.histogramTrack, { backgroundColor: `${theme.colors.onSurface}18` }]}>
                          <View style={[styles.histogramFill, { width: `${confidenceStats.total > 0 ? (confidenceStats.high / confidenceStats.total) * 100 : 0}%`, backgroundColor: '#4CAF50' }]} />
                        </View>
                        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>{confidenceStats.high}</Text>
                      </View>
                    </View>

                    <ScrollView style={styles.debugList} nestedScrollEnabled>
                      {parserTelemetry.length === 0 ? (
                        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                          No parser telemetry captured for this scan.
                        </Text>
                      ) : (
                        parserTelemetry.map((line: string, index: number) => (
                          <Text key={`telemetry_${index}`} variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 3 }}>
                            {line}
                          </Text>
                        ))
                      )}
                    </ScrollView>
                  </View>
                )}

                {/* Summary section */}
                <View style={[styles.summarySection, { backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)', borderColor: `${theme.colors.outline}15` }]}>
                  {/* Subtotal line */}
                  {items.length > 0 && (
                    <View style={styles.subtotalRow}>
                      <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                        Items subtotal
                      </Text>
                      <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                        ${itemsSubtotal.toFixed(2)}
                      </Text>
                    </View>
                  )}

                  <Divider style={{ backgroundColor: `${theme.colors.outline}15`, marginVertical: 6 }} />

                  {/* Tax & Tip */}
                  <View style={styles.extraFields}>
                    <FloatingLabelInput
                      label="Tax"
                      value={tax}
                      onChangeText={setTax}
                      keyboardType="decimal-pad"
                      left={<TextInput.Affix text="$" />}
                      containerStyle={{ flex: 1 }}
                    />
                    <FloatingLabelInput
                      label="Tip"
                      value={tip}
                      onChangeText={setTip}
                      keyboardType="decimal-pad"
                      left={<TextInput.Affix text="$" />}
                      containerStyle={{ flex: 1 }}
                    />
                  </View>

                  <Divider style={{ backgroundColor: `${theme.colors.outline}15`, marginVertical: 6 }} />

                  {/* Total */}
                  <View style={styles.totalRow}>
                    <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                      Calculated Total
                    </Text>
                    <Text variant="titleLarge" style={{ color: theme.colors.primary, fontWeight: '800', fontSize: 22 }}>
                      ${calculatedTotal.toFixed(2)}
                    </Text>
                  </View>

                  {hasTotalMismatch && (
                    <View
                      style={[
                        styles.mismatchBanner,
                        { backgroundColor: isDark ? 'rgba(255,180,0,0.12)' : 'rgba(255,150,0,0.08)' },
                      ]}
                    >
                      <Icon source="alert-circle-outline" size={16} color="#FF9500" />
                      <Text variant="labelSmall" style={{ color: '#FF9500', flex: 1 }}>
                        Scanned total (${scannedTotal.toFixed(2)}) differs from items + tax + tip (${calculatedTotal.toFixed(2)})
                      </Text>
                    </View>
                  )}
                </View>

                {/* Bottom spacer for keyboard clearance */}
                <View style={{ height: 16 }} />

                {/* Actions natively integrated into the page to preserve single GlassView layer natively */}
                <View style={[styles.actions, { borderTopWidth: 1, borderTopColor: `${theme.colors.outline}15` }]}>
                  <Button
                    mode="outlined"
                    onPress={onCancel}
                    style={[styles.cancelBtn, { borderColor: `${theme.colors.outline}60` }]}
                    labelStyle={{ fontWeight: '600' }}
                  >
                    Cancel
                  </Button>
                  <Button
                    mode="contained"
                    onPress={handleConfirm}
                    style={styles.confirmBtn}
                    icon="check"
                    labelStyle={{ fontWeight: '700', fontSize: 15 }}
                    contentStyle={{ paddingVertical: 4 }}
                    disabled={items.length === 0 && !total}
                  >
                    Use These Items
                  </Button>
                </View>
              </KeyboardAwareScrollView>
              </GlassView>
            </Pressable>
          </View>
        )}
      </LiquidBackground>
    </KeyboardProvider>
  );
};

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 12,
    justifyContent: 'center',
  },
  card: {
    padding: 24,
    borderRadius: 24,
    gap: 8,
  },
  reviewCard: {
    padding: 14,
    borderRadius: 24,
    flex: 1,
    marginTop: Platform.OS === 'ios' ? 50 : 16,
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontWeight: '700',
  },
  scrollContent: {
    flex: 1,
  },
  scrollContentContainer: {
    paddingBottom: 8,
  },
  idleContent: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 12,
  },
  illustrationCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  idleTitle: {
    fontWeight: '700',
    textAlign: 'center',
  },
  idleSubtitle: {
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: 16,
  },
  featurePills: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 20,
  },
  scanButton: {
    borderRadius: 16,
    marginTop: 8,
  },
  scanButtonContent: {
    paddingVertical: 8,
  },
  scanButtonLabel: {
    fontSize: 16,
    fontWeight: '700',
  },
  manualButton: {
    marginTop: 4,
  },
  merchantBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginBottom: 10,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
    paddingHorizontal: 2,
  },
  addItemBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  itemListContainer: {
    gap: 6,
  },
  itemRow: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  itemTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  confidenceDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  itemNameInput: {
    flex: 2,
    fontSize: 14,
    height: 38,
  },
  itemPriceInput: {
    flex: 1,
    fontSize: 14,
    height: 38,
    textAlign: 'right',
  },
  itemActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: -4,
  },
  removeBtn: {
    margin: 0,
    marginLeft: -4,
  },
  reviewBtn: {
    margin: 0,
    marginRight: -4,
  },
  reviewBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    marginLeft: 'auto',
    marginRight: 8,
  },
  strictBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    marginLeft: 'auto',
    marginRight: 8,
  },
  debugPanel: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
  },
  healthRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  histogramContainer: {
    gap: 4,
    marginBottom: 8,
  },
  histogramRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  histogramLabel: {
    width: 32,
    fontWeight: '700',
  },
  histogramTrack: {
    flex: 1,
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
  histogramFill: {
    height: '100%',
    borderRadius: 999,
  },
  debugList: {
    maxHeight: 140,
  },
  summarySection: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
  },
  subtotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 12,
    gap: 8,
  },
  extraFields: {
    flexDirection: 'row',
    gap: 12,
    marginVertical: 4,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  mismatchBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginTop: 4,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 16 : 8,
  },
  cancelBtn: {
    flex: 1,
    borderRadius: 12,
  },
  confirmBtn: {
    flex: 2,
    borderRadius: 12,
  },
});

