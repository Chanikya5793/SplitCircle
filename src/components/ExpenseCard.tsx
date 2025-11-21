import { colors } from '@/constants';
import type { Expense } from '@/models';
import { formatCurrency } from '@/utils/currency';
import { formatRelativeTime } from '@/utils/format';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text, TouchableRipple } from 'react-native-paper';

interface ExpenseCardProps {
  expense: Expense;
  currency: string;
  memberMap: Record<string, string>;
  onEdit?: () => void;
  onPress?: () => void;
}

export const ExpenseCard = ({ expense, currency, memberMap, onEdit, onPress }: ExpenseCardProps) => {
  const payerName = memberMap[expense.paidBy] || 'Unknown';

  return (
    <TouchableRipple onPress={onPress} style={styles.touchable}>
      <View style={styles.container}>
        <View style={styles.row}>
          <View style={styles.meta}>
            <Text variant="titleMedium">{expense.title}</Text>
            <Text variant="bodySmall" style={styles.subtitle}>
              {expense.category} · Paid by {payerName}
            </Text>
            <Text variant="bodySmall" style={styles.date}>
              {formatRelativeTime(expense.createdAt)}
            </Text>
          </View>
          <View style={styles.amountContainer}>
            <Text variant="titleMedium" style={styles.amount}>
              {formatCurrency(expense.amount, currency)}
            </Text>
            {onEdit && <IconButton icon="pencil" size={18} onPress={onEdit} accessibilityLabel="Edit expense" />}
          </View>
        </View>
      </View>
    </TouchableRipple>
  );
};

const styles = StyleSheet.create({
  touchable: {
    borderRadius: 12,
    marginBottom: 12,
  },
  container: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    elevation: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  meta: {
    flex: 1,
  },
  subtitle: {
    color: colors.muted,
    marginTop: 2,
  },
  date: {
    color: colors.muted,
    fontSize: 10,
    marginTop: 2,
  },
  amountContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  amount: {
    fontWeight: 'bold',
  },
});
