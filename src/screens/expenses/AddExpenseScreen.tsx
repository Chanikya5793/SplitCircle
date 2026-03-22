import { BillSplitScreen } from '@/components/BillSplit';
import type { Participant, SplitMethod } from '@/components/BillSplit/types';
import { FloatingLabelInput } from '@/components/FloatingLabelInput';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ReceiptScannerSheet, type ReceiptScannerResult } from '@/components/ReceiptScannerSheet';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { ExpenseReceiptItem, ExpenseSplitMetadata, Group, ParticipantShare, SplitType } from '@/models';
import { extractReceiptData, inferCategoryFromText } from '@/services/ocrService';
import {
  normalizeScannedMerchantName,
  shouldAutofillExpenseTitleFromMerchant,
} from '@/services/receiptScanNormalization';
import { parseReceiptImageWithVisionKit } from '@/services/visionKitService';
import { formatCurrency } from '@/utils/currency';
import {
  computeSharesFromExpenseSplit,
  computeParticipantsFromSplitMetadata,
  getExpenseSplitLabel,
  inferExpenseSplitMetadata,
} from '@/utils/expenseSplit';
import { mediumHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Alert, Image, Modal, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Button, Chip, Dialog, Icon, Menu, PaperProvider, Portal, Text, TextInput, TouchableRipple } from 'react-native-paper';

interface AddExpenseScreenProps {
  group: Group;
  expenseId?: string;
  onClose: () => void;
}

const CATEGORIES = ['General', 'Food', 'Transport', 'Utilities', 'Entertainment', 'Shopping', 'Travel', 'Health'];
const MAX_RECEIPT_FILE_SIZE_BYTES = 20 * 1024 * 1024;

// Category to Icon mapping
const getCategoryIcon = (cat: string): string => {
  const iconMap: Record<string, string> = {
    'General': 'tag',
    'Food': 'food',
    'Transport': 'car',
    'Utilities': 'flash',
    'Entertainment': 'movie',
    'Shopping': 'cart',
    'Travel': 'airplane',
    'Health': 'medical-bag',
  };
  return iconMap[cat] || 'tag';
};

export const AddExpenseScreen = ({ group, expenseId, onClose }: AddExpenseScreenProps) => {
  const navigation = useNavigation();
  const { user } = useAuth();
  const { addExpense, updateExpense } = useGroups();
  const { theme, isDark } = useTheme();
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('General');
  const [paidBy, setPaidBy] = useState(user?.userId ?? group.members[0]?.userId ?? '');
  const [splitType, setSplitType] = useState<SplitType>('equal');
  const [selectedMembers, setSelectedMembers] = useState<string[]>(group.members.map((member) => member.userId));
  const [customShares, setCustomShares] = useState<Record<string, string>>({});
  const [splitMetadata, setSplitMetadata] = useState<ExpenseSplitMetadata | undefined>();
  const [receiptUri, setReceiptUri] = useState<string | null>(null);
  const [receiptType, setReceiptType] = useState<'image' | 'document' | null>(null);
  const [receiptName, setReceiptName] = useState<string | null>(null);

  const [showPayerDialog, setShowPayerDialog] = useState(false);
  const [showCategoryMenu, setShowCategoryMenu] = useState(false);
  const [showReceiptMenu, setShowReceiptMenu] = useState(false);
  const [isProcessingOCR, setIsProcessingOCR] = useState(false);
  const [showBillSplit, setShowBillSplit] = useState(false);
  const [showReceiptScanner, setShowReceiptScanner] = useState(false);
  const [splitMethodLabel, setSplitMethodLabel] = useState<string>('Equal');

  useLayoutEffect(() => {
    navigation.setOptions({
      headerShown: false,
    });
  }, [navigation]);

  useEffect(() => {
    if (expenseId) {
      const expense = group.expenses.find((e) => e.expenseId === expenseId);
      if (expense) {
        setTitle(expense.title);
        setAmount(expense.amount.toString());
        setCategory(expense.category);
        setPaidBy(expense.paidBy);
        setSplitType(expense.splitType);
        setSelectedMembers(expense.participants.map((p) => p.userId));
        setSplitMetadata(inferExpenseSplitMetadata(expense));
        setSplitMethodLabel(getExpenseSplitLabel(expense));

        if (expense.receipt?.url) {
          setReceiptUri(expense.receipt.url);
          // Infer type from filename or extension if possible, default to image for backward compat
          const isPdf = expense.receipt.fileName?.toLowerCase().endsWith('.pdf');
          setReceiptType(isPdf ? 'document' : 'image');
          setReceiptName(expense.receipt.fileName || 'Receipt');
        } else {
          setReceiptUri(null);
          setReceiptType(null);
          setReceiptName(null);
        }

        if (expense.splitType === 'custom') {
          const shares: Record<string, string> = {};
          expense.participants.forEach((p) => {
            shares[p.userId] = p.share.toString();
          });
          setCustomShares(shares);
        } else {
          setCustomShares({});
        }
      } else {
        setSplitMetadata(undefined);
        setSplitMethodLabel('Equal');
      }
    }
  }, [expenseId, group.expenses]);
  const isRecurringExpense = expenseId ? group.expenses.find((e) => e.expenseId === expenseId)?.recurring : undefined;

  const memberDisplayNames = useMemo(
    () => Object.fromEntries(group.members.map((member) => [member.userId, member.displayName])),
    [group.members],
  );

  // ── BillSplit Integration ───────────────────────────────────────────────
  const historicalPaidMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const m of group.members) map[m.userId] = 0;
    for (const exp of group.expenses) {
      if (exp.paidBy && map[exp.paidBy] !== undefined) {
        map[exp.paidBy] += exp.amount;
      }
    }
    return map;
  }, [group.members, group.expenses]);

  const billSplitParticipants = useMemo<Participant[]>(() => {
    const configMap = new Map((splitMetadata?.participantConfig ?? []).map((participant) => [participant.userId, participant]));
    const baseParticipants = group.members.map((m) => {
      const config = configMap.get(m.userId);

      return {
        id: m.userId,
        name: m.displayName,
        avatarUrl: m.photoURL,
        included: config?.included ?? selectedMembers.includes(m.userId),
        exactAmount: config?.exactAmount ?? Number(customShares[m.userId] || '0'),
        percentage: config?.percentage ?? 0,
        shares: config?.shares ?? 1,
        adjustment: config?.adjustment ?? 0,
        incomeWeight: config?.incomeWeight ?? 50000,
        daysStayed: config?.daysStayed ?? 1,
        checkInDate: config?.checkInDate,
        checkOutDate: config?.checkOutDate,
        selectedStayDates: config?.selectedStayDates,
        partsConsumed: config?.partsConsumed ?? 0,
        rouletteWeight: config?.rouletteWeight ?? 25,
        historicalPaid: config?.historicalPaid ?? historicalPaidMap[m.userId] ?? 0,
        computedAmount: config?.computedAmount ?? Number(customShares[m.userId] || '0'),
      };
    });

    return computeParticipantsFromSplitMetadata(Number(amount) || 0, baseParticipants, splitMetadata);
  }, [amount, customShares, group.members, historicalPaidMap, selectedMembers, splitMetadata]);

  const participantShares = useMemo<ParticipantShare[]>(() => {
    const numericAmount = Number(amount) || 0;
    if (!numericAmount || selectedMembers.length === 0) {
      return [];
    }

    if (splitMetadata) {
      return computeSharesFromExpenseSplit(numericAmount, billSplitParticipants, splitMetadata);
    }

    if (splitType === 'custom') {
      return selectedMembers.map((userId) => ({ userId, share: Number(customShares[userId] || '0') }));
    }

    const share = Number((numericAmount / selectedMembers.length).toFixed(2));
    const totalCalculated = share * selectedMembers.length;
    const diff = numericAmount - totalCalculated;

    return selectedMembers.map((userId, index) => ({
      userId,
      share: index === selectedMembers.length - 1 ? Number((share + diff).toFixed(2)) : share,
    }));
  }, [amount, billSplitParticipants, customShares, selectedMembers, splitMetadata, splitType]);

  const customTotal = participantShares.reduce((sum, entry) => sum + entry.share, 0);
  const matchesAmount = Math.abs(customTotal - (Number(amount) || 0)) < 0.01;

  const formValid = Boolean(
    title &&
    amount &&
    participantShares.length &&
    (splitType !== 'custom' || (participantShares.every((entry) => entry.share >= 0) && matchesAmount))
  );

  const handleBillSplitDone = (result: {
    paidBy: string;
    method: SplitMethod;
    participants: { userId: string; share: number }[];
    splitMetadata: ExpenseSplitMetadata;
    resolvedTotalAmount: number;
  }) => {
    successHaptic();
    setPaidBy(result.paidBy);
    setSelectedMembers(result.participants.map((p) => p.userId));
    setSplitMetadata(result.splitMetadata);

    // Map advanced methods → 'custom' splitType for storage
    if (result.method === 'equal') {
      setSplitType('equal');
      setCustomShares({});
    } else {
      setSplitType('custom');
      const shares: Record<string, string> = {};
      result.participants.forEach((p) => {
        shares[p.userId] = p.share.toString();
      });
      setCustomShares(shares);
    }

    if (Math.abs(result.resolvedTotalAmount - (Number(amount) || 0)) > 0.009) {
      setAmount(result.resolvedTotalAmount.toFixed(2));
    }

    setSplitMethodLabel(getExpenseSplitLabel({ splitType: result.method === 'equal' ? 'equal' : 'custom', splitMetadata: result.splitMetadata }));
    setShowBillSplit(false);
  };

  const handlePickImage = async () => {
    setShowReceiptMenu(false);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.7,
    });

    if (!result.canceled) {
      const uri = result.assets[0].uri;
      setReceiptUri(uri);
      setReceiptType('image');
      setReceiptName(result.assets[0].fileName || 'image.jpg');

      // Process OCR if not editing existing expense
      if (!expenseId) {
        await processReceiptOCR(uri);
      }
    }
  };

  const applyReceiptScanResult = (scanResult: ReceiptScannerResult) => {
    // Auto-attach the scanned receipt image
    if (scanResult.imageUri) {
      setReceiptUri(scanResult.imageUri);
      setReceiptType('image');
      setReceiptName('receipt_scan.jpg');
    }

    // Auto-fill merchant name as title
    const normalizedMerchant = normalizeScannedMerchantName(scanResult.merchantName, scanResult.merchantConfidence);
    if (normalizedMerchant && shouldAutofillExpenseTitleFromMerchant(normalizedMerchant, scanResult.merchantConfidence) && !title.trim()) {
      setTitle(normalizedMerchant);
    }

    // Auto-fill category
    if (scanResult.inferredCategory && category === 'General') {
      setCategory(scanResult.inferredCategory);
    }

    // Handle amount — show dialog if already entered and different
    const scannedTotal = scanResult.total;
    const currentAmount = Number(amount) || 0;

    if (scannedTotal > 0) {
      if (currentAmount > 0 && Math.abs(currentAmount - scannedTotal) > 0.01) {
        // Amount conflict — ask user
        Alert.alert(
          'Amount Differs',
          `Scanned total is $${scannedTotal.toFixed(2)}, but you entered $${currentAmount.toFixed(2)}. Which would you like to use?`,
          [
            { text: `Keep $${currentAmount.toFixed(2)}`, style: 'cancel' },
            {
              text: `Use $${scannedTotal.toFixed(2)}`,
              onPress: () => setAmount(scannedTotal.toFixed(2)),
            },
          ],
        );
      } else if (currentAmount === 0) {
        setAmount(scannedTotal.toFixed(2));
      }
    }

    // Auto-populate itemized split with scanned items
    if (scanResult.items.length > 0) {
      const receiptItems: ExpenseReceiptItem[] = scanResult.items.map((item) => ({
        id: item.id,
        name: item.name,
        price: item.price * item.quantity,
        assignedTo: group.members.map((m) => m.userId), // default: assigned to all
      }));

      const newMetadata: ExpenseSplitMetadata = {
        version: 1,
        method: 'itemized',
        participantConfig: group.members.map((m) => ({
          userId: m.userId,
          included: selectedMembers.includes(m.userId),
        })),
        receiptItems,
        taxAmount: scanResult.tax,
        tipAmount: scanResult.tip,
      };

      setSplitMetadata(newMetadata);
      setSplitType('custom');
      setSplitMethodLabel('Itemized receipt');

      // Compute custom shares from itemized data
      const shares: Record<string, string> = {};
      group.members.forEach((m) => {
        const memberItems = receiptItems.filter((ri) => ri.assignedTo.includes(m.userId));
        const itemTotal = memberItems.reduce((sum, ri) => {
          const shareCount = ri.assignedTo.length;
          return sum + (shareCount > 0 ? ri.price / shareCount : 0);
        }, 0);
        shares[m.userId] = itemTotal.toFixed(2);
      });
      setCustomShares(shares);
    }
  };

  const processReceiptOCR = async (imageUri: string) => {
    setIsProcessingOCR(true);
    try {
      const nativeResult = await parseReceiptImageWithVisionKit(imageUri);
      if (nativeResult && !nativeResult.cancelled) {
        const inferredCategory = nativeResult.rawText ? inferCategoryFromText(nativeResult.rawText) : null;
        const scanResult: ReceiptScannerResult = {
          imageUri: nativeResult.imageUri ?? imageUri,
          items: nativeResult.items.map((item, index) => ({
            id: `native-scan-${index}`,
            name: item.name,
            price: item.price,
            quantity: item.quantity,
          })),
          tax: nativeResult.tax ?? 0,
          tip: nativeResult.tip ?? 0,
          total: nativeResult.total ?? 0,
          merchantName: nativeResult.merchantName ?? null,
          merchantConfidence: nativeResult.merchantConfidence ?? null,
          date: nativeResult.date ?? null,
          inferredCategory,
          rawText: nativeResult.rawText ?? null,
        };

        successHaptic();
        applyReceiptScanResult(scanResult);
        return;
      }

      const ocrResult = await extractReceiptData(imageUri);
      if (ocrResult.success && ocrResult.parsedData) {
        mediumHaptic();
        const { total, title: extractedTitle, date } = ocrResult.parsedData;
        const normalizedTitle = normalizeScannedMerchantName(extractedTitle, null);

        // Auto-fill fields if empty
        if (total && !amount) {
          setAmount(total.toFixed(2));
        }
        if (normalizedTitle && !title) {
          setTitle(normalizedTitle);
        }

        // Infer category from OCR text
        if (ocrResult.extractedText && category === 'General') {
          const inferredCategory = inferCategoryFromText(ocrResult.extractedText);
          setCategory(inferredCategory);
        }

        Alert.alert(
          'Receipt Scanned',
          `Found: ${total ? `$${total.toFixed(2)}` : 'No total'}${normalizedTitle ? `, ${normalizedTitle}` : ''}`,
          [{ text: 'OK' }]
        );
      } else if (ocrResult.error) {
        Alert.alert('OCR unavailable', ocrResult.error);
      }
    } catch (error) {
      console.error('OCR processing error:', error);
    } finally {
      setIsProcessingOCR(false);
    }
  };

  const handleReceiptScanComplete = (scanResult: ReceiptScannerResult) => {
    setShowReceiptScanner(false);
    successHaptic();
    applyReceiptScanResult(scanResult);
  };

  const handleTakePhoto = async () => {
    setShowReceiptMenu(false);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission required', 'Camera permission is required to take photos.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: false,
      quality: 0.7,
    });

    if (!result.canceled) {
      setReceiptUri(result.assets[0].uri);
      setReceiptType('image');
      setReceiptName('camera_capture.jpg');
    }
  };

  const handlePickDocument = async () => {
    setShowReceiptMenu(false);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'application/pdf'],
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        if (typeof asset.size === 'number' && asset.size > MAX_RECEIPT_FILE_SIZE_BYTES) {
          Alert.alert('File too large', 'Please select a receipt smaller than 20MB.');
          return;
        }

        setReceiptUri(asset.uri);
        setReceiptType(asset.mimeType?.includes('image') ? 'image' : 'document');
        setReceiptName(asset.name);
      }
    } catch (err) {
      console.error('Error picking document:', err);
    }
  };

  const handleSubmit = async () => {
    try {
      const shareMap = Object.fromEntries(participantShares.map((participant) => [participant.userId, participant.share]));
      const finalSplitMetadata: ExpenseSplitMetadata = splitMetadata
        ? {
          ...splitMetadata,
          participantConfig: billSplitParticipants.map((participant) => ({
            userId: participant.id,
            included: participant.included,
            exactAmount: participant.exactAmount,
            percentage: participant.percentage,
            shares: participant.shares,
            adjustment: participant.adjustment,
            incomeWeight: participant.incomeWeight,
            historicalPaid: participant.historicalPaid,
            daysStayed: participant.daysStayed,
            checkInDate: participant.checkInDate,
            checkOutDate: participant.checkOutDate,
            selectedStayDates: participant.selectedStayDates,
            partsConsumed: participant.partsConsumed,
            rouletteWeight: participant.rouletteWeight,
            computedAmount: shareMap[participant.id] ?? participant.computedAmount,
          })),
        }
        : {
          version: 1,
          method: splitType === 'equal' ? 'equal' : 'exact',
          participantConfig: group.members.map((member) => ({
            userId: member.userId,
            included: selectedMembers.includes(member.userId),
            exactAmount: shareMap[member.userId] ?? 0,
            computedAmount: shareMap[member.userId] ?? 0,
          })),
        };

      const expenseData = {
        groupId: group.groupId,
        title,
        category,
        amount: Number(amount),
        paidBy,
        splitType,
        participants: participantShares,
        splitMetadata: finalSplitMetadata,
        settled: false,
        notes: '',
      };

      if (expenseId) {
        const existingExpense = group.expenses.find((e) => e.expenseId === expenseId);
        if (!existingExpense) throw new Error('Expense not found');

        const originalUrl = existingExpense.receipt?.url || null;
        let newImageUriArg: string | null | undefined = undefined;

        if (receiptUri !== originalUrl) {
          newImageUriArg = receiptUri;
        }

        await updateExpense(group.groupId, {
          ...existingExpense,
          ...expenseData,
          notes: existingExpense.notes || '',
          updatedAt: Date.now(),
        }, newImageUriArg, receiptName || undefined);
      } else {
        await addExpense(group.groupId, expenseData, receiptUri || undefined, receiptName || undefined);
      }
      successHaptic();
      onClose();
    } catch (error) {
      console.error('Failed to save expense:', error);
      Alert.alert('Error', 'Failed to save expense. Please try again.');
    }
  };


  return (
    <PaperProvider theme={theme}>
      <LiquidBackground>
        <ScrollView contentContainerStyle={styles.container}>
          <GlassView style={styles.card}>
            <Text variant="headlineMedium" style={[styles.title, { color: theme.colors.onSurface }]}>{expenseId ? 'Edit expense' : 'Add expense'}</Text>

            {isRecurringExpense && (
              <View style={[styles.recurringNote, { backgroundColor: isDark ? 'rgba(100,180,255,0.12)' : 'rgba(33,150,243,0.08)' }]}>
                <Text style={{ color: theme.colors.onSurfaceVariant, fontSize: 13 }}>
                  Editing this occurrence only. Future recurrences will use the original bill settings.
                </Text>
              </View>
            )}

            <FloatingLabelInput
              label="Title"
              value={title}
              onChangeText={setTitle}
              style={styles.field}
            />

            <View style={styles.row}>
              <FloatingLabelInput
                label="Amount"
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                style={styles.field}
                containerStyle={{ flex: 1 }}
                left={<TextInput.Affix text="$" />}
              />
            </View>

            <View style={styles.row}>
              <Menu
                visible={showCategoryMenu}
                onDismiss={() => setShowCategoryMenu(false)}
                anchor={
                  <Button mode="outlined" onPress={() => setShowCategoryMenu(true)} icon={getCategoryIcon(category)} style={{ borderColor: theme.colors.outline }}>
                    {category}
                  </Button>
                }
              >
                {CATEGORIES.map((cat) => (
                  <Menu.Item key={cat} onPress={() => { setCategory(cat); setShowCategoryMenu(false); }} title={cat} leadingIcon={getCategoryIcon(cat)} />
                ))}
              </Menu>

              <Button mode="outlined" onPress={() => setShowPayerDialog(true)} icon="account-cash" style={{ borderColor: theme.colors.outline }}>
                Paid by {memberDisplayNames[paidBy] ?? 'Unknown'}
              </Button>
            </View>

            {/* Smart Receipt Scanner Button */}
            {!expenseId && (
              <TouchableOpacity
                onPress={() => {
                  mediumHaptic();
                  setShowReceiptScanner(true);
                }}
                activeOpacity={0.7}
                style={[styles.scanReceiptBtn, { borderColor: theme.colors.primary }]}
              >
                <View style={styles.scanReceiptBtnContent}>
                  <View style={[styles.scanReceiptIconCircle, { backgroundColor: `${theme.colors.primary}15` }]}>
                    <Icon source="camera-document" size={24} color={theme.colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text variant="labelLarge" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                      Scan Receipt
                    </Text>
                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                      Auto-extract items, tax, tip & total
                    </Text>
                  </View>
                  <Icon source="chevron-right" size={20} color={theme.colors.primary} />
                </View>
              </TouchableOpacity>
            )}

            <View style={styles.field}>
              <Menu
                visible={showReceiptMenu}
                onDismiss={() => setShowReceiptMenu(false)}
                anchor={
                  <Button mode="outlined" icon="paperclip" onPress={() => setShowReceiptMenu(true)} style={{ borderColor: theme.colors.outline }}>
                    {receiptUri ? 'Change Receipt' : 'Add Receipt'}
                  </Button>
                }
              >
                <Menu.Item onPress={handleTakePhoto} title="Take Photo" leadingIcon="camera" />
                <Menu.Item onPress={handlePickImage} title="Choose from Gallery" leadingIcon="image" />
                <Menu.Item onPress={handlePickDocument} title="Upload Document" leadingIcon="file-document" />
              </Menu>

              {receiptUri && (
                <View style={styles.imagePreviewContainer}>
                  {receiptType === 'image' ? (
                    <Image source={{ uri: receiptUri }} style={[styles.imagePreview, { backgroundColor: isDark ? '#333' : '#f0f0f0' }]} resizeMode="contain" />
                  ) : (
                    <View style={[styles.documentPreview, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : '#f0f0f0' }]}>
                      <Text variant="bodyLarge" style={{ marginBottom: 8, color: theme.colors.onSurface }}>📄 {receiptName || 'Document attached'}</Text>
                    </View>
                  )}
                  <Button onPress={() => { setReceiptUri(null); setReceiptType(null); setReceiptName(null); }} textColor={theme.colors.error}>
                    Remove
                  </Button>
                </View>
              )}
            </View>


            {/* Split Options Button */}
            <TouchableOpacity
              onPress={() => {
                if (!title.trim() || !amount.trim() || Number(amount) <= 0) {
                  Alert.alert(
                    'Missing details',
                    'Please enter an expense title and amount before configuring split options.',
                  );
                  return;
                }
                mediumHaptic();
                setShowBillSplit(true);
              }}
              activeOpacity={0.7}
              style={[styles.splitOptionsBtn, { borderColor: theme.colors.outline }]}
            >
              <View style={styles.splitOptionsBtnContent}>
                <Icon source="tune-variant" size={20} color={theme.colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text variant="labelLarge" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                    Split options
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    {splitMethodLabel} · {selectedMembers.length} {selectedMembers.length === 1 ? 'person' : 'people'}
                  </Text>
                </View>
                <Icon source="chevron-right" size={20} color={theme.colors.onSurfaceVariant} />
              </View>
            </TouchableOpacity>

            {/* Split Summary Preview */}
            <View style={styles.splitPreview}>
              <View style={styles.members}>
                {group.members.filter((m) => selectedMembers.includes(m.userId)).map((member) => {
                  const share = participantShares.find((participant) => participant.userId === member.userId)?.share;
                  return (
                    <Chip
                      key={member.userId}
                      style={{ backgroundColor: theme.colors.secondaryContainer }}
                      textStyle={{ color: theme.colors.onSecondaryContainer }}
                    >
                      {member.displayName}{typeof share === 'number' ? ` · ${formatCurrency(share, group.currency)}` : ''}
                    </Chip>
                  );
                })}
              </View>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                Reopen split options any time to adjust the mode, included people, or split inputs.
              </Text>
            </View>

            <View style={styles.actions}>
              <Button mode="outlined" onPress={onClose} style={{ borderColor: theme.colors.outline }}>
                Cancel
              </Button>
              <Button mode="contained" onPress={handleSubmit} disabled={!formValid}>
                Save expense
              </Button>
            </View>
          </GlassView>
        </ScrollView>
      </LiquidBackground>

      {/* Receipt Scanner Modal */}
      <Modal
        visible={showReceiptScanner}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowReceiptScanner(false)}
      >
        {showReceiptScanner && (
          <ReceiptScannerSheet
            onComplete={handleReceiptScanComplete}
            onCancel={() => setShowReceiptScanner(false)}
          />
        )}
      </Modal>

      {/* BillSplit Modal */}
      <Modal
        visible={showBillSplit}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowBillSplit(false)}
      >
        {showBillSplit && (
          <BillSplitScreen
            totalAmount={Number(amount) || 0}
            currency={group.currency || 'USD'}
            initialParticipants={billSplitParticipants}
            initialPayer={paidBy}
            initialSplitMetadata={splitMetadata}
            onDone={handleBillSplitDone}
            onCancel={() => setShowBillSplit(false)}
          />
        )}
      </Modal>

      <Portal>
        <Dialog visible={showPayerDialog} onDismiss={() => setShowPayerDialog(false)} style={{ backgroundColor: theme.colors.surface }}>
          <Dialog.Title style={{ color: theme.colors.onSurface }}>Who paid?</Dialog.Title>
          <Dialog.Content>
            <ScrollView style={{ maxHeight: 300 }}>
              {group.members.map((member) => (
                <TouchableRipple
                  key={member.userId}
                  onPress={() => {
                    setPaidBy(member.userId);
                    setShowPayerDialog(false);
                  }}
                >
                  <View style={styles.payerRow}>
                    <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>{member.displayName}</Text>
                    {paidBy === member.userId && <Text style={{ color: theme.colors.primary }}>Selected</Text>}
                  </View>
                </TouchableRipple>
              ))}
            </ScrollView>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setShowPayerDialog(false)}>Cancel</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </PaperProvider>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 50,
  },
  card: {
    padding: 24,
    borderRadius: 24,
    gap: 12,
  },
  title: {
    textAlign: 'center',
    marginBottom: 12,
  },
  recurringNote: {
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  field: {
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    alignItems: 'center',
  },
  section: {
    marginTop: 8,
    marginBottom: 8,
    fontWeight: 'bold',
  },
  members: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  customSplitContainer: {
    marginTop: 8,
  },
  actions: {
    marginTop: 24,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  scanReceiptBtn: {
    borderWidth: 1.5,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 8,
    borderStyle: 'solid',
  },
  scanReceiptBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  scanReceiptIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  splitOptionsBtn: {
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  splitOptionsBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  splitPreview: {
    marginBottom: 8,
  },
  payerRow: {
    paddingVertical: 12,
    paddingHorizontal: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  imagePreviewContainer: {
    marginTop: 8,
    alignItems: 'center',
  },
  imagePreview: {
    width: '100%',
    height: 200,
    borderRadius: 8,
    marginBottom: 8,
  },
  documentPreview: {
    width: '100%',
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 8,
  },
});
