import { BalanceSummary } from '@/components/BalanceSummary';
import { ExpenseCard } from '@/components/ExpenseCard';
import { colors } from '@/constants';
import type { Group } from '@/models';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-paper';

interface GroupDetailsScreenProps {
  group: Group;
  onAddExpense: (group: Group) => void;
  onSettle: (group: Group) => void;
  onOpenChat: (group: Group) => void;
}

export const GroupDetailsScreen = ({ group, onAddExpense, onSettle, onOpenChat }: GroupDetailsScreenProps) => (
  <ScrollView contentContainerStyle={styles.container}>
    <View style={styles.header}>
      <Text variant="headlineMedium">{group.name}</Text>
      <Text variant="bodyMedium" style={styles.subtitle}>
        Invite code {group.inviteCode}
      </Text>
    </View>

    <BalanceSummary group={group} />

    <Text variant="titleMedium" style={styles.section}>
      Recent expenses
    </Text>
    {group.expenses.length === 0 ? (
      <Text style={styles.empty}>No expenses yet.</Text>
    ) : (
      group.expenses.map((expense) => (
        <ExpenseCard key={expense.expenseId} expense={expense} currency={group.currency} />
      ))
    )}

    <View style={styles.actions}>
      <Button mode="contained" onPress={() => onAddExpense(group)}>
        Add expense
      </Button>
      <Button mode="outlined" onPress={() => onSettle(group)}>
        Settle up
      </Button>
    </View>
    <Button mode="outlined" icon="chat" onPress={() => onOpenChat(group)} style={styles.chatButton}>
      Open group chat
    </Button>
  </ScrollView>
);

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: colors.background,
    gap: 16,
  },
  header: {
    marginBottom: 12,
  },
  subtitle: {
    color: colors.muted,
  },
  section: {
    marginTop: 24,
    marginBottom: 12,
  },
  empty: {
    color: colors.muted,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
  },
  chatButton: {
    marginTop: 12,
  },
});
