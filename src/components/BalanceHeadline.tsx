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
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
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
  /** Larger per-currency balances for the Expenses overview. */
  prominent?: boolean;
  style?: object;
}

export const BalanceHeadline = ({ groupIds, prominent = false, style }: BalanceHeadlineProps) => {
  const { theme } = useTheme();
  const { user } = useAuth();
  const { groups, loading } = useGroups();
  const { isShielded, isVanished, duress } = usePrivacyGuard();

  const scoped = useMemo(
    () => (groupIds ? groups.filter((g) => groupIds.includes(g.groupId)) : groups),
    [groups, groupIds],
  );

  // Hidden groups are excluded — a hidden 1:1 ledger must not surface its
  // balance on a screen the user can hand to someone else.
  // In duress the shielded groups ARE shown (as the decoy ledger useGroups
  // supplies) — leaving them out made this read "You're all settled up" above
  // rows that each show money owed. Only vanished groups stay out.
  const visible = useMemo(
    () => scoped.filter((g) => !g.hidden && (duress ? !isVanished('expenses', g.groupId) : !isShielded('expenses', g.groupId))),
    [scoped, isShielded, isVanished, duress],
  );

  const totals = useMemo(
    () => computeOverallBalance(user?.userId, visible),
    [user?.userId, visible],
  );
  const { owed, owing } = useMemo(() => splitOwedAndOwing(totals), [totals]);

  // Outside the decoy state, do not imply all-settled when every balance is protected.
  if (!duress && scoped.some((g) => !g.hidden && isShielded('expenses', g.groupId)) && visible.length === 0) return null;

  if (prominent) {
    // Keep cached balances visible during refresh, but an empty cold-start
    // cache cannot establish that the user is settled up.
    if (loading && groups.length === 0) {
      return (
        <View style={[styles.wrap, style]} accessibilityState={{ busy: true }}>
          <Text style={[theme.typography.body, { color: theme.colors.onSurfaceVariant }]}>
            Loading balances…
          </Text>
        </View>
      );
    }

    if (owed.length === 0 && owing.length === 0) {
      return (
        <View style={[styles.wrap, style]}>
          <Text style={[theme.typography.headline, { color: theme.colors.moneyNeutral }]}>
            You're all settled up
          </Text>
        </View>
      );
    }

    return (
      <View style={[styles.wrap, { gap: theme.spacing.md }, style]}>
        {[
          { label: 'You are owed', amounts: owed, color: theme.colors.moneyPositive },
          { label: 'You owe', amounts: owing, color: theme.colors.moneyNegative },
        ].flatMap(({ label, amounts, color }) => amounts.map((total) => (
          <View
            key={`${label}-${total.currency}`}
            accessible
            accessibilityRole="summary"
            accessibilityLabel={`${label} ${formatCurrency(total.amount, total.currency)}, ${total.currency}`}
            style={{ gap: theme.spacing.xs }}
          >
            <Text style={[theme.typography.body, { color: theme.colors.onSurfaceVariant }]}>
              {label} · {total.currency}
            </Text>
            <Text style={[theme.typography.headline, styles.prominentAmount, { color }]}>
              {formatCurrency(total.amount, total.currency)}
            </Text>
          </View>
        )))}
      </View>
    );
  }

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
  prominentAmount: {
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
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
