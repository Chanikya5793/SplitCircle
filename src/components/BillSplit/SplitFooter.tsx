import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
import { radius, spacing } from '@/theme';
import { formatCurrency, getCurrencySymbol } from '@/utils/currency';
import React, { useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import Animated, {
    FadeInUp,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withSequence,
    withTiming,
} from 'react-native-reanimated';
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
  payerName,
  onManagePayer,
  onSpin,
  onDone,
}: SplitFooterProps) => {
  const { theme } = useTheme();
  const included = participants.filter((p) => p.included);

  const canSpinFromFooter = currentMethod === 'gamified' && gamifiedMode === 'roulette' && !loserId && !isSpinning;
  const canApply = useMemo(() => {
    if (isSpinning) return false;
    if (canSpinFromFooter) return true;
    return validation.isValid;
  }, [isSpinning, canSpinFromFooter, validation.isValid]);

  // Pulse animation when primary CTA is actionable
  const pulseScale = useSharedValue(1);
  useEffect(() => {
    if (canApply) {
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.02, { duration: 800 }),
          withTiming(1, { duration: 800 }),
        ),
        -1,
        true,
      );
    } else {
      pulseScale.value = withTiming(1, { duration: 200 });
    }
  }, [canApply, pulseScale]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
  }));

  // Compute allocated total
  const allocatedTotal = included.reduce((s, p) => s + p.computedAmount, 0);
  const methodLabel: Record<SplitMethod, string> = {
    equal: 'Equal',
    exact: 'Exact',
    percentage: 'Percentage',
    shares: 'Shares',
    adjustment: 'Adjustment',
    itemized: 'Itemized',
    income: 'Income',
    consumption: 'Consumption',
    timeBased: 'Time-based',
    gamified: gamifiedMode === 'scrooge' ? 'Karma' : gamifiedMode === 'weightedRoulette' ? 'Weighted' : 'Roulette',
    itemType: 'Item Type',
  };

  const needsSpin = currentMethod === 'gamified' && gamifiedMode === 'roulette' && !loserId;

  const ctaLabel = isSpinning
    ? 'Spinning…'
    : canSpinFromFooter
      ? 'Spin'
      : validation.isValid
        ? 'Done'
        : currentMethod === 'gamified'
          ? 'Done'
          : 'Fix Split';

  // ── Content Renderers ─────────────────────────────────────────────────
  const renderEqualContent = () => {
    const perPerson = included.length > 0 ? allocatedTotal / included.length : 0;
    return (
      <View style={styles.contentBlock}>
        <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.onSurface }]}>
          {formatCurrency(perPerson, currency)}/person
        </Text>
        <Text variant="bodySmall" style={{ color: theme.colors.muted }}>
          {includedCount} {includedCount === 1 ? 'person' : 'people'} · Total {formatCurrency(totalAmount, currency)}
        </Text>
      </View>
    );
  };

  const renderAllocationContent = () => {
    const progress = totalAmount > 0 ? Math.min(allocatedTotal / totalAmount, 1.5) : 0;
    const remaining = totalAmount - allocatedTotal;
    const isOver = remaining < -0.01;
    const isUnder = remaining > 0.01;
    const progressColor = isOver
      ? theme.colors.danger
      : validation.isValid
        ? theme.colors.success
        : theme.colors.primary;

    return (
      <View style={styles.contentBlock}>
        <View style={styles.allocationRow}>
          <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.onSurface }]}>
            {formatCurrency(allocatedTotal, currency)}
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.muted }}>
            {' / '}{formatCurrency(totalAmount, currency)}
          </Text>
        </View>
        {/* Progress bar */}
        <View style={[styles.progressTrack, { backgroundColor: theme.colors.pressed }]}>
          <View
            style={[
              styles.progressFill,
              {
                backgroundColor: progressColor,
                width: `${Math.min(progress * 100, 100)}%`,
              },
            ]}
          />
        </View>
        <Text variant="bodySmall" style={{ color: isOver ? theme.colors.danger : isUnder ? theme.colors.muted : theme.colors.success }}>
          {isOver
            ? `${getCurrencySymbol(currency)}${Math.abs(remaining).toFixed(2)} over`
            : isUnder
              ? `${getCurrencySymbol(currency)}${remaining.toFixed(2)} remaining`
              : 'Fully allocated'}
        </Text>
      </View>
    );
  };

  const renderGamifiedContent = () => {
    const loser = loserId ? participants.find((p) => p.id === loserId) : null;

    if (isSpinning) {
      return (
        <View style={styles.contentBlock}>
          <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.primary }]}>
            Spinning…
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.muted }}>
            Total {formatCurrency(totalAmount, currency)}
          </Text>
        </View>
      );
    }

    if (loser) {
      return (
        <View style={styles.contentBlock}>
          <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.onSurface }]}>
            {loser.name} pays {formatCurrency(loser.computedAmount, currency)}
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.muted }}>
            {gamifiedMode === 'roulette' ? 'Roulette' : gamifiedMode === 'weightedRoulette' ? 'Weighted' : 'Karma'} · {includedCount} players
          </Text>
        </View>
      );
    }

    // Pre-spin state
    const modeLabels: Record<GamifiedMode, string> = {
      roulette: 'Spin to decide',
      weightedRoulette: 'Fate assigns the shares',
      scrooge: 'Karma split ready',
    };

    return (
      <View style={styles.contentBlock}>
        <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.primary }]}>
          {modeLabels[gamifiedMode ?? 'roulette']}
        </Text>
        <Text variant="bodySmall" style={{ color: theme.colors.muted }}>
          {includedCount} players · Total {formatCurrency(totalAmount, currency)}
        </Text>
      </View>
    );
  };

  const renderAdvancedContent = () => {
    // For income, time, consumption, itemType - show range
    const amounts = included.map((p) => p.computedAmount).filter((a) => a > 0);
    const minAmt = amounts.length > 0 ? Math.min(...amounts) : 0;
    const maxAmt = amounts.length > 0 ? Math.max(...amounts) : 0;

    if (currentMethod === 'itemized') {
      return (
        <View style={styles.contentBlock}>
          <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.onSurface }]}>
            {formatCurrency(allocatedTotal, currency)} allocated
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.muted }}>
            {includedCount} {includedCount === 1 ? 'person' : 'people'} · Items + Tax + Tip
          </Text>
        </View>
      );
    }

    const allSame = Math.abs(maxAmt - minAmt) < 0.02;
    return (
      <View style={styles.contentBlock}>
        <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.onSurface }]}>
          {allSame
            ? `${formatCurrency(minAmt, currency)}/person`
            : `${formatCurrency(minAmt, currency)} — ${formatCurrency(maxAmt, currency)}`}
        </Text>
        <Text variant="bodySmall" style={{ color: theme.colors.muted }}>
          {includedCount} {includedCount === 1 ? 'person' : 'people'} · Total {formatCurrency(totalAmount, currency)}
        </Text>
      </View>
    );
  };

  // ── Select content based on method ────────────────────────────────────
  const renderContent = () => {
    if (currentMethod === 'gamified') return renderGamifiedContent();
    if (currentMethod === 'equal') return renderEqualContent();
    if (['exact', 'percentage', 'shares', 'adjustment'].includes(currentMethod)) {
      return renderAllocationContent();
    }
    // income, consumption, timeBased, itemized, itemType
    return renderAdvancedContent();
  };

  // Mid-game states are guidance, not failures — never bleed red while the
  // player simply hasn't finished spinning/applying yet.
  const gameInProgress = currentMethod === 'gamified' && !validation.isValid && !canSpinFromFooter;

  const helperText = canSpinFromFooter
    ? 'Spin to lock the result'
    : gameInProgress
      ? gamifiedMode === 'weightedRoulette'
        ? 'Spin until 100% is assigned'
        : gamifiedMode === 'scrooge'
          ? 'Apply the karma split to lock it'
          : validation.message
    : validation.isValid
      ? `${includedCount} of ${participants.length} included`
      : validation.message;

  const helperColor = canSpinFromFooter
    ? theme.colors.primary
    : gameInProgress
      ? theme.colors.muted
    : validation.isValid
      ? theme.colors.success
      : theme.colors.danger;

  const handlePrimaryAction = () => {
    if (!canApply) return;
    if (canSpinFromFooter) {
      onSpin?.();
      return;
    }
    onDone?.();
  };

  return (
    <Animated.View entering={FadeInUp.springify()} style={pulseStyle}>
      <GlassView style={[styles.footer, { backgroundColor: theme.dark ? 'rgba(18,20,26,0.92)' : 'rgba(255,255,255,0.94)' }, canApply && [styles.footerValid, { borderColor: `${theme.colors.success}40` }]]} intensity={70}>
        <View style={styles.footerContent}>
          <View style={styles.footerLeft}>
            {payerName && (
              <Pressable onPress={onManagePayer} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}>
                <Text style={{ color: theme.colors.primary, fontSize: 12, fontWeight: '700' }}>
                  {methodLabel[currentMethod]} · Paid by {payerName}
                </Text>
              </Pressable>
            )}

            {renderContent()}

            <View style={[styles.helperBadge, { backgroundColor: `${helperColor}20` }]}>
              <Text style={[styles.helperText, { color: helperColor }]}>{helperText}</Text>
            </View>
          </View>

          <View style={styles.actionColumn}>
            <Pressable
              onPress={canApply ? handlePrimaryAction : undefined}
              style={({ pressed }) => [
                styles.doneBadge,
                {
                  backgroundColor: canApply ? theme.colors.success : theme.colors.outline,
                  opacity: pressed && canApply ? 0.8 : 1,
                },
              ]}
            >
              <Icon source={canSpinFromFooter ? 'rotate-right' : canApply || currentMethod === 'gamified' ? 'check' : 'alert-circle-outline'} size={15} color="#FFF" />
              <Text style={styles.doneText}>{ctaLabel}</Text>
            </Pressable>


          </View>
        </View>
      </GlassView>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  footer: {
    // Docked bar: full-bleed with rounded shoulders — reads as part of the
    // sheet chrome rather than a floating card over content.
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    marginHorizontal: 0,
    marginBottom: 0,
  },
  footerValid: {
    borderWidth: 1,
  },
  footerContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  footerLeft: {
    flex: 1,
    gap: 4,
  },
  contentBlock: {
    gap: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  methodChip: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  allocationRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    width: '90%',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  totalLabel: {
    fontWeight: '700',
  },
  helperBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },
  helperText: {
    fontSize: 11,
    fontWeight: '700',
  },
  actionColumn: {
    alignItems: 'flex-end',
    gap: 8,
    marginLeft: spacing.sm,
  },
  doneBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  doneText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '700',
  },
  secondaryAction: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
});
