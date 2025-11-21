import { colors } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import type { Group, ParticipantShare, SplitType } from '@/models';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Image, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Chip, Dialog, HelperText, Menu, Portal, SegmentedButtons, Text, TextInput, TouchableRipple } from 'react-native-paper';

interface AddExpenseScreenProps {
  group: Group;
  expenseId?: string;
  onClose: () => void;
}

const CATEGORIES = ['General', 'Food', 'Transport', 'Utilities', 'Entertainment', 'Shopping', 'Travel', 'Health'];

export const AddExpenseScreen = ({ group, expenseId, onClose }: AddExpenseScreenProps) => {
  const { user } = useAuth();
  const { addExpense, updateExpense } = useGroups();
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('General');
  const [paidBy, setPaidBy] = useState(user?.userId ?? group.members[0]?.userId ?? '');
  const [splitType, setSplitType] = useState<SplitType>('equal');
  const [selectedMembers, setSelectedMembers] = useState<string[]>(group.members.map((member) => member.userId));
  const [customShares, setCustomShares] = useState<Record<string, string>>({});
  const [imageUri, setImageUri] = useState<string | null>(null);

  const [showPayerDialog, setShowPayerDialog] = useState(false);
  const [showCategoryMenu, setShowCategoryMenu] = useState(false);

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
        setImageUri(expense.receipt?.url || null);

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
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.7,
    });

    if (!result.canceled) {
      setImageUri(result.assets[0].uri);
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
        
        if (imageUri !== originalUrl) {
          newImageUriArg = imageUri;
        }

        await updateExpense(group.groupId, {
          ...existingExpense,
          ...expenseData,
          notes: existingExpense.notes || '',
          updatedAt: Date.now(),
        }, newImageUriArg);
      } else {
        await addExpense(group.groupId, expenseData, imageUri || undefined);
      }
      onClose();
    } catch (error) {
      console.error('Failed to save expense:', error);
      Alert.alert('Error', 'Failed to save expense. Please try again.');
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text variant="headlineMedium">{expenseId ? 'Edit expense' : 'Add expense'}</Text>
      
      <TextInput label="Title" value={title} onChangeText={setTitle} style={styles.field} />
      
      <View style={styles.row}>
        <TextInput 
          label="Amount" 
          value={amount} 
          onChangeText={setAmount} 
          keyboardType="decimal-pad" 
          style={[styles.field, { flex: 1 }]} 
          left={<TextInput.Affix text="$" />}
        />
      </View>

      <View style={styles.row}>
        <Menu
          visible={showCategoryMenu}
          onDismiss={() => setShowCategoryMenu(false)}
          anchor={
            <Button mode="outlined" onPress={() => setShowCategoryMenu(true)} icon="tag">
              {category}
            </Button>
          }
        >
          {CATEGORIES.map((cat) => (
            <Menu.Item key={cat} onPress={() => { setCategory(cat); setShowCategoryMenu(false); }} title={cat} />
          ))}
        </Menu>

        <Button mode="outlined" onPress={() => setShowPayerDialog(true)} icon="account-cash">
          Paid by {memberDisplayNames[paidBy] ?? 'Unknown'}
        </Button>
      </View>

      <View style={styles.field}>
        <Button mode="outlined" icon="camera" onPress={handlePickImage}>
          {imageUri ? 'Change Receipt' : 'Add Receipt'}
        </Button>
        {imageUri && (
          <View style={styles.imagePreviewContainer}>
            <Image source={{ uri: imageUri }} style={styles.imagePreview} />
            <Button onPress={() => setImageUri(null)} textColor={colors.danger}>Remove</Button>
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


      <Text variant="titleMedium" style={styles.section}>
        Split with
      </Text>
      <View style={styles.members}>
        {group.members.map((member) => (
          <Chip
            key={member.userId}
            selected={selectedMembers.includes(member.userId)}
            onPress={() => handleToggleMember(member.userId)}
            showSelectedOverlay
          >
            {member.displayName}
          </Chip>
        ))}
      </View>

      {splitType === 'custom' && (
        <View style={styles.customSplitContainer}>
          <Text variant="bodyMedium" style={{ marginBottom: 8 }}>
            Remaining: ${(Number(amount) - customTotal).toFixed(2)}
          </Text>
          {selectedMembers.map((userId) => (
            <TextInput
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
        <Button mode="outlined" onPress={onClose}>
          Cancel
        </Button>
        <Button mode="contained" onPress={handleSubmit} disabled={!formValid}>
          Save expense
        </Button>
      </View>

      <Portal>
        <Dialog visible={showPayerDialog} onDismiss={() => setShowPayerDialog(false)}>
          <Dialog.Title>Who paid?</Dialog.Title>
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
                    <Text variant="bodyLarge">{member.displayName}</Text>
                    {paidBy === member.userId && <Text style={{ color: colors.primary }}>Selected</Text>}
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
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.background,
    padding: 16,
    gap: 12,
    paddingBottom: 50,
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
});
