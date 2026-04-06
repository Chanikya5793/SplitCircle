import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { colors, darkColors, spacing } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import type { ExpenseSplitMetadata } from '@/models';
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
    computeStandardTimeBased,
    computeTimeBased,
    computeWeightedRoulette,
    listDatesBetween,
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
    TimeSplitVariant,
    ValidationResult,
} from './types';
import { MOCK_PARTICIPANTS, MOCK_TOTAL } from './types';

interface BillSplitScreenProps {
  totalAmount?: number;
  currency?: string;
  initialParticipants?: Participant[];
  initialPayer?: string;
  initialSplitMetadata?: ExpenseSplitMetadata;
  onDone?: (result: {
    paidBy: string;
    method: SplitMethod;
    participants: { userId: string; share: number }[];
    splitMetadata: ExpenseSplitMetadata;
    resolvedTotalAmount: number;
  }) => void;
  onCancel?: () => void;
}

function inferInitialTimePeriodDays(participants: Participant[]): number {
  const included = participants.filter((participant) => participant.included);
  const maxDays = included.reduce((max, participant) => Math.max(max, participant.daysStayed), 0);
  return maxDays > 1 ? maxDays : 30;
}

function clampParticipantDays(value: number, periodDays: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.round(value)), Math.max(1, periodDays));
}

function isBasicMethod(method?: ExpenseSplitMetadata['method']): method is BasicSplitMethod {
  return method === 'equal' || method === 'exact' || method === 'percentage' || method === 'shares' || method === 'adjustment';
}

function isAdvancedMethod(method?: ExpenseSplitMetadata['method']): method is AdvancedSplitMethod {
  return method === 'itemized' || method === 'income' || method === 'consumption' || method === 'timeBased' || method === 'gamified' || method === 'itemType';
}

export const BillSplitScreen = ({
  totalAmount = MOCK_TOTAL,
  currency = 'USD',
  initialParticipants,
  initialPayer,
  initialSplitMetadata,
  onDone,
  onCancel,
}: BillSplitScreenProps) => {
  const { theme, isDark } = useTheme();
  const palette = isDark ? darkColors : colors;
  const seedParticipants = initialParticipants ?? MOCK_PARTICIPANTS;
  const initialMethod = initialSplitMetadata?.method;

  // ── Core State ────────────────────────────────────────────────────────────
  const [participants, setParticipants] = useState<Participant[]>(
    seedParticipants,
  );
  const [timePeriodDays, setTimePeriodDays] = useState(() => initialSplitMetadata?.timePeriodDays ?? inferInitialTimePeriodDays(seedParticipants));
  const [timeSplitVariant, setTimeSplitVariant] = useState<TimeSplitVariant>(initialSplitMetadata?.timeSplitVariant ?? 'dynamic');
  const [timePeriodStartDate, setTimePeriodStartDate] = useState(initialSplitMetadata?.timePeriodStartDate ?? '');
  const [timePeriodEndDate, setTimePeriodEndDate] = useState(initialSplitMetadata?.timePeriodEndDate ?? '');
  const [paidBy, setPaidBy] = useState(initialPayer ?? participants[0]?.id ?? '');
  const [showPayerMenu, setShowPayerMenu] = useState(false);

  // ── Method State ──────────────────────────────────────────────────────────
  const [activeBasicMethod, setActiveBasicMethod] = useState<BasicSplitMethod>(
    isBasicMethod(initialMethod) ? initialMethod : 'equal',
  );
  const [activeAdvancedMethod, setActiveAdvancedMethod] = useState<AdvancedSplitMethod | null>(
    isAdvancedMethod(initialMethod) ? initialMethod : null,
  );
  const currentMethod: SplitMethod = activeAdvancedMethod ?? activeBasicMethod;

  // ── Advanced Section Toggle ───────────────────────────────────────────────
  const [showAdvanced, setShowAdvanced] = useState(Boolean(isAdvancedMethod(initialMethod)));

  // ── Itemized Receipt State ────────────────────────────────────────────────
  const [receiptItems, setReceiptItems] = useState<ReceiptItem[]>(
    initialSplitMetadata?.receiptItems?.length
      ? initialSplitMetadata.receiptItems
      : [
        { id: 'item_1', name: 'Pasta', price: 24.0, assignedTo: ['u1', 'u3'] },
        { id: 'item_2', name: 'Steak', price: 42.0, assignedTo: ['u2'] },
        { id: 'item_3', name: 'Salad', price: 16.0, assignedTo: ['u1', 'u3', 'u4'] },
        { id: 'item_4', name: 'Cocktails', price: 36.0, assignedTo: ['u1', 'u2'] },
      ],
  );
  const [taxAmount, setTaxAmount] = useState(initialSplitMetadata?.taxAmount ?? 12.5);
  const [tipAmount, setTipAmount] = useState(initialSplitMetadata?.tipAmount ?? 19.5);

  // ── Consumption State ─────────────────────────────────────────────────────
  const [totalParts, setTotalParts] = useState(initialSplitMetadata?.totalParts ?? 8);

  // ── Gamified State ────────────────────────────────────────────────────────
  const [gamifiedMode, setGamifiedMode] = useState<GamifiedMode>(initialSplitMetadata?.gamifiedMode ?? 'roulette');
  const [loserId, setLoserId] = useState<string | null>(initialSplitMetadata?.rouletteLoserId ?? null);
  const [isSpinning, setIsSpinning] = useState(false);
  const [spinTargetIndex, setSpinTargetIndex] = useState<number | null>(null);
  const [weightedAssignments, setWeightedAssignments] = useState<{ userId: string; percentage: number }[]>(
    initialSplitMetadata?.weightedAssignments ?? [],
  );
  const [karmaIntensity, setKarmaIntensity] = useState(initialSplitMetadata?.karmaIntensity ?? 0.5);

  // ── Item Type State ───────────────────────────────────────────────────────
  const [itemCategories, setItemCategories] = useState<ItemCategory[]>(initialSplitMetadata?.itemCategories ?? []);

  // ── Participant Updaters ──────────────────────────────────────────────────
  const updateParticipant = useCallback((id: string, update: Partial<Participant>) => {
    setParticipants((prev) => prev.map((p) => (p.id === id ? { ...p, ...update } : p)));
  }, []);

  const fullPeriodDates = useMemo(
    () => listDatesBetween(timePeriodStartDate, timePeriodEndDate),
    [timePeriodEndDate, timePeriodStartDate],
  );

  const applyTimePeriodDays = useCallback((days: number, options?: { withHaptic?: boolean; selectedDates?: string[] }) => {
    const normalizedDays = Math.max(1, Math.round(days) || 1);
    const selectedDates = options?.selectedDates?.slice(0, normalizedDays);

    if (options?.withHaptic !== false) {
      mediumHaptic();
    }

    setTimePeriodDays(normalizedDays);
    setParticipants((prev) => prev.map((participant) => (
      participant.included
        ? {
          ...participant,
          daysStayed: normalizedDays,
          checkInDate: undefined,
          checkOutDate: undefined,
          selectedStayDates: selectedDates,
        }
        : participant
    )));
  }, []);

  const handleToggle = useCallback((id: string) => {
    setParticipants((prev) => prev.map((p) => {
      if (p.id !== id) return p;
      const included = !p.included;
      return {
        ...p,
        included,
        daysStayed: included && p.daysStayed === 0 ? timePeriodDays : p.daysStayed,
        selectedStayDates: included && p.daysStayed === 0 && fullPeriodDates.length === timePeriodDays
          ? fullPeriodDates
          : p.selectedStayDates,
      };
    }));
  }, [fullPeriodDates, timePeriodDays]);

  const handleSelectAll = useCallback(() => {
    selectionHaptic();
    setParticipants((prev) => {
      const allSelected = prev.every((p) => p.included);
      return prev.map((p) => ({
        ...p,
        included: !allSelected,
        daysStayed: !allSelected && p.daysStayed === 0 ? timePeriodDays : p.daysStayed,
        selectedStayDates: !allSelected && p.daysStayed === 0 && fullPeriodDates.length === timePeriodDays
          ? fullPeriodDates
          : p.selectedStayDates,
      }));
    });
  }, [fullPeriodDates, timePeriodDays]);

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
    const parsedValue = parseInt(value, 10);
    const daysStayed = clampParticipantDays(Number.isNaN(parsedValue) ? 0 : parsedValue, timePeriodDays);
    updateParticipant(id, {
      daysStayed,
      checkInDate: undefined,
      checkOutDate: undefined,
      selectedStayDates: undefined,
    });
  }, [timePeriodDays, updateParticipant]);

  const handleStayDatesChange = useCallback((id: string, dates: string[]) => {
    const allowedDates = fullPeriodDates.length > 0
      ? dates.filter((date) => fullPeriodDates.includes(date))
      : dates;
    const uniqueSortedDates = Array.from(new Set(allowedDates)).sort();
    updateParticipant(id, {
      daysStayed: uniqueSortedDates.length,
      selectedStayDates: uniqueSortedDates,
      checkInDate: uniqueSortedDates[0],
      checkOutDate: uniqueSortedDates[uniqueSortedDates.length - 1],
    });
  }, [fullPeriodDates, updateParticipant]);

  const handleTimePeriodRangeChange = useCallback((startDate: string, endDate: string) => {
    setTimePeriodStartDate(startDate);
    setTimePeriodEndDate(endDate);

    if (startDate.length !== 10 || endDate.length !== 10) {
      return;
    }

    const periodDates = listDatesBetween(startDate, endDate);
    if (periodDates.length === 0) {
      return;
    }

    applyTimePeriodDays(periodDates.length, { withHaptic: false, selectedDates: periodDates });
  }, [applyTimePeriodDays]);

  const handleSetAllDays = useCallback((days: number) => {
    const normalizedDays = Math.max(1, Math.round(days) || 1);
    const selectedDates = fullPeriodDates.length === normalizedDays ? fullPeriodDates : undefined;

    if (!selectedDates && (timePeriodStartDate || timePeriodEndDate)) {
      setTimePeriodStartDate('');
      setTimePeriodEndDate('');
    }

    applyTimePeriodDays(normalizedDays, { selectedDates });
  }, [applyTimePeriodDays, fullPeriodDates, timePeriodEndDate, timePeriodStartDate]);

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
    setWeightedAssignments(assignments);
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

  const handleGamifiedModeChange = useCallback((mode: GamifiedMode) => {
    setGamifiedMode(mode);
    setLoserId(null);
    setSpinTargetIndex(null);
    setIsSpinning(false);
    setParticipants((prev) => prev.map((participant) => ({
      ...participant,
      percentage: 0,
      computedAmount: 0,
    })));

    if (mode !== 'weightedRoulette') {
      setWeightedAssignments([]);
    }

    if (mode !== 'scrooge') {
      setKarmaIntensity(0.5);
    }
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

  const timeBasedAutofillDoneRef = useRef(false);

  useEffect(() => {
    if (currentMethod !== 'timeBased' || timeBasedAutofillDoneRef.current || timePeriodDays <= 0) {
      return;
    }

    const includedParticipants = participants.filter((participant) => participant.included);
    if (includedParticipants.length === 0) {
      return;
    }

    const shouldAutofill = includedParticipants.every((participant) =>
      !participant.checkInDate
      && !participant.checkOutDate
      && (participant.daysStayed === 0 || participant.daysStayed === 1),
    );

    if (!shouldAutofill) {
      timeBasedAutofillDoneRef.current = true;
      return;
    }

    applyTimePeriodDays(timePeriodDays, {
      withHaptic: false,
      selectedDates: fullPeriodDates.length === timePeriodDays ? fullPeriodDates : undefined,
    });
    timeBasedAutofillDoneRef.current = true;
  }, [applyTimePeriodDays, currentMethod, fullPeriodDates, participants, timePeriodDays]);

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
        return timeSplitVariant === 'standard'
          ? computeStandardTimeBased(totalAmount, timePeriodDays, participants)
          : computeTimeBased(totalAmount, participants);
      case 'gamified':
        // gamified is computed on spin, use current state
        return participants;
      case 'itemType':
        return computeItemType(totalAmount, itemCategories, participants);
      default:
        return participants;
    }
  }, [currentMethod, totalAmount, participants, receiptItems, taxAmount, tipAmount, totalParts, itemCategories, timePeriodDays, timeSplitVariant]);

  // Sync computed amounts back (for display in advanced modes)
  const displayParticipants = useMemo(() => {
    if (currentMethod === 'gamified') return participants;
    return computedParticipants;
  }, [currentMethod, computedParticipants, participants]);

  const effectiveTotalAmount = useMemo(
    () => (currentMethod === 'itemized'
      ? receiptItems.reduce((sum, item) => sum + item.price, 0) + taxAmount + tipAmount
      : totalAmount),
    [currentMethod, receiptItems, taxAmount, tipAmount, totalAmount],
  );

  // ── Validation ────────────────────────────────────────────────────────────
  const validation: ValidationResult = useMemo(() => {
    if (currentMethod === 'gamified' && gamifiedMode === 'roulette' && !loserId) {
      return { isValid: false, message: 'Spin to decide!', difference: 0 };
    }
    return validateSplit(effectiveTotalAmount, displayParticipants);
  }, [displayParticipants, effectiveTotalAmount, currentMethod, gamifiedMode, loserId]);

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

    const splitMetadata: ExpenseSplitMetadata = {
      version: 1,
      method: currentMethod,
      participantConfig: displayParticipants.map((participant) => ({
        userId: participant.id,
        included: participant.included,
        exactAmount: participant.exactAmount,
        percentage: participant.percentage,
        shares: participant.shares,
        adjustment: participant.adjustment,
        incomeWeight: participant.incomeWeight,
        historicalPaid: participant.historicalPaid,
        daysStayed: participant.daysStayed,
        checkInDate: participant.checkInDate,
        checkOutDate: participant.checkOutDate,
        selectedStayDates: participant.selectedStayDates,
        partsConsumed: participant.partsConsumed,
        rouletteWeight: participant.rouletteWeight,
        computedAmount: participant.computedAmount,
      })),
      ...(currentMethod === 'itemized' ? {
        receiptItems,
        taxAmount,
        tipAmount,
      } : {}),
      ...(currentMethod === 'consumption' ? {
        totalParts,
      } : {}),
      ...(currentMethod === 'timeBased' ? {
        timeSplitVariant,
        timePeriodDays,
        timePeriodStartDate,
        timePeriodEndDate,
      } : {}),
      ...(currentMethod === 'gamified' ? {
        gamifiedMode,
        rouletteLoserId: gamifiedMode === 'roulette' ? loserId ?? undefined : undefined,
        weightedAssignments: gamifiedMode === 'weightedRoulette' ? weightedAssignments : undefined,
        karmaIntensity: gamifiedMode === 'scrooge' ? karmaIntensity : undefined,
      } : {}),
      ...(currentMethod === 'itemType' ? {
        itemCategories,
      } : {}),
    };

    successHaptic();
    onDone?.({
      paidBy,
      method: currentMethod,
      participants: displayParticipants
        .filter((p) => p.included)
        .map((p) => ({ userId: p.id, share: p.computedAmount })),
      splitMetadata,
      resolvedTotalAmount: effectiveTotalAmount,
    });
  }, [
    canDone,
    currentMethod,
    displayParticipants,
    effectiveTotalAmount,
    gamifiedMode,
    itemCategories,
    karmaIntensity,
    loserId,
    onDone,
    paidBy,
    receiptItems,
    taxAmount,
    timePeriodDays,
    timePeriodEndDate,
    timePeriodStartDate,
    timeSplitVariant,
    tipAmount,
    totalParts,
    weightedAssignments,
  ]);

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
            automaticallyAdjustKeyboardInsets
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
                  onSetAllDays={handleSetAllDays}
                  onStayDatesChange={handleStayDatesChange}
                  timeSplitVariant={timeSplitVariant}
                  onTimeSplitVariantChange={setTimeSplitVariant}
                  timePeriodDays={timePeriodDays}
                  timePeriodStartDate={timePeriodStartDate}
                  timePeriodEndDate={timePeriodEndDate}
                  onTimePeriodRangeChange={handleTimePeriodRangeChange}
                  gamifiedMode={gamifiedMode}
                  onGamifiedModeChange={handleGamifiedModeChange}
                  onRouletteWeightChange={handleRouletteWeightChange}
                  loserId={loserId}
                  onSpin={handleSpin}
                  spinTargetIndex={spinTargetIndex}
                  onSpinComplete={handleWheelSpinComplete}
                  isSpinning={isSpinning}
                  initialWeightedAssignments={weightedAssignments}
                  onWeightedComplete={handleWeightedComplete}
                  initialKarmaIntensity={karmaIntensity}
                  initialKarmaApplied={Boolean(initialSplitMetadata && initialSplitMetadata.gamifiedMode === 'scrooge')}
                  onKarmaIntensityChange={setKarmaIntensity}
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
              totalAmount={effectiveTotalAmount}
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
