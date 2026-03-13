import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { colors, darkColors, spacing } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import { heavyHaptic, mediumHaptic, selectionHaptic, successHaptic } from '@/utils/haptics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Icon, PaperProvider, Text } from 'react-native-paper';
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
  computeShares,
  computeTimeBased,
  computeWeightedRoulette,
  validateSplit
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

    // Karma mode doesn't use spin – it's handled internally
    if (gamifiedMode === 'scrooge') return;

    // Compute the winner immediately
    let result: { participants: Participant[]; loserId: string };
    if (gamifiedMode === 'roulette') {
      result = computeRoulette(totalAmount, participants);
    } else {
      result = computeWeightedRoulette(totalAmount, participants);
    }

    // Only roulette mode uses the animated wheel
    if (gamifiedMode === 'roulette') {
      const included = participants.filter((p) => p.included);
      const winnerIdx = included.findIndex((p) => p.id === result.loserId);
      spinResultRef.current = result;
      setSpinTargetIndex(winnerIdx >= 0 ? winnerIdx : 0);
    } else {
      // Weighted – no wheel, quick delay
      weightedTimerRef.current = setTimeout(() => {
        setParticipants(result.participants);
        setLoserId(result.loserId);
        setIsSpinning(false);
        successHaptic();
      }, 1500);
    }
  }, [gamifiedMode, totalAmount, participants]);

  // Timer ref for weighted roulette – cleared on unmount to prevent state updates on dead component
  const weightedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (weightedTimerRef.current) clearTimeout(weightedTimerRef.current);
    };
  }, []);

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

  // ── Karma Complete ────────────────────────────────────────────────────────
  const handleKarmaComplete = useCallback((results: { userId: string; amount: number }[]) => {
    setParticipants((prev) =>
      prev.map((p) => {
        const r = results.find((x) => x.userId === p.id);
        return { ...p, computedAmount: r ? r.amount : 0 };
      }),
    );
    setLoserId(null);
    setIsSpinning(false);
  }, []);

  // ── Smart Suggestions ─────────────────────────────────────────────────────
  const suggestions: SmartSuggestion[] = useMemo(() => {
    const secondPerson = participants.length >= 2 ? participants[1].name : 'someone';
    return [
      { id: 'last_split', label: 'Use last split: 60/40', icon: 'history' },
      { id: 'drinks_person', label: `Assign drinks to ${secondPerson}`, icon: 'glass-cocktail' },
      { id: 'by_income', label: 'Split by income', icon: 'cash-multiple' },
      { id: 'roulette', label: 'Credit Card Roulette', icon: 'poker-chip' },
    ];
  }, [participants]);

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
      case 'drinks_person':
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
    if (currentMethod === 'gamified' && gamifiedMode === 'roulette' && !loserId) {
      return { isValid: false, message: 'Spin to decide!', difference: 0 };
    }
    const effectiveTotal = currentMethod === 'itemized'
      ? receiptItems.reduce((s, it) => s + it.price, 0) + taxAmount + tipAmount
      : totalAmount;
    return validateSplit(effectiveTotal, displayParticipants);
  }, [displayParticipants, totalAmount, currentMethod, gamifiedMode, loserId, receiptItems, taxAmount, tipAmount]);

  const included = displayParticipants.filter((p) => p.included);

  const canDone = useMemo(() => {
    if (isSpinning) return false;
    if (currentMethod !== 'gamified') return validation.isValid;
    if (gamifiedMode === 'roulette') return Boolean(loserId);
    return validation.isValid;
  }, [isSpinning, currentMethod, validation.isValid, gamifiedMode, loserId]);

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
    if (!canDone) {
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
  }, [canDone, paidBy, currentMethod, displayParticipants, onDone]);

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
              disabled={!canDone}
            >
              <Text
                variant="labelLarge"
                style={{
                  color: canDone ? theme.colors.primary : palette.muted,
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
              <Pressable
                onPress={() => { selectionHaptic(); setShowPayerMenu((v) => !v); }}
                style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}
              >
                <GlassView style={styles.payerCard} intensity={20}>
                  <View style={styles.payerContent}>
                    <View style={styles.payerLeft}>
                      <Icon source="account-cash" size={20} color={theme.colors.primary} />
                      <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>
                        Paid by{' '}
                        <Text style={{ fontWeight: '700', color: theme.colors.primary }}>{payerName}</Text>
                      </Text>
                    </View>
                    <View style={styles.changeIndicator}>
                      <Text variant="labelMedium" style={{ color: theme.colors.primary, fontWeight: '600' }}>Change</Text>
                      <Icon source={showPayerMenu ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.primary} />
                    </View>
                  </View>
                </GlassView>
              </Pressable>
              {showPayerMenu && (
                <Animated.View entering={FadeInDown.duration(150)} style={styles.payerDropdown}>
                  <GlassView style={styles.payerDropdownInner} intensity={40}>
                    {participants.map((p) => (
                      <Pressable
                        key={p.id}
                        onPress={() => { selectionHaptic(); setPaidBy(p.id); setShowPayerMenu(false); }}
                        style={({ pressed }) => [
                          styles.payerDropdownItem,
                          p.id === paidBy && { backgroundColor: `${theme.colors.primary}15` },
                          pressed && { opacity: 0.6 },
                        ]}
                      >
                        <View style={styles.payerDropdownItemLeft}>
                          <Icon source={p.id === paidBy ? 'check-circle' : 'account'} size={20} color={p.id === paidBy ? theme.colors.primary : theme.colors.onSurfaceVariant} />
                          <Text variant="bodyMedium" style={{ color: p.id === paidBy ? theme.colors.primary : theme.colors.onSurface, fontWeight: p.id === paidBy ? '700' : '400' }}>{p.name}</Text>
                        </View>
                      </Pressable>
                    ))}
                  </GlassView>
                </Animated.View>
              )}
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

            {/* Advanced Options Accordion - moved up for easier access */}
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
                  onKarmaComplete={handleKarmaComplete}
                  itemCategories={itemCategories}
                  onItemCategoriesChange={setItemCategories}
                />
              </Animated.View>
            )}

            {/* Bottom spacer for footer */}
            <View style={{ height: 170 }} />
          </ScrollView>

          {/* Sticky Footer */}
          <View style={styles.footerWrapper}>
            <SplitFooter
              totalAmount={currentMethod === 'itemized'
                ? receiptItems.reduce((s, it) => s + it.price, 0) + taxAmount + tipAmount
                : totalAmount}
              currency={currency}
              includedCount={included.length}
              participants={displayParticipants}
              currentMethod={currentMethod}
              validation={validation}
              gamifiedMode={gamifiedMode}
              loserId={loserId}
              isSpinning={isSpinning}
              payerName={payerName}
              onManagePayer={() => setShowPayerMenu(true)}
              onSpin={handleSpin}
              onDone={handleDone}
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
  changeIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  payerDropdown: {
    marginHorizontal: spacing.md,
    marginTop: 4,
  },
  payerDropdownInner: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  payerDropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  payerDropdownItemLeft: {
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
