import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
import type { Expense } from '@/models';
import { formatCurrency } from '@/utils/currency';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text, TouchableRipple } from 'react-native-paper';
import Animated, { FadeInDown } from 'react-native-reanimated';

interface ExpenseCardProps {
  expense: Expense;
  currency: string;
  memberMap: Record<string, string>;
  onPress: () => void;
  index?: number;
}

export const ExpenseCard = ({ expense, currency, memberMap, onPress, index = 0 }: ExpenseCardProps) => {
  const { theme, isDark } = useTheme();
  const payerName = memberMap[expense.paidBy] || 'Unknown';
  const isSettlement = expense.category === 'Settlement';

  return (
    <Animated.View entering={FadeInDown.delay(index * 50).springify()}>
      <GlassView style={styles.container}>
        <TouchableRipple onPress={onPress} style={{ flex: 1 }}>
          <View style={styles.content}>
            <View style={styles.header}>
              <View style={styles.titleRow}>
                <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>{expense.title}</Text>
                <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
                  {expense.category} · Paid by {payerName}
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {new Date(expense.createdAt).toLocaleDateString()}
                </Text>
              </View>
              <View style={styles.amountContainer}>
                <Text variant="titleLarge" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
                  {formatCurrency(expense.amount, currency)}
                </Text>
                {isSettlement && <IconButton icon="check-circle" size={20} iconColor={theme.colors.primary} />}
              </View>
            </View>
          </View>
        </TouchableRipple>
      </GlassView>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 24,
    marginBottom: 12,
    marginHorizontal: 4,
  },
  content: {
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  titleRow: {
    flex: 1,
    gap: 4,
  },
  subtitle: {
    // color handled dynamically
  },
  amountContainer: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginLeft: 16,
  },
});
