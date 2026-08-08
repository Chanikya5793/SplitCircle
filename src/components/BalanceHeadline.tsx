// "You are owed / you owe" across every group, for the top of the Expenses
// and Friends screens.
//
// Computed ON DEVICE (utils/myBalance.ts) from the expenses and settlements
// already held by GroupContext — no Firebase read, no server-maintained
// aggregate, and correct offline the instant an expense is added.
//
// Multi-currency is shown as separate lines, never summed: adding ₹ to $
// without a rate would be a fabricated number, and this is the first thing
// the user sees on opening the app.

import { useAuth } from '@/context/AuthContext';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import { formatCurrency } from '@/utils/currency';
import { computeOverallBalance, splitOwedAndOwing, type CurrencyTotal } from '@/utils/myBalance';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

const joinAmounts = (totals: CurrencyTotal[]) =>
  totals.map((t) => formatCurrency(t.amount, t.currency)).join(' · ');

export interface BalanceHeadlineProps {
  /** Restrict to these groups. Omit for every group the user is in. */
  groupIds?: string[];
  style?: object;
}

export const BalanceHeadline = ({ groupIds, style }: BalanceHeadlineProps) => {
  const { theme } = useTheme();
  const { user } = useAuth();
  const { groups } = useGroups();

  const scoped = useMemo(
    () => (groupIds ? groups.filter((g) => groupIds.includes(g.groupId)) : groups),
    [groups, groupIds],
  );

  // Hidden groups are excluded — a hidden 1:1 ledger must not surface its
  // balance on a screen the user can hand to someone else.
  const visible = useMemo(() => scoped.filter((g) => !g.hidden), [scoped]);

  const totals = useMemo(
    () => computeOverallBalance(user?.userId, visible),
    [user?.userId, visible],
  );
  const { owed, owing } = useMemo(() => splitOwedAndOwing(totals), [totals]);

  if (owed.length === 0 && owing.length === 0) {
    return (
      <View style={[styles.wrap, style]}>
        <Text variant="bodyMedium" style={{ color: theme.colors.moneyNeutral }}>
          You're all settled up
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, style]} accessible accessibilityRole="summary">
      {owed.length > 0 && (
        <View style={styles.line}>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            You are owed
          </Text>
          <Text variant="titleMedium" style={[styles.amount, { color: theme.colors.moneyPositive }]}>
            {joinAmounts(owed)}
          </Text>
        </View>
      )}
      {owing.length > 0 && (
        <View style={styles.line}>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            You owe
          </Text>
          <Text variant="titleMedium" style={[styles.amount, { color: theme.colors.moneyNegative }]}>
            {joinAmounts(owing)}
          </Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    gap: 6,
    paddingBottom: 4,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  amount: {
    fontWeight: '700',
    flexShrink: 1,
    textAlign: 'right',
  },
});
