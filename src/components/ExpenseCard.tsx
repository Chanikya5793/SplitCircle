import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
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
  const { theme } = useTheme();
  const payerName = memberMap[expense.paidBy] || 'Unknown';

  return (
    <TouchableRipple onPress={onPress} style={styles.touchable}>
      <GlassView style={styles.container}>
        <View style={styles.row}>
          <View style={styles.meta}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>{expense.title}</Text>
            <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
              {expense.category} · Paid by {payerName}
            </Text>
            <Text variant="bodySmall" style={[styles.date, { color: theme.colors.onSurfaceVariant }]}>
              {formatRelativeTime(expense.createdAt)}
            </Text>
          </View>
          <View style={styles.amountContainer}>
            <Text variant="titleMedium" style={[styles.amount, { color: theme.colors.onSurface }]}>
              {formatCurrency(expense.amount, currency)}
            </Text>
            {onEdit && <IconButton icon="pencil" size={18} onPress={onEdit} accessibilityLabel="Edit expense" iconColor={theme.colors.onSurfaceVariant} />}
          </View>
        </View>
      </GlassView>
    </TouchableRipple>
  );
};

const styles = StyleSheet.create({
  touchable: {
    borderRadius: 12,
    marginBottom: 12,
  },
  container: {
    borderRadius: 12,
    padding: 16,
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
    marginTop: 2,
  },
  date: {
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
