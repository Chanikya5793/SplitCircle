import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { colors, darkColors, spacing } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import { heavyHaptic, mediumHaptic, selectionHaptic, successHaptic } from '@/utils/haptics';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Icon, Menu, PaperProvider, Text } from 'react-native-paper';
import Animated, { FadeIn, FadeInDown, FadeOut, Layout, SlideInDown, SlideOutDown } from 'react-native-reanimated';

import { AdvancedModeContent } from './AdvancedModeContent';
import { AdvancedModePicker } from './AdvancedModePicker';
import { ParticipantList } from './ParticipantList';
import { SmartSuggestionsBar } from './SmartSuggestionsBar';
import { SplitFooter } from './SplitFooter';
import { SplitMethodTabs } from './SplitMethodTabs';
import {
    computeAdjustment,
    computeConsumption,
    computeEqual,
    computeExact,
    computeIncome,
    computeItemType,
    computeItemized,
    computePercentage,
    computeRoulette,
    computeScrooge,
    computeShares,
    computeTimeBased,
    computeWeightedRoulette,
    validateSplit,
} from './splitMath';
import type {
    AdvancedSplitMethod,
    BasicSplitMethod,
    GamifiedMode,
    ItemCategory,
    Participant,
    ReceiptItem,
    SmartSuggestion,
    SplitMethod,
    ValidationResult,
} from './types';
import { MOCK_PARTICIPANTS, MOCK_TOTAL } from './types';

interface BillSplitScreenProps {
  totalAmount?: number;
  currency?: string;
  initialParticipants?: Participant[];
  initialPayer?: string;
  onDone?: (result: { paidBy: string; method: SplitMethod; participants: { userId: string; share: number }[] }) => void;
  onCancel?: () => void;
}

export const BillSplitScreen = ({
  totalAmount = MOCK_TOTAL,
  currency = 'USD',
  initialParticipants,
  initialPayer,
  onDone,
  onCancel,
}: BillSplitScreenProps) => {
  const { theme, isDark } = useTheme();
  const palette = isDark ? darkColors : colors;

  // ── Core State ────────────────────────────────────────────────────────────
  const [participants, setParticipants] = useState<Participant[]>(
    initialParticipants ?? MOCK_PARTICIPANTS,
  );
  const [paidBy, setPaidBy] = useState(initialPayer ?? participants[0]?.id ?? '');
  const [showPayerMenu, setShowPayerMenu] = useState(false);

  // ── Method State ──────────────────────────────────────────────────────────
  const [activeBasicMethod, setActiveBasicMethod] = useState<BasicSplitMethod>('equal');
  const [activeAdvancedMethod, setActiveAdvancedMethod] = useState<AdvancedSplitMethod | null>(null);
  const currentMethod: SplitMethod = activeAdvancedMethod ?? activeBasicMethod;

  // ── Advanced Section Toggle ───────────────────────────────────────────────
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Itemized Receipt State ────────────────────────────────────────────────
  const [receiptItems, setReceiptItems] = useState<ReceiptItem[]>([
    { id: 'item_1', name: 'Pasta', price: 24.0, assignedTo: ['u1', 'u3'] },
    { id: 'item_2', name: 'Steak', price: 42.0, assignedTo: ['u2'] },
    { id: 'item_3', name: 'Salad', price: 16.0, assignedTo: ['u1', 'u3', 'u4'] },
    { id: 'item_4', name: 'Cocktails', price: 36.0, assignedTo: ['u1', 'u2'] },
  ]);
  const [taxAmount, setTaxAmount] = useState(12.5);
  const [tipAmount, setTipAmount] = useState(19.5);

  // ── Consumption State ─────────────────────────────────────────────────────
  const [totalParts, setTotalParts] = useState(8);

  // ── Gamified State ────────────────────────────────────────────────────────
  const [gamifiedMode, setGamifiedMode] = useState<GamifiedMode>('roulette');
  const [loserId, setLoserId] = useState<string | null>(null);
  const [isSpinning, setIsSpinning] = useState(false);
  const [spinTargetIndex, setSpinTargetIndex] = useState<number | null>(null);

  // ── Item Type State ───────────────────────────────────────────────────────
  const [itemCategories, setItemCategories] = useState<ItemCategory[]>([]);

  // ── Participant Updaters ──────────────────────────────────────────────────
  const updateParticipant = useCallback((id: string, update: Partial<Participant>) => {
    setParticipants((prev) => prev.map((p) => (p.id === id ? { ...p, ...update } : p)));
  }, []);

  const handleToggle = useCallback((id: string) => {
    selectionHaptic();
    setParticipants((prev) => prev.map((p) => (p.id === id ? { ...p, included: !p.included } : p)));
  }, []);

  const handleSelectAll = useCallback(() => {
    selectionHaptic();
    setParticipants((prev) => {
      const allSelected = prev.every((p) => p.included);
      return prev.map((p) => ({ ...p, included: !allSelected }));
    });
  }, []);

  const allSelected = participants.every((p) => p.included);

  const handleExactChange = useCallback((id: string, value: string) => {
    updateParticipant(id, { exactAmount: parseFloat(value) || 0 });
  }, [updateParticipant]);

  const handlePercentageChange = useCallback((id: string, value: string) => {
    updateParticipant(id, { percentage: parseFloat(value) || 0 });
  }, [updateParticipant]);

  const handleSharesChange = useCallback((id: string, value: string) => {
    updateParticipant(id, { shares: parseInt(value, 10) || 0 });
  }, [updateParticipant]);

  const handleAdjustmentChange = useCallback((id: string, value: string) => {
    updateParticipant(id, { adjustment: parseFloat(value) || 0 });
  }, [updateParticipant]);

  const handleIncomeWeightChange = useCallback((id: string, value: string) => {
    updateParticipant(id, { incomeWeight: parseFloat(value) || 0 });
  }, [updateParticipant]);

  const handlePartsConsumedChange = useCallback((id: string, value: string) => {
    updateParticipant(id, { partsConsumed: parseInt(value, 10) || 0 });
  }, [updateParticipant]);

  const handleDaysChange = useCallback((id: string, value: string) => {
    updateParticipant(id, { daysStayed: parseInt(value, 10) || 0 });
  }, [updateParticipant]);

  const handleRouletteWeightChange = useCallback((id: string, value: string) => {
    updateParticipant(id, { rouletteWeight: parseInt(value, 10) || 0 });
  }, [updateParticipant]);

  // ── Gamified Spin ─────────────────────────────────────────────────────────
  const handleSpin = useCallback(() => {
    heavyHaptic();
    setLoserId(null);
    setSpinTargetIndex(null);
    setIsSpinning(true);

    // Compute the winner immediately
    let result: { participants: Participant[]; loserId: string };
    if (gamifiedMode === 'roulette') {
      result = computeRoulette(totalAmount, participants);
    } else if (gamifiedMode === 'weightedRoulette') {
      result = computeWeightedRoulette(totalAmount, participants);
    } else {
      result = computeScrooge(totalAmount, participants);
    }

    // Only roulette mode uses the animated wheel
    if (gamifiedMode === 'roulette') {
      const included = participants.filter((p) => p.included);
      const winnerIdx = included.findIndex((p) => p.id === result.loserId);
      spinResultRef.current = result;
      setSpinTargetIndex(winnerIdx >= 0 ? winnerIdx : 0);
    } else {
      // Weighted / Scrooge – no wheel, quick delay
      setTimeout(() => {
        setParticipants(result.participants);
        setLoserId(result.loserId);
        setIsSpinning(false);
        successHaptic();
      }, 1500);
    }
  }, [gamifiedMode, totalAmount, participants]);

  // Ref to hold computed result while wheel spins
  const spinResultRef = useRef<{ participants: Participant[]; loserId: string } | null>(null);

  const handleWheelSpinComplete = useCallback((winnerId: string) => {
    const stashed = spinResultRef.current;
    if (stashed) {
      setParticipants(stashed.participants);
      setLoserId(stashed.loserId);
      spinResultRef.current = null;
    } else {
      setLoserId(winnerId);
    }
    setIsSpinning(false);
    setSpinTargetIndex(null);
    successHaptic();
  }, []);

  // ── Weighted Roulette Complete ────────────────────────────────────────────
  const handleWeightedComplete = useCallback((assignments: { userId: string; percentage: number }[]) => {
    setParticipants((prev) =>
      prev.map((p) => {
        const a = assignments.find((x) => x.userId === p.id);
        const pct = a ? a.percentage : 0;
        return {
          ...p,
          percentage: pct,
          computedAmount: Math.round((totalAmount * pct / 100) * 100) / 100,
        };
      }),
    );
    setLoserId(null);
    setIsSpinning(false);
  }, [totalAmount]);

  // ── Smart Suggestions ─────────────────────────────────────────────────────
  const suggestions: SmartSuggestion[] = useMemo(() => [
    { id: 'last_split', label: 'Use last split: 60/40', icon: 'history' },
    { id: 'drinks_john', label: 'Assign drinks to Chetan', icon: 'glass-cocktail' },
    { id: 'by_income', label: 'Split by income', icon: 'cash-multiple' },
    { id: 'roulette', label: 'Credit Card Roulette', icon: 'poker-chip' },
  ], []);

  const handleSuggestion = useCallback((id: string) => {
    mediumHaptic();
    switch (id) {
      case 'last_split':
        setActiveAdvancedMethod(null);
        setActiveBasicMethod('percentage');
        if (participants.length >= 2) {
          setParticipants((prev) => prev.map((p, i) => ({
            ...p,
            percentage: i === 0 ? 60 : i === 1 ? 40 : 0,
            included: i < 2,
          })));
        }
        break;
      case 'drinks_john':
        setActiveAdvancedMethod('itemType');
        setShowAdvanced(true);
        setItemCategories([{
          id: 'cat_drinks',
          label: 'Alcohol',
          amount: 36,
          excludedParticipants: participants.filter((_, i) => i !== 1).map((p) => p.id),
        }]);
        break;
      case 'by_income':
        setActiveAdvancedMethod('income');
        setShowAdvanced(true);
        break;
      case 'roulette':
        setActiveAdvancedMethod('gamified');
        setShowAdvanced(true);
        setGamifiedMode('roulette');
        break;
    }
  }, [participants]);

  // ── Compute Splits ────────────────────────────────────────────────────────
  const computedParticipants = useMemo<Participant[]>(() => {
    switch (currentMethod) {
      case 'equal':
        return computeEqual(totalAmount, participants);
      case 'exact':
        return computeExact(participants);
      case 'percentage':
        return computePercentage(totalAmount, participants);
      case 'shares':
        return computeShares(totalAmount, participants);
      case 'adjustment':
        return computeAdjustment(totalAmount, participants);
      case 'itemized':
        return computeItemized(receiptItems, taxAmount, tipAmount, participants);
      case 'income':
        return computeIncome(totalAmount, participants);
      case 'consumption':
        return computeConsumption(totalAmount, totalParts, participants);
      case 'timeBased':
        return computeTimeBased(totalAmount, participants);
      case 'gamified':
        // gamified is computed on spin, use current state
        return participants;
      case 'itemType':
        return computeItemType(totalAmount, itemCategories, participants);
      default:
        return participants;
    }
  }, [currentMethod, totalAmount, participants, receiptItems, taxAmount, tipAmount, totalParts, itemCategories]);

  // Sync computed amounts back (for display in advanced modes)
  const displayParticipants = useMemo(() => {
    if (currentMethod === 'gamified') return participants;
    return computedParticipants;
  }, [currentMethod, computedParticipants, participants]);

  // ── Validation ────────────────────────────────────────────────────────────
  const validation: ValidationResult = useMemo(() => {
    if (currentMethod === 'gamified' && !loserId) {
      return { isValid: false, message: 'Spin to decide!', difference: 0 };
    }
    const effectiveTotal = currentMethod === 'itemized'
      ? receiptItems.reduce((s, it) => s + it.price, 0) + taxAmount + tipAmount
      : totalAmount;
    return validateSplit(effectiveTotal, displayParticipants);
  }, [displayParticipants, totalAmount, currentMethod, loserId, receiptItems, taxAmount, tipAmount]);

  const included = displayParticipants.filter((p) => p.included);
  const perPerson = included.length > 0
    ? included.reduce((s, p) => s + p.computedAmount, 0) / included.length
    : 0;

  // ── Method Selection ──────────────────────────────────────────────────────
  const handleBasicMethodSelect = useCallback((method: BasicSplitMethod) => {
    setActiveBasicMethod(method);
    setActiveAdvancedMethod(null);
  }, []);

  const handleAdvancedMethodSelect = useCallback((method: AdvancedSplitMethod) => {
    mediumHaptic();
    setActiveAdvancedMethod(method);
  }, []);

  const handleBackToAdvanced = useCallback(() => {
    setActiveAdvancedMethod(null);
  }, []);

  const handleToggleAdvanced = useCallback(() => {
    mediumHaptic();
    setShowAdvanced((prev) => !prev);
    if (showAdvanced) {
      setActiveAdvancedMethod(null);
    }
  }, [showAdvanced]);

  // ── Done Handler ──────────────────────────────────────────────────────────
  const handleDone = useCallback(() => {
    if (!validation.isValid && currentMethod !== 'gamified') {
      return;
    }
    successHaptic();
    onDone?.({
      paidBy,
      method: currentMethod,
      participants: displayParticipants
        .filter((p) => p.included)
        .map((p) => ({ userId: p.id, share: p.computedAmount })),
    });
  }, [validation, currentMethod, paidBy, displayParticipants, onDone]);

  const payerName = participants.find((p) => p.id === paidBy)?.name ?? 'Unknown';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <PaperProvider theme={theme}>
      <LiquidBackground>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={onCancel} activeOpacity={0.7}>
              <Text variant="labelLarge" style={{ color: theme.colors.primary }}>Cancel</Text>
            </TouchableOpacity>
            <Text variant="titleMedium" style={[styles.headerTitle, { color: theme.colors.onSurface }]}>
              Split options
            </Text>
            <TouchableOpacity
              onPress={handleDone}
              activeOpacity={0.7}
              disabled={!validation.isValid && currentMethod !== 'gamified'}
            >
              <Text
                variant="labelLarge"
                style={{
                  color: validation.isValid || currentMethod === 'gamified' ? theme.colors.primary : palette.muted,
                  fontWeight: '700',
                }}
              >
                Done
              </Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Payer Section */}
            <Animated.View entering={FadeInDown.delay(60).springify()}>
              <GlassView style={styles.payerCard} intensity={20}>
                <View style={styles.payerContent}>
                  <View style={styles.payerLeft}>
                    <Icon source="account-cash" size={20} color={theme.colors.primary} />
                    <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>
                      Paid by{' '}
                      <Text style={{ fontWeight: '700', color: theme.colors.primary }}>{payerName}</Text>
                    </Text>
                  </View>
                  <Menu
                    visible={showPayerMenu}
                    onDismiss={() => setShowPayerMenu(false)}
                    anchor={
                      <TouchableOpacity onPress={() => setShowPayerMenu(true)}>
                        <Text variant="labelMedium" style={{ color: theme.colors.primary }}>Change</Text>
                      </TouchableOpacity>
                    }
                  >
                    {participants.map((p) => (
                      <Menu.Item
                        key={p.id}
                        title={p.name}
                        onPress={() => { setPaidBy(p.id); setShowPayerMenu(false); }}
                        leadingIcon={p.id === paidBy ? 'check' : undefined}
                      />
                    ))}
                  </Menu>
                </View>
              </GlassView>
            </Animated.View>

            {/* Smart Suggestions */}
            <Animated.View entering={FadeInDown.delay(120).springify()}>
              <SmartSuggestionsBar suggestions={suggestions} onSelect={handleSuggestion} />
            </Animated.View>

            {/* Basic Method Tabs (hidden when advanced method is active) */}
            {!activeAdvancedMethod && (
              <Animated.View entering={FadeIn.duration(200)} layout={Layout.springify()}>
                <SplitMethodTabs activeMethod={activeBasicMethod} onSelect={handleBasicMethodSelect} />
              </Animated.View>
            )}

            {/* Back to advanced picker when in an advanced mode */}
            {activeAdvancedMethod && (
              <Animated.View entering={FadeIn.duration(200)}>
                <View style={styles.advancedBreadcrumb}>
                  <TouchableOpacity
                    onPress={handleBackToAdvanced}
                    style={styles.breadcrumbBtn}
                    activeOpacity={0.7}
                  >
                    <Icon source="arrow-left" size={18} color={theme.colors.primary} />
                    <Text variant="labelMedium" style={{ color: theme.colors.primary }}>Advanced Modes</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => { setActiveAdvancedMethod(null); setShowAdvanced(false); }}
                    activeOpacity={0.7}
                  >
                    <Text variant="labelMedium" style={{ color: palette.muted }}>Back to basic</Text>
                  </TouchableOpacity>
                </View>
              </Animated.View>
            )}

            {/* Participant List (shown for basic methods only) */}
            {!activeAdvancedMethod && (
              <Animated.View entering={FadeInDown.delay(180).springify()} layout={Layout.springify()}>
                <ParticipantList
                  participants={displayParticipants}
                  activeMethod={activeBasicMethod}
                  currency={currency}
                  onToggle={handleToggle}
                  onExactChange={handleExactChange}
                  onPercentageChange={handlePercentageChange}
                  onSharesChange={handleSharesChange}
                  onAdjustmentChange={handleAdjustmentChange}
                  onSelectAll={handleSelectAll}
                  allSelected={allSelected}
                />
              </Animated.View>
            )}

            {/* Advanced Mode Content */}
            {activeAdvancedMethod && (
              <Animated.View entering={SlideInDown.springify()} exiting={SlideOutDown.springify()}>
                <AdvancedModeContent
                  method={activeAdvancedMethod}
                  participants={displayParticipants}
                  currency={currency}
                  totalAmount={totalAmount}
                  receiptItems={receiptItems}
                  onReceiptItemsChange={setReceiptItems}
                  taxAmount={taxAmount}
                  onTaxChange={setTaxAmount}
                  tipAmount={tipAmount}
                  onTipChange={setTipAmount}
                  onIncomeWeightChange={handleIncomeWeightChange}
                  totalParts={totalParts}
                  onTotalPartsChange={setTotalParts}
                  onPartsConsumedChange={handlePartsConsumedChange}
                  onDaysChange={handleDaysChange}
                  gamifiedMode={gamifiedMode}
                  onGamifiedModeChange={setGamifiedMode}
                  onRouletteWeightChange={handleRouletteWeightChange}
                  loserId={loserId}
                  onSpin={handleSpin}
                  spinTargetIndex={spinTargetIndex}
                  onSpinComplete={handleWheelSpinComplete}
                  isSpinning={isSpinning}
                  onWeightedComplete={handleWeightedComplete}
                  itemCategories={itemCategories}
                  onItemCategoriesChange={setItemCategories}
                />
              </Animated.View>
            )}

            {/* Advanced Options Accordion */}
            {!activeAdvancedMethod && (
              <View style={styles.advancedToggleSection}>
                <TouchableOpacity
                  onPress={handleToggleAdvanced}
                  activeOpacity={0.7}
                  style={styles.advancedToggle}
                >
                  <View style={styles.advancedToggleLeft}>
                    <Icon
                      source={showAdvanced ? 'chevron-up' : 'chevron-down'}
                      size={20}
                      color={theme.colors.primary}
                    />
                    <Text variant="labelLarge" style={{ color: theme.colors.primary, fontWeight: '700' }}>
                      {showAdvanced ? 'Hide Advanced Splits' : 'Advanced Splits'}
                    </Text>
                  </View>
                  <View style={[styles.advancedBadge, { backgroundColor: `${theme.colors.primary}15` }]}>
                    <Text style={{ color: theme.colors.primary, fontSize: 11, fontWeight: '700' }}>6 modes</Text>
                  </View>
                </TouchableOpacity>

                {showAdvanced && (
                  <Animated.View entering={FadeInDown.springify()} exiting={FadeOut.duration(150)}>
                    <AdvancedModePicker onSelect={handleAdvancedMethodSelect} />
                  </Animated.View>
                )}
              </View>
            )}

            {/* Bottom spacer for footer */}
            <View style={{ height: 100 }} />
          </ScrollView>

          {/* Sticky Footer */}
          <View style={styles.footerWrapper}>
            <SplitFooter
              totalAmount={totalAmount}
              currency={currency}
              includedCount={included.length}
              perPersonAmount={perPerson}
              validation={validation}
            />
          </View>
        </View>
      </LiquidBackground>
    </PaperProvider>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: 56,
    paddingBottom: spacing.sm,
  },
  headerTitle: {
    fontWeight: '700',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  payerCard: {
    borderRadius: 16,
    marginHorizontal: spacing.md,
  },
  payerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  payerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  advancedBreadcrumb: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    marginBottom: spacing.xs,
  },
  breadcrumbBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  advancedToggleSection: {
    marginTop: spacing.sm,
    gap: spacing.md,
  },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  advancedToggleLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  advancedBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  footerWrapper: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 34,
  },
});
