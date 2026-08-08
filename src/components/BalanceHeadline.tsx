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
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          You are owed{' '}
          <Text style={[styles.amount, { color: theme.colors.moneyPositive }]}>
            {joinAmounts(owed)}
          </Text>
        </Text>
      )}
      {owing.length > 0 && (
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          You owe{' '}
          <Text style={[styles.amount, { color: theme.colors.moneyNegative }]}>
            {joinAmounts(owing)}
          </Text>
        </Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    gap: 2,
    paddingBottom: 4,
  },
  /** The amount is a NESTED Text inside the label, not a sibling in a flex row.
   *
   *  It reads as one phrase either way — "You are owed $799.32", with the weight
   *  and the money colour carrying the emphasis — but nesting makes it a single
   *  text flow, so it wraps across lines like a sentence and CANNOT clip. As a
   *  flex row it could, and did: on a 402pt iPhone at iOS's XXL text size, with
   *  two currencies to show, the line overflowed the screen and was cut
   *  mid-word — "You are owe ₹6,717.44 · $3,617". Money is the number this
   *  screen exists for; it must never be the thing that gets truncated. */
  amount: {
    fontWeight: '700',
  },
});
