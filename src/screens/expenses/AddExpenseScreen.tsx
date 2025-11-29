import { FloatingLabelInput } from '@/components/FloatingLabelInput';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Group, ParticipantShare, SplitType } from '@/models';
import { useNavigation } from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Alert, Image, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Chip, Dialog, HelperText, Menu, PaperProvider, Portal, SegmentedButtons, Text, TextInput, TouchableRipple } from 'react-native-paper';

interface AddExpenseScreenProps {
  group: Group;
  expenseId?: string;
  onClose: () => void;
}

const CATEGORIES = ['General', 'Food', 'Transport', 'Utilities', 'Entertainment', 'Shopping', 'Travel', 'Health'];

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
  const [receiptUri, setReceiptUri] = useState<string | null>(null);
  const [receiptType, setReceiptType] = useState<'image' | 'document' | null>(null);
  const [receiptName, setReceiptName] = useState<string | null>(null);

  const [showPayerDialog, setShowPayerDialog] = useState(false);
  const [showCategoryMenu, setShowCategoryMenu] = useState(false);
  const [showReceiptMenu, setShowReceiptMenu] = useState(false);

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

        if (expense.receipt?.url) {
          setReceiptUri(expense.receipt.url);
          // Infer type from filename or extension if possible, default to image for backward compat
          const isPdf = expense.receipt.fileName?.toLowerCase().endsWith('.pdf');
          setReceiptType(isPdf ? 'document' : 'image');
          setReceiptName(expense.receipt.fileName || 'Receipt');
        }

        if (expense.splitType === 'custom') {
          const shares: Record<string, string> = {};
          expense.participants.forEach((p) => {
            shares[p.userId] = p.share.toString();
          });
          setCustomShares(shares);
        }
      }
    }
  }, [expenseId, group.expenses]);


  const memberDisplayNames = useMemo(
    () => Object.fromEntries(group.members.map((member) => [member.userId, member.displayName])),
    [group.members],
  );

  const participantShares = useMemo<ParticipantShare[]>(() => {
    const numericAmount = Number(amount) || 0;
    if (!numericAmount || selectedMembers.length === 0) {
      return [];
    }
    if (splitType === 'custom') {
      return selectedMembers.map((userId) => ({ userId, share: Number(customShares[userId] || '0') }));
    }
    const share = Number((numericAmount / selectedMembers.length).toFixed(2));
    // Adjust for rounding errors on the last person
    const totalCalculated = share * selectedMembers.length;
    const diff = numericAmount - totalCalculated;

    return selectedMembers.map((userId, index) => ({
      userId,
      share: index === selectedMembers.length - 1 ? Number((share + diff).toFixed(2)) : share
    }));
  }, [amount, customShares, selectedMembers, splitType]);

  const customTotal = participantShares.reduce((sum, entry) => sum + entry.share, 0);
  const matchesAmount = Math.abs(customTotal - (Number(amount) || 0)) < 0.01;

  const formValid = Boolean(
    title &&
    amount &&
    participantShares.length &&
    (splitType !== 'custom' || (participantShares.every((entry) => entry.share >= 0) && matchesAmount))
  );

  const handleToggleMember = (userId: string) => {
    setSelectedMembers((prev) => {
      if (prev.includes(userId)) {
        setCustomShares((shares) => {
          const next = { ...shares };
          delete next[userId];
          return next;
        });
        return prev.filter((id) => id !== userId);
      }
      return [...prev, userId];
    });
  };

  const handleCustomShareChange = (userId: string, value: string) => {
    setCustomShares((prev) => ({ ...prev, [userId]: value }));
  };

  const handlePickImage = async () => {
    setShowReceiptMenu(false);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.7,
    });

    if (!result.canceled) {
      setReceiptUri(result.assets[0].uri);
      setReceiptType('image');
      setReceiptName(result.assets[0].fileName || 'image.jpg');
    }
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
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
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
      const expenseData = {
        groupId: group.groupId,
        title,
        category,
        amount: Number(amount),
        paidBy,
        splitType,
        participants: participantShares,
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
                  <Button mode="outlined" onPress={() => setShowCategoryMenu(true)} icon="tag" style={{ borderColor: theme.colors.outline }}>
                    {category}
                  </Button>
                }
              >
                {CATEGORIES.map((cat) => (
                  <Menu.Item key={cat} onPress={() => { setCategory(cat); setShowCategoryMenu(false); }} title={cat} />
                ))}
              </Menu>

              <Button mode="outlined" onPress={() => setShowPayerDialog(true)} icon="account-cash" style={{ borderColor: theme.colors.outline }}>
                Paid by {memberDisplayNames[paidBy] ?? 'Unknown'}
              </Button>
            </View>

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


            <SegmentedButtons
              value={splitType}
              onValueChange={(value) => setSplitType(value as SplitType)}
              buttons={[
                { label: 'Equal', value: 'equal' },
                { label: 'Custom', value: 'custom' },
              ]}
              style={styles.field}
            />


            <Text variant="titleMedium" style={[styles.section, { color: theme.colors.onSurface }]}>
              Split with
            </Text>
            <View style={styles.members}>
              {group.members.map((member) => (
                <Chip
                  key={member.userId}
                  selected={selectedMembers.includes(member.userId)}
                  onPress={() => handleToggleMember(member.userId)}
                  showSelectedOverlay
                  style={{ backgroundColor: selectedMembers.includes(member.userId) ? theme.colors.secondaryContainer : undefined }}
                  textStyle={{ color: selectedMembers.includes(member.userId) ? theme.colors.onSecondaryContainer : theme.colors.onSurface }}
                >
                  {member.displayName}
                </Chip>
              ))}
            </View>

            {splitType === 'custom' && (
              <View style={styles.customSplitContainer}>
                <Text variant="bodyMedium" style={{ marginBottom: 8, color: theme.colors.onSurface }}>
                  Remaining: ${(Number(amount) - customTotal).toFixed(2)}
                </Text>
                {selectedMembers.map((userId) => (
                  <FloatingLabelInput
                    key={userId}
                    label={`Share for ${memberDisplayNames[userId] ?? 'Member'}`}
                    value={customShares[userId] ?? ''}
                    onChangeText={(value) => handleCustomShareChange(userId, value)}
                    keyboardType="decimal-pad"
                    style={styles.field}
                    error={!matchesAmount}
                  />
                ))}
                {!matchesAmount && (
                  <HelperText type="error" visible={!matchesAmount}>
                    Total must match the expense amount
                  </HelperText>
                )}
              </View>
            )}

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
