import { colors } from '@/constants';
import type { Expense } from '@/models';
import { formatCurrency } from '@/utils/currency';
import { formatRelativeTime } from '@/utils/format';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text } from 'react-native-paper';

interface ExpenseCardProps {
  expense: Expense;
  currency: string;
  onEdit?: () => void;
}

export const ExpenseCard = ({ expense, currency, onEdit }: ExpenseCardProps) => (
  <View style={styles.container}>
    <View style={styles.row}>
      <View style={styles.meta}>
        <Text variant="titleMedium">{expense.title}</Text>
        <Text variant="bodySmall" style={styles.subtitle}>
          Paid by {expense.paidBy} · {formatRelativeTime(expense.createdAt)}
        </Text>
      </View>
      <Text variant="titleMedium">{formatCurrency(expense.amount, currency)}</Text>
      {onEdit && <IconButton icon="pencil" size={18} onPress={onEdit} accessibilityLabel="Edit expense" />}
    </View>
  </View>
);

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  meta: {
    flex: 1,
  },
  subtitle: {
    color: colors.muted,
    marginTop: 4,
  },
});
