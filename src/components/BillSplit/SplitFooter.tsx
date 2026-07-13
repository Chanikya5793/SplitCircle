import { useTheme } from '@/context/ThemeContext';
import { spacing } from '@/theme';
import { formatCurrency, getCurrencySymbol } from '@/utils/currency';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import type { GamifiedMode, Participant, SplitMethod, ValidationResult } from './types';

interface SplitFooterProps {
  totalAmount: number;
  currency: string;
  includedCount: number;
  participants: Participant[];
  currentMethod: SplitMethod;
  validation: ValidationResult;
  gamifiedMode?: GamifiedMode;
  loserId?: string | null;
  isSpinning?: boolean;
  payerName?: string;
  onManagePayer?: () => void;
  onSpin?: () => void;
  onDone?: () => void;
}

/**
 * SplitFooter — one compact docked bar. Its purpose: a live read of the split
 * (the headline figure + who's included) on the left, and the single commit
 * action on the right. No second payer control, no method chip, no duplicate
 * "Done" (the header no longer carries one).
 */
export const SplitFooter = React.memo(({
  totalAmount,
  currency,
  includedCount,
  participants,
  currentMethod,
  validation,
  gamifiedMode,
  loserId,
  isSpinning,
  onDone,
}: SplitFooterProps) => {
  const { theme } = useTheme();
  const included = participants.filter((p) => p.included);
  const allocatedTotal = included.reduce((s, p) => s + p.computedAmount, 0);

  const isGame = currentMethod === 'gamified';
  const gameResolved = isGame && (gamifiedMode === 'roulette' ? Boolean(loserId) : validation.isValid);
  const canDone = !isSpinning && (isGame ? gameResolved : validation.isValid);

  // ── Headline figure (the number people actually want) ────────────────────
  const headline = useMemo(() => {
    if (isGame) {
      if (isSpinning) return 'Spinning…';
      const loser = loserId ? participants.find((p) => p.id === loserId) : null;
      if (gamifiedMode === 'roulette') {
        return loser ? `${loser.name} pays ${formatCurrency(loser.computedAmount, currency)}` : 'Spin to decide';
      }
      if (gamifiedMode === 'weightedRoulette') {
        return validation.isValid ? 'Shares assigned' : 'Spin to assign shares';
      }
      return validation.isValid ? 'Karma applied' : 'Apply the karma split';
    }
    if (currentMethod === 'equal') {
      const per = included.length > 0 ? allocatedTotal / included.length : 0;
      return `${formatCurrency(per, currency)}/person`;
    }
    if (currentMethod === 'itemized') {
      return `${formatCurrency(allocatedTotal, currency)} allocated`;
    }
    // exact / percentage / shares / adjustment / income / consumption / time
    return `${formatCurrency(allocatedTotal, currency)} of ${formatCurrency(totalAmount, currency)}`;
  }, [isGame, isSpinning, loserId, participants, gamifiedMode, validation.isValid, currentMethod, included.length, allocatedTotal, currency, totalAmount]);

  // ── Sub line: inclusion + honest validity (muted mid-game, never red) ─────
  const remaining = totalAmount - allocatedTotal;
  const sub = useMemo(() => {
    if (isGame && !validation.isValid) {
      return `${includedCount} ${includedCount === 1 ? 'player' : 'players'} · tap the wheel`;
    }
    if (!validation.isValid && !isGame) {
      if (remaining > 0.01) return `${getCurrencySymbol(currency)}${remaining.toFixed(2)} left to assign`;
      if (remaining < -0.01) return `${getCurrencySymbol(currency)}${Math.abs(remaining).toFixed(2)} over`;
      return validation.message;
    }
    return `${includedCount} of ${participants.length} included`;
  }, [isGame, validation.isValid, validation.message, remaining, currency, includedCount, participants.length]);

  const subColor = !validation.isValid && !isGame ? theme.colors.danger : theme.colors.muted;
  const ctaLabel = isSpinning ? 'Spinning…' : isGame && !gameResolved ? 'Spin' : 'Done';

  return (
    <View style={[
      styles.footer,
      {
        backgroundColor: theme.dark ? 'rgba(18,20,26,0.98)' : 'rgba(255,255,255,0.98)',
        borderTopColor: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)',
      },
    ]}>
      <View style={styles.summary}>
        <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '800' }} numberOfLines={1}>
          {headline}
        </Text>
        <Text variant="bodySmall" style={{ color: subColor }} numberOfLines={1}>
          {sub}
        </Text>
      </View>

      <Pressable
        onPress={canDone ? onDone : undefined}
        disabled={!canDone}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.cta,
          {
            backgroundColor: canDone ? theme.colors.primary : theme.colors.pressed,
            opacity: pressed && canDone ? 0.85 : 1,
          },
        ]}
      >
        <Icon source={canDone ? 'check' : 'gesture-tap'} size={17} color={canDone ? '#FFF' : theme.colors.muted} />
        <Text style={{ color: canDone ? '#FFF' : theme.colors.muted, fontSize: 15, fontWeight: '800' }}>
          {ctaLabel}
        </Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingTop: 10,
    paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  summary: {
    flex: 1,
    gap: 1,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minWidth: 108,
    height: 46,
    borderRadius: 23,
    paddingHorizontal: 20,
  },
});
