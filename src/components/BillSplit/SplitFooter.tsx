import { GlassView } from '@/components/GlassView';
import { colors, darkColors, spacing } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
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
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;
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
    ? 'Spinning...'
    : canSpinFromFooter
      ? 'Spin'
      : validation.isValid
        ? 'Done'
        : 'Fix Split';

  // ── Content Renderers ─────────────────────────────────────────────────
  const renderEqualContent = () => {
    const perPerson = included.length > 0 ? allocatedTotal / included.length : 0;
    return (
      <View style={styles.footerLeft}>
        <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.onSurface }]}>
          {formatCurrency(perPerson, currency)}/person
        </Text>
        <Text variant="bodySmall" style={{ color: palette.muted }}>
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
      ? colors.danger
      : validation.isValid
        ? colors.success
        : theme.colors.primary;

    return (
      <View style={styles.footerLeft}>
        <View style={styles.allocationRow}>
          <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.onSurface }]}>
            {formatCurrency(allocatedTotal, currency)}
          </Text>
          <Text variant="bodySmall" style={{ color: palette.muted }}>
            {' / '}{formatCurrency(totalAmount, currency)}
          </Text>
        </View>
        {/* Progress bar */}
        <View style={[styles.progressTrack, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }]}>
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
        <Text variant="bodySmall" style={{ color: isOver ? colors.danger : isUnder ? palette.muted : colors.success }}>
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
        <View style={styles.footerLeft}>
          <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.primary }]}>
            🎰 Spinning...
          </Text>
          <Text variant="bodySmall" style={{ color: palette.muted }}>
            Total {formatCurrency(totalAmount, currency)}
          </Text>
        </View>
      );
    }

    if (loser) {
      return (
        <View style={styles.footerLeft}>
          <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.onSurface }]}>
            🎯 {loser.name} pays {formatCurrency(loser.computedAmount, currency)}
          </Text>
          <Text variant="bodySmall" style={{ color: palette.muted }}>
            {gamifiedMode === 'roulette' ? 'Roulette' : gamifiedMode === 'weightedRoulette' ? 'Weighted' : 'Karma'} · {includedCount} players
          </Text>
        </View>
      );
    }

    // Pre-spin state
    const modeLabels: Record<GamifiedMode, string> = {
      roulette: '🎰 Spin to decide!',
      weightedRoulette: '⚖️ Spin the weighted wheel!',
      scrooge: '🧮 Karma split ready',
    };

    return (
      <View style={styles.footerLeft}>
        <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.primary }]}>
          {modeLabels[gamifiedMode ?? 'roulette']}
        </Text>
        <Text variant="bodySmall" style={{ color: palette.muted }}>
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
        <View style={styles.footerLeft}>
          <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.onSurface }]}>
            {formatCurrency(allocatedTotal, currency)} allocated
          </Text>
          <Text variant="bodySmall" style={{ color: palette.muted }}>
            {includedCount} {includedCount === 1 ? 'person' : 'people'} · Items + Tax + Tip
          </Text>
        </View>
      );
    }

    const allSame = Math.abs(maxAmt - minAmt) < 0.02;
    return (
      <View style={styles.footerLeft}>
        <Text variant="titleMedium" style={[styles.totalLabel, { color: theme.colors.onSurface }]}>
          {allSame
            ? `${formatCurrency(minAmt, currency)}/person`
            : `${formatCurrency(minAmt, currency)} — ${formatCurrency(maxAmt, currency)}`}
        </Text>
        <Text variant="bodySmall" style={{ color: palette.muted }}>
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

  const helperText = canSpinFromFooter
    ? 'Spin to lock the result'
    : currentMethod === 'gamified' && gamifiedMode === 'weightedRoulette' && !validation.isValid
      ? 'Use the wheel button to complete all assignments'
    : validation.isValid
      ? `${includedCount} of ${participants.length} included`
      : validation.message;

  const helperColor = canSpinFromFooter
    ? theme.colors.primary
    : validation.isValid
      ? colors.success
      : colors.danger;

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
      <GlassView style={[styles.footer, canApply && styles.footerValid]} intensity={40}>
        <View style={styles.footerContent}>
          <View style={styles.footerLeft}>
            <View style={styles.metaRow}>
              <View style={[styles.methodChip, { borderColor: palette.border, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
                <Text style={{ color: theme.colors.onSurface, fontSize: 11, fontWeight: '700' }}>{methodLabel[currentMethod]}</Text>
              </View>
              {payerName && (
                <Pressable onPress={onManagePayer} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}>
                  <Text style={{ color: theme.colors.primary, fontSize: 12, fontWeight: '700' }}>
                    Paid by {payerName}
                  </Text>
                </Pressable>
              )}
            </View>

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
                  backgroundColor: canApply ? colors.success : palette.border,
                  opacity: pressed && canApply ? 0.8 : 1,
                },
              ]}
            >
              <Icon source={canSpinFromFooter ? 'rotate-right' : canApply ? 'check' : 'alert-circle-outline'} size={15} color="#FFF" />
              <Text style={styles.doneText}>{ctaLabel}</Text>
            </Pressable>

            {onManagePayer && (
              <Pressable
                onPress={onManagePayer}
                style={({ pressed }) => [styles.secondaryAction, { borderColor: palette.border, opacity: pressed ? 0.75 : 1 }]}
              >
                <Text style={{ color: theme.colors.onSurface, fontSize: 11, fontWeight: '700' }}>Payer</Text>
              </Pressable>
            )}
          </View>
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
  footerValid: {
    borderWidth: 1,
    borderColor: `${colors.success}40`,
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
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  methodChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
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
    paddingVertical: 4,
    borderRadius: 999,
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
    paddingVertical: 8,
    borderRadius: 12,
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
