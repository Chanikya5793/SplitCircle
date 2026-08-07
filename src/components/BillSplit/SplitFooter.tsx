import { GlassCard } from '@/components/ui';
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
  onSpin,
  onDone,
}: SplitFooterProps) => {
  const { theme } = useTheme();
  const included = participants.filter((p) => p.included);
  const allocatedTotal = included.reduce((s, p) => s + p.computedAmount, 0);

  const isGame = currentMethod === 'gamified';
  // Only plain roulette's spin is safe to trigger from the footer — it's the
  // same computeRoulette() call the animated wheel's own hub uses. Weighted
  // roulette's real game is AdvancedModeContent's WeightedRouletteWheel, with
  // its own hub-driven percentage draws (handleWeightedSpin/onWeightedComplete);
  // routing the footer's CTA there too used to fire a different, unrelated
  // single-loser algorithm (computeWeightedRoulette) that could silently
  // overwrite a split still visibly in progress on the wheel. Weighted
  // roulette is treated like karma below: play on its own control, footer
  // just commits once it's done.
  const isWheel = isGame && gamifiedMode === 'roulette';
  const isKarma = isGame && gamifiedMode === 'scrooge';
  const gameResolved = isGame && (gamifiedMode === 'roulette' ? Boolean(loserId) : validation.isValid);
  // The footer's CTA is a *working* button, never a dead disabled one:
  //  • an un-landed ROULETTE wheel → it spins (same trigger as the hub);
  //  • weighted roulette / karma are played on their own control, so the
  //    footer just commits once they're resolved;
  //  • otherwise it's Done, enabled only once the split is valid.
  const canSpin = isWheel && !gameResolved && !isSpinning;
  const canDone = !isSpinning && (isGame ? gameResolved : validation.isValid);
  const ctaEnabled = canSpin || canDone;
  const onCta = canSpin ? onSpin : canDone ? onDone : undefined;

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
      if (isKarma) return 'Set the karma below to finish';
      return `${includedCount} ${includedCount === 1 ? 'player' : 'players'} · tap Spin`;
    }
    if (!validation.isValid && !isGame) {
      if (remaining > 0.01) return `${getCurrencySymbol(currency)}${remaining.toFixed(2)} left to assign`;
      if (remaining < -0.01) return `${getCurrencySymbol(currency)}${Math.abs(remaining).toFixed(2)} over`;
      return validation.message;
    }
    return `${includedCount} of ${participants.length} included`;
  }, [isGame, isKarma, validation.isValid, validation.message, remaining, currency, includedCount, participants.length]);

  const subColor = !validation.isValid && !isGame ? theme.colors.danger : theme.colors.muted;
  const ctaLabel = isSpinning ? 'Spinning…' : canSpin ? 'Spin' : 'Done';
  const ctaIcon = isSpinning ? 'timer-sand' : canSpin ? 'rotate-right' : 'check';

  return (
    <GlassCard role="floating" style={styles.footerGlass} contentStyle={styles.footer}>
      <View style={styles.summary}>
        <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '800' }} numberOfLines={1}>
          {headline}
        </Text>
        <Text variant="bodySmall" style={{ color: subColor }} numberOfLines={1}>
          {sub}
        </Text>
      </View>

      <Pressable
        onPress={onCta}
        disabled={!ctaEnabled}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.cta,
          {
            backgroundColor: ctaEnabled ? theme.colors.primary : theme.colors.pressed,
            opacity: pressed && ctaEnabled ? 0.85 : 1,
          },
        ]}
      >
        <Icon source={ctaIcon} size={17} color={ctaEnabled ? '#FFF' : theme.colors.muted} />
        <Text style={{ color: ctaEnabled ? '#FFF' : theme.colors.muted, fontSize: 15, fontWeight: '800' }}>
          {ctaLabel}
        </Text>
      </Pressable>
    </GlassCard>
  );
});

const styles = StyleSheet.create({
  footerGlass: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingTop: 10,
    paddingBottom: 12,
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
