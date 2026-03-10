import { GlassView } from '@/components/GlassView';
import { colors, darkColors, spacing } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import { formatCurrency } from '@/utils/currency';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import Animated, { FadeInUp } from 'react-native-reanimated';
import type { ValidationResult } from './types';

interface SplitFooterProps {
  totalAmount: number;
  currency: string;
  includedCount: number;
  perPersonAmount: number;
  validation: ValidationResult;
}

export const SplitFooter = React.memo(({
  totalAmount,
  currency,
  includedCount,
  perPersonAmount,
  validation,
}: SplitFooterProps) => {
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;

  return (
    <Animated.View entering={FadeInUp.springify()}>
      <GlassView style={styles.footer} intensity={40}>
        <View style={styles.footerContent}>
          <View style={styles.footerLeft}>
            <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.onSurface }]}>
              {formatCurrency(perPersonAmount, currency)}/person
            </Text>
            <Text variant="bodySmall" style={{ color: palette.muted }}>
              {includedCount} {includedCount === 1 ? 'person' : 'people'} · Total {formatCurrency(totalAmount, currency)}
            </Text>
          </View>

          {!validation.isValid && (
            <View style={styles.validationBadge}>
              <Text style={styles.validationText}>
                {validation.message}
              </Text>
            </View>
          )}

          {validation.isValid && (
            <View style={[styles.validBadge, { backgroundColor: `${colors.success}20` }]}>
              <Text style={[styles.validText, { color: colors.success }]}>✓ Balanced</Text>
            </View>
          )}
        </View>
      </GlassView>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  footer: {
    borderRadius: 20,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  footerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  footerLeft: {
    gap: 2,
  },
  totalLabel: {
    fontWeight: '700',
  },
  validationBadge: {
    backgroundColor: 'rgba(224, 60, 49, 0.12)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  validationText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
  },
  validBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  validText: {
    fontSize: 12,
    fontWeight: '700',
  },
});
