// Single source of truth for rendering money with semantic color. The audit
// found four different green/red palettes invented across screens for the
// same concept — this kills that class of drift.

import { useTheme } from '@/context/ThemeContext';
import { formatCurrency } from '@/utils/currency';
import React from 'react';
import { StyleProp, TextStyle } from 'react-native';
import { Text } from 'react-native-paper';

export interface MoneyTextProps {
  amount: number;
  currency?: string;
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
  tone = 'auto',
  showSign = false,
  size = 'body',
  style,
  numberOfLines,
}: MoneyTextProps) => {
  const { theme } = useTheme();

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

  const type = theme.typography[size];
  const magnitude = formatCurrency(Math.abs(amount), currency);
  const sign = showSign && amount !== 0 ? (amount > 0 ? '+' : '−') : '';

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
      {sign}
      {magnitude}
    </Text>
  );
};
