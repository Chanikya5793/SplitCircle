import { GlassView } from '@/components/GlassView';
import { SyncBadge } from '@/components/ui/SyncBadge';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Expense } from '@/models';
import { useMoneyDisplay } from '@/hooks/useMoneyDisplay';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import { getExpenseSplitLabel } from '@/utils/expenseSplit';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text, TouchableRipple } from 'react-native-paper';
import Animated, { SlideInDown } from 'react-native-reanimated';

interface ExpenseCardProps {
  expense: Expense;
  currency: string;
  memberMap: Record<string, string>;
  onPress: () => void;
  index?: number;
  groupId?: string;
}

export const ExpenseCard = ({ expense, currency, memberMap, onPress, index = 0, groupId }: ExpenseCardProps) => {
  const fmtMoney = useMoneyDisplay(groupId);
  const { maskGroupText } = usePrivacyMask();
  const { theme, isDark } = useTheme();
  const { pendingSyncIds } = useGroups();
  const isPendingSync = pendingSyncIds.has(expense.expenseId);
  const payerName = maskGroupText(memberMap[expense.paidBy] || 'Unknown', groupId, 'person');
  const isSettlement = expense.category === 'Settlement';
  const splitLabel = getExpenseSplitLabel(expense);

  return (
    <Animated.View entering={SlideInDown.delay(index * 50).springify()}>
      <GlassView style={styles.container}>
        <TouchableRipple onPress={onPress} style={{ flex: 1 }}>
          <View style={styles.content}>
            <View style={styles.header}>
              <View style={styles.titleRow}>
                <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>{maskGroupText(expense.title, groupId, 'title')}</Text>
                <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
                  {isSettlement
                    ? `${maskGroupText(expense.category, groupId, 'category')} · Paid by ${payerName}`
                    : `${maskGroupText(expense.category, groupId, 'category')} · ${maskGroupText(splitLabel, groupId, 'note')} · Paid by ${payerName}`}
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {maskGroupText(new Date(expense.createdAt).toLocaleDateString(), groupId)}
                </Text>
                {isPendingSync ? <SyncBadge style={{ marginTop: 4 }} /> : null}
              </View>
              <View style={styles.amountContainer}>
                <Text variant="titleLarge" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
                  {fmtMoney(expense.amount, currency)}
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
