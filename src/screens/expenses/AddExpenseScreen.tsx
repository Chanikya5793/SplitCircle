import { colors } from '@/constants';
import { useGroups } from '@/context/GroupContext';
import type { Group, ParticipantShare, SplitType } from '@/models';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Chip, SegmentedButtons, Text, TextInput } from 'react-native-paper';

interface AddExpenseScreenProps {
  group: Group;
  onClose: () => void;
}

export const AddExpenseScreen = ({ group, onClose }: AddExpenseScreenProps) => {
  const { addExpense } = useGroups();
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [splitType, setSplitType] = useState<SplitType>('equal');
  const [selectedMembers, setSelectedMembers] = useState<string[]>(group.members.map((member) => member.userId));
  const [customShares, setCustomShares] = useState<Record<string, string>>({});

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
    return selectedMembers.map((userId) => ({ userId, share }));
  }, [amount, customShares, selectedMembers, splitType]);

  const customTotal = participantShares.reduce((sum, entry) => sum + entry.share, 0);
  const matchesAmount = Math.abs(customTotal - (Number(amount) || 0)) < 0.01;

  const formValid = Boolean(
    title &&
      amount &&
      participantShares.length &&
      (splitType !== 'custom' || (participantShares.every((entry) => entry.share > 0) && matchesAmount)),
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

  const handleSubmit = async () => {
    await addExpense(group.groupId, {
      groupId: group.groupId,
      title,
      category: 'General',
      amount: Number(amount),
      paidBy: group.members[0]?.userId ?? '',
      splitType,
      participants: participantShares,
      settled: false,
      notes: '',
      receipt: undefined,
    });
    onClose();
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text variant="headlineMedium">Add expense</Text>
      <TextInput label="Title" value={title} onChangeText={setTitle} style={styles.field} />
      <TextInput label="Amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" style={styles.field} />

      <SegmentedButtons
        value={splitType}
        onValueChange={(value) => setSplitType(value as SplitType)}
        buttons={[
          { label: 'Equal', value: 'equal' },
          { label: 'Custom', value: 'custom' },
        ]}
      />

      <Text variant="titleMedium" style={styles.section}>
        Participants
      </Text>
      <View style={styles.members}>
        {group.members.map((member) => (
          <Chip
            key={member.userId}
            selected={selectedMembers.includes(member.userId)}
            onPress={() => handleToggleMember(member.userId)}
          >
            {member.displayName}
          </Chip>
        ))}
      </View>

      {splitType === 'custom' &&
        selectedMembers.map((userId) => (
          <TextInput
            key={userId}
            label={`Share for ${memberDisplayNames[userId] ?? 'Member'}`}
            value={customShares[userId] ?? ''}
            onChangeText={(value) => handleCustomShareChange(userId, value)}
            keyboardType="decimal-pad"
            style={styles.field}
          />
        ))}

      <View style={styles.actions}>
        <Button mode="outlined" onPress={onClose}>
          Cancel
        </Button>
        <Button mode="contained" onPress={handleSubmit} disabled={!formValid}>
          Save expense
        </Button>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.background,
    padding: 16,
    gap: 12,
  },
  field: {
    marginBottom: 8,
  },
  section: {
    marginTop: 16,
  },
  members: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  actions: {
    marginTop: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
