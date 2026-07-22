// Single source of truth for rendering money with semantic color. The audit
// found four different green/red palettes invented across screens for the
// same concept — this kills that class of drift.

import { useDisplayCurrency } from '@/context/DisplayCurrencyContext';
import { useTheme } from '@/context/ThemeContext';
import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { decoyAmount } from '@/services/privacyGuardService';
import { formatCurrency } from '@/utils/currency';
import React from 'react';
import { StyleProp, TextStyle } from 'react-native';
import { Text } from 'react-native-paper';

export interface MoneyTextProps {
  amount: number;
  currency?: string;
  /**
   * Expense-group id. When set, the group's display-currency lens applies:
   * the amount renders converted (with a "≈" marker) while the lens is on.
   */
  groupId?: string;
  /**
   * Semantic direction. 'auto' colors by the sign of `amount`
   * (positive → owed to you, negative → you owe, zero → settled).
   */
  tone?: 'auto' | 'positive' | 'negative' | 'neutral' | 'plain';
  /** Prefix +/- for non-zero amounts. */
  showSign?: boolean;
  size?: 'body' | 'subtitle' | 'title' | 'headline';
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}

export const MoneyText = ({
  amount,
  currency = 'USD',
  groupId,
  tone = 'auto',
  showSign = false,
  size = 'body',
  style,
  numberOfLines,
}: MoneyTextProps) => {
  const { theme } = useTheme();
  const { getConversion } = useDisplayCurrency();

  const conversion = groupId ? getConversion(groupId, currency) : null;
  const displayAmount = conversion ? amount * conversion.rate : amount;
  const displayCurrency = conversion ? conversion.target : currency;

  const resolvedTone =
    tone === 'auto' ? (amount > 0 ? 'positive' : amount < 0 ? 'negative' : 'neutral') : tone;

  const color =
    resolvedTone === 'positive'
      ? theme.colors.moneyPositive
      : resolvedTone === 'negative'
        ? theme.colors.moneyNegative
        : resolvedTone === 'neutral'
          ? theme.colors.moneyNeutral
          : theme.colors.onSurface;

  // Privacy guard: every amount in the app funnels through here, so one
  // check scrambles them all when the "expenses" shield is tripped. Mirrors
  // useMoneyDisplay's branch order exactly — the same guard-aware formatter
  // every other money-rendering component (BalanceSummary, DebtsList,
  // ExpenseCard, SettlementCard, ...) already uses. Duress MUST show a
  // believable scaled decoy, never the dots/blocks placeholder: an obvious
  // "hidden" marker immediately tips off a coercer that something's hidden,
  // defeating the whole point of the fake-unlock decoy world.
  const { isShielded, action, duress, settings } = usePrivacyGuard();
  const scrambleAmounts = isShielded('expenses', groupId);

  const type = theme.typography[size];
  const magnitude = !scrambleAmounts
    ? formatCurrency(Math.abs(displayAmount), displayCurrency)
    : duress
      ? formatCurrency(decoyAmount(Math.abs(displayAmount), groupId ?? 'global'), displayCurrency)
      : action === 'vanish'
        ? '···'
        : settings.amountStyle === 'zeros'
          ? formatCurrency(0, displayCurrency)
          : settings.amountStyle === 'decoy'
            ? formatCurrency(decoyAmount(Math.abs(displayAmount), groupId ?? 'global'), displayCurrency)
            : '••••';
  const sign = !scrambleAmounts && showSign && amount !== 0 ? (amount > 0 ? '+' : '−') : '';
  const approx = !scrambleAmounts && conversion ? '≈' : '';

  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        {
          color,
          fontSize: type.fontSize,
          lineHeight: type.lineHeight,
          fontWeight: '600',
          fontVariant: ['tabular-nums'],
        },
        style,
      ]}
    >
      {approx}
      {sign}
      {magnitude}
    </Text>
  );
};
