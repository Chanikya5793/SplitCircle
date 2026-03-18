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

import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Button,
  Divider,
  Icon,
  IconButton,
  Text,
  TextInput,
} from 'react-native-paper';
import { useTheme } from '@/context/ThemeContext';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ScanningAnimation } from '@/components/ScanningAnimation';
import { FloatingLabelInput } from '@/components/FloatingLabelInput';
import {
  isVisionKitAvailable,
  scanReceiptWithVisionKit,
  type ScanProgressEvent,
  type VisionKitScannedItem,
} from '@/services/visionKitService';
import { extractReceiptData, inferCategoryFromText } from '@/services/ocrService';
import { mediumHaptic, successHaptic } from '@/utils/haptics';
import * as ImagePicker from 'expo-image-picker';

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
  const [items, setItems] = useState<{ id: string; name: string; price: string; quantity: number; confidence: number }[]>([]);
  const [tax, setTax] = useState('');
  const [tip, setTip] = useState('');
  const [total, setTotal] = useState('');
  const [merchantName, setMerchantName] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);

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

  const populateFromVisionKit = useCallback((result: NonNullable<Awaited<ReturnType<typeof scanReceiptWithVisionKit>>>) => {
    setImageUri(result.imageUri || null);
    setMerchantName(result.merchantName || null);
    setDate(result.date || null);
    setRawText(result.rawText || null);

    if (result.items && result.items.length > 0) {
      setItems(
        result.items.map((item: VisionKitScannedItem) => ({
          id: generateId(),
          name: item.name,
          price: item.price.toFixed(2),
          quantity: item.quantity,
          confidence: item.confidence ?? 0.7,
        })),
      );
    }

    if (result.tax != null && result.tax > 0) setTax(result.tax.toFixed(2));
    if (result.tip != null && result.tip > 0) setTip(result.tip.toFixed(2));
    if (result.total != null && result.total > 0) setTotal(result.total.toFixed(2));
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

        populateFromVisionKit(result);

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

    // Check if backend OCR is configured before attempting
    const ocrEndpoint = process.env.EXPO_PUBLIC_OCR_PROXY_ENDPOINT;
    if (!ocrEndpoint) {
      // No OCR service available — go straight to manual review with photo attached
      setPhase('review');
      return;
    }

    setPhase('processing');
    setScanMessage('Processing receipt...');

    try {
      const ocrResult = await extractReceiptData(uri);

      if (ocrResult.success && ocrResult.parsedData) {
        mediumHaptic();

        if (ocrResult.parsedData.items && ocrResult.parsedData.items.length > 0) {
          setItems(
            ocrResult.parsedData.items.map((item) => ({
              id: generateId(),
              name: item.name,
              price: item.price.toFixed(2),
              quantity: 1,
              confidence: 0.5,
            })),
          );
          setScanItemCount(ocrResult.parsedData.items.length);
        }

        if (ocrResult.parsedData.total) {
          setTotal(ocrResult.parsedData.total.toFixed(2));
        }

        if (ocrResult.extractedText) {
          setRawText(ocrResult.extractedText);
          const titleLine = ocrResult.extractedText.split('\n')[0]?.trim();
          if (titleLine) setMerchantName(titleLine.slice(0, 50));
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
    setItems((prev) => [...prev, { id: generateId(), name: '', price: '', quantity: 1, confidence: 1.0 }]);
  };

  const handleRemoveItem = (id: string) => {
    mediumHaptic();
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  const handleUpdateItem = (id: string, field: 'name' | 'price', value: string) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)),
    );
  };

  const handleConfirm = () => {
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

    onComplete({
      imageUri,
      items: validItems,
      tax: parseFloat(tax) || 0,
      tip: parseFloat(tip) || 0,
      total: finalTotal,
      merchantName,
      date,
      inferredCategory,
      rawText,
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const getConfidenceColor = (c: number) => c >= 0.8 ? '#4CAF50' : c >= 0.6 ? '#FF9800' : '#F44336';

  const renderItem = ({ item }: { item: typeof items[0] }) => (
    <View style={[styles.itemRow, { borderColor: `${theme.colors.outline}40` }]}>
      {/* Confidence dot */}
      <View style={[
        styles.confidenceDot,
        { backgroundColor: getConfidenceColor(item.confidence) }
      ]} />
      <View style={styles.itemInputs}>
        <TextInput
          mode="flat"
          placeholder="Item name"
          value={item.name}
          onChangeText={(v) => handleUpdateItem(item.id, 'name', v)}
          style={[styles.itemNameInput, { backgroundColor: 'transparent' }]}
          textColor={theme.colors.onSurface}
          placeholderTextColor={theme.colors.onSurfaceVariant}
          underlineColor="transparent"
          activeUnderlineColor={theme.colors.primary}
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
          placeholderTextColor={theme.colors.onSurfaceVariant}
          underlineColor="transparent"
          activeUnderlineColor={theme.colors.primary}
          left={<TextInput.Affix text="$" />}
          dense
        />
      </View>
      <IconButton
        icon="close-circle-outline"
        size={20}
        iconColor={theme.colors.error}
        onPress={() => handleRemoveItem(item.id)}
        style={styles.removeBtn}
      />
    </View>
  );

  if (phase === 'idle') {
    return (
      <LiquidBackground>
        <View style={styles.container}>
          <GlassView style={styles.card}>
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
      </LiquidBackground>
    );
  }

  if (phase !== 'review') {
    return (
      <LiquidBackground>
        <View style={styles.container}>
          <ScanningAnimation
            phase={phase}
            message={scanMessage}
            itemCount={scanItemCount}
            imageUri={imageUri || undefined}
          />
        </View>
      </LiquidBackground>
    );
  }

  // Review phase — editable item list
  return (
    <LiquidBackground>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.container}>
          <GlassView style={styles.reviewCard}>
            {/* Header */}
            <View style={styles.header}>
              <IconButton
                icon="arrow-left"
                size={24}
                onPress={onCancel}
                iconColor={theme.colors.onSurfaceVariant}
              />
              <Text
                variant="titleLarge"
                style={[styles.headerTitle, { color: theme.colors.onSurface }]}
              >
                Review Items
              </Text>
              <IconButton
                icon="camera-retake-outline"
                size={22}
                onPress={() => { setPhase('idle'); setItems([]); setTax(''); setTip(''); setTotal(''); setMerchantName(null); setDate(null); }}
                iconColor={theme.colors.onSurfaceVariant}
              />
            </View>

            {merchantName && (
              <View style={[styles.merchantBanner, { backgroundColor: `${theme.colors.primary}10` }]}>
                <Icon source="store" size={16} color={theme.colors.primary} />
                <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '600' }}>
                  {merchantName}
                </Text>
                {date && (
                  <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 'auto' }}>
                    {date}
                  </Text>
                )}
              </View>
            )}

            {/* Item list */}
            <View style={styles.sectionHeader}>
              <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                Items ({items.length})
              </Text>
              <TouchableOpacity onPress={handleAddItem} style={styles.addItemBtn}>
                <Icon source="plus-circle" size={18} color={theme.colors.primary} />
                <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '600' }}>
                  Add Item
                </Text>
              </TouchableOpacity>
            </View>

            <FlatList
              data={items}
              renderItem={renderItem}
              keyExtractor={(item) => item.id}
              style={styles.itemList}
              contentContainerStyle={styles.itemListContent}
              ListEmptyComponent={
                <TouchableOpacity
                  onPress={handleAddItem}
                  style={[styles.emptyState, { borderColor: `${theme.colors.outline}30` }]}
                >
                  <Icon source="plus-circle-outline" size={32} color={theme.colors.onSurfaceVariant} />
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                    Tap to add the first item
                  </Text>
                </TouchableOpacity>
              }
              keyboardShouldPersistTaps="handled"
            />

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

            <Divider style={{ backgroundColor: `${theme.colors.outline}20`, marginVertical: 8 }} />

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

            {/* Total */}
            <View style={styles.totalSection}>
              <View style={styles.totalRow}>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                  Calculated Total
                </Text>
                <Text variant="titleMedium" style={{ color: theme.colors.primary, fontWeight: '700' }}>
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

            {/* Actions */}
            <View style={styles.actions}>
              <Button
                mode="outlined"
                onPress={onCancel}
                style={{ flex: 1, borderColor: theme.colors.outline }}
              >
                Cancel
              </Button>
              <Button
                mode="contained"
                onPress={handleConfirm}
                style={{ flex: 2 }}
                icon="check"
                disabled={items.length === 0 && !total}
              >
                Use These Items
              </Button>
            </View>
          </GlassView>
        </View>
      </KeyboardAvoidingView>
    </LiquidBackground>
  );
};

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    justifyContent: 'center',
  },
  card: {
    padding: 24,
    borderRadius: 24,
    gap: 8,
  },
  reviewCard: {
    padding: 16,
    borderRadius: 24,
    flex: 1,
    marginTop: Platform.OS === 'ios' ? 50 : 16,
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontWeight: '700',
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
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginBottom: 8,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  addItemBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  itemList: {
    flexGrow: 0,
    maxHeight: 300,
  },
  itemListContent: {
    gap: 4,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingLeft: 4,
  },
  confidenceDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginLeft: 4,
    marginRight: 2,
  },
  itemInputs: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  itemNameInput: {
    flex: 2,
    fontSize: 14,
    height: 40,
  },
  itemPriceInput: {
    flex: 1,
    fontSize: 14,
    height: 40,
    textAlign: 'right',
  },
  removeBtn: {
    margin: 0,
  },
  subtotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
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
    marginBottom: 8,
  },
  totalSection: {
    gap: 6,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  mismatchBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
    paddingBottom: Platform.OS === 'ios' ? 16 : 0,
  },
});
