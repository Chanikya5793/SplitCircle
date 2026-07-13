import { LiquidBackground } from '@/components/LiquidBackground';
import { useTheme } from '@/context/ThemeContext';
import type { ExpenseSplitMetadata } from '@/models';
import { getSuggestions, recordSplit, type SplitSuggestion } from '@/services/splitHistoryService';
import { spacing } from '@/theme';
import { formatCurrency } from '@/utils/currency';
import { ConfettiBurst } from './ConfettiBurst';
import { heavyHaptic, lightHaptic, mediumHaptic, selectionHaptic, successHaptic } from '@/utils/haptics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Icon, PaperProvider, Text } from 'react-native-paper';
import Animated, { FadeIn, FadeInDown, FadeOut, Layout, SlideInDown, SlideOutDown } from 'react-native-reanimated';

import { AdvancedModeContent } from './AdvancedModeContent';
import { ParticipantList } from './ParticipantList';
import { SmartSuggestionsBar } from './SmartSuggestionsBar';
import { SplitFooter } from './SplitFooter';
import { MethodRail } from './MethodRail';
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
  /** Stable key (group id) that scopes on-device split history & suggestions. */
  contextKey?: string;
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
  contextKey,
  onDone,
  onCancel,
}: BillSplitScreenProps) => {
  const { theme } = useTheme();
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
  // Full-screen winner reveal — dismissible so the result can still be
  // reviewed/tweaked underneath. A reopened saved spin doesn't re-celebrate.
  const [revealDismissed, setRevealDismissed] = useState(Boolean(initialSplitMetadata?.rouletteLoserId));
  const [spinTargetIndex, setSpinTargetIndex] = useState<number | null>(null);
  const [weightedAssignments, setWeightedAssignments] = useState<{ userId: string; percentage: number }[]>(
    initialSplitMetadata?.weightedAssignments ?? [],
  );
  // A locked game reopens at its completed result, not at an empty remainder
  // wheel. That makes Edit a real handoff rather than a broken re-entry.
  const [weightedRevealDismissed, setWeightedRevealDismissed] = useState(
    (initialSplitMetadata?.weightedAssignments ?? []).reduce((sum, assignment) => sum + assignment.percentage, 0) < 100,
  );
  const [karmaIntensity, setKarmaIntensity] = useState(initialSplitMetadata?.karmaIntensity ?? 0.5);
  const [karmaResultActive, setKarmaResultActive] = useState(
    initialSplitMetadata?.gamifiedMode === 'scrooge',
  );
  const [karmaResetKey, setKarmaResetKey] = useState(0);

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
    lightHaptic();
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
    setRevealDismissed(false);
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
    setWeightedRevealDismissed(assignments.reduce((sum, assignment) => sum + assignment.percentage, 0) < 100);
    setLoserId(null);
    setIsSpinning(false);
  }, [totalAmount]);

  const handleWeightedRestart = useCallback(() => {
    mediumHaptic();
    setWeightedRevealDismissed(true);
    setWeightedAssignments([]);
    setParticipants((prev) => prev.map((participant) => ({
      ...participant,
      percentage: 0,
      computedAmount: 0,
    })));
  }, []);

  // ── Karma Complete ────────────────────────────────────────────────────────
  const handleKarmaComplete = useCallback((results: { userId: string; amount: number }[]) => {
    setParticipants((prev) =>
      prev.map((p) => {
        const r = results.find((x) => x.userId === p.id);
        return { ...p, computedAmount: r ? r.amount : 0 };
      }),
    );
    setKarmaResultActive(true);
    setLoserId(null);
    setIsSpinning(false);
  }, []);

  const handleKarmaRestart = useCallback(() => {
    mediumHaptic();
    setKarmaResultActive(false);
    setKarmaResetKey((value) => value + 1);
    setParticipants((prev) => prev.map((participant) => ({ ...participant, computedAmount: 0 })));
  }, []);

  // Toggling who's in from an advanced editor (income rows, game player
  // chips). For games, changing the roster invalidates any spun result.
  const handleAdvancedToggleParticipant = useCallback((id: string) => {
    handleToggle(id);
    if (activeAdvancedMethod === 'gamified') {
      setLoserId(null);
      setSpinTargetIndex(null);
      setIsSpinning(false);
      setRevealDismissed(false);
      setWeightedAssignments([]);
      setWeightedRevealDismissed(true);
      setKarmaResultActive(false);
    }
  }, [activeAdvancedMethod, handleToggle]);

  const handleGamifiedModeChange = useCallback((mode: GamifiedMode) => {
    setGamifiedMode(mode);
    setLoserId(null);
    setSpinTargetIndex(null);
    setIsSpinning(false);
    setWeightedRevealDismissed(true);
    setKarmaResultActive(false);
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

  // ── Smart Suggestions — learned from this group's real split history ──────
  // No history yet → no chips, no reserved space. Every confirmed split
  // sharpens what shows up here next time.
  const [suggestions, setSuggestions] = useState<SplitSuggestion[]>([]);
  useEffect(() => {
    let cancelled = false;
    getSuggestions(contextKey ?? '', initialPayer ?? '').then((result) => {
      if (!cancelled) setSuggestions(result);
    });
    return () => { cancelled = true; };
  }, [contextKey, initialPayer]);

  const applyMethod = useCallback((method: SplitMethod) => {
    if (isBasicMethod(method)) {
      setActiveBasicMethod(method);
      setActiveAdvancedMethod(null);
    } else if (isAdvancedMethod(method)) {
      setActiveAdvancedMethod(method);
    }
  }, []);

  const handleSuggestion = useCallback((id: string) => {
    mediumHaptic();
    const suggestion = suggestions.find((s) => s.id === id);
    if (!suggestion) return;

    if (suggestion.id === 'usual_payer' && suggestion.payerId) {
      if (participants.some((p) => p.id === suggestion.payerId)) setPaidBy(suggestion.payerId);
      return;
    }

    if (suggestion.id === 'usual_method' && suggestion.method) {
      applyMethod(suggestion.method);
      return;
    }

    const record = suggestion.record;
    if (!record) return;

    // Repeat last split: restore payer, method, included set, and — where a
    // ratio meaningfully transfers across bills — each person's proportion.
    if (participants.some((p) => p.id === record.payerId)) setPaidBy(record.payerId);
    applyMethod(record.method);
    const includedSet = new Set(record.includedIds);
    const anyOverlap = participants.some((p) => includedSet.has(p.id));
    if (anyOverlap) {
      setParticipants((prev) => prev.map((p) => {
        const ratio = record.ratios?.[p.id];
        return {
          ...p,
          included: includedSet.has(p.id),
          ...(record.method === 'percentage' && ratio !== undefined
            ? { percentage: Math.round(ratio * 1000) / 10 }
            : {}),
          ...(record.method === 'income' && ratio !== undefined
            ? { incomeWeight: Math.round(ratio * 100) }
            : {}),
        };
      }));
    }
  }, [applyMethod, participants, suggestions]);

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
  const weightedOutcomeRows = useMemo(() => weightedAssignments
    .map((assignment) => {
      const participant = participants.find((item) => item.id === assignment.userId);
      return {
        id: assignment.userId,
        name: participant?.name ?? 'Unknown',
        percentage: assignment.percentage,
        amount: totalAmount * assignment.percentage / 100,
      };
    })
    .sort((a, b) => b.percentage - a.percentage), [participants, totalAmount, weightedAssignments]);
  const weightedSplitComplete = weightedOutcomeRows.reduce((sum, row) => sum + row.percentage, 0) >= 100;
  const karmaOutcomeRows = useMemo(() => displayParticipants
    .filter((participant) => participant.included)
    .map((participant) => ({ id: participant.id, name: participant.name, amount: participant.computedAmount }))
    .sort((a, b) => b.amount - a.amount), [displayParticipants]);

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

    // Teach the suggestion engine (device-local, fire-and-forget).
    if (contextKey) {
      const includedForRecord = displayParticipants.filter((p) => p.included);
      const ratios: Record<string, number> = {};
      if (effectiveTotalAmount > 0) {
        includedForRecord.forEach((p) => {
          ratios[p.id] = Math.round((p.computedAmount / effectiveTotalAmount) * 1000) / 1000;
        });
      }
      void recordSplit(contextKey, {
        at: Date.now(),
        method: currentMethod,
        gamifiedMode: currentMethod === 'gamified' ? gamifiedMode : undefined,
        payerId: paidBy,
        payerName: participants.find((p) => p.id === paidBy)?.name ?? '',
        includedIds: includedForRecord.map((p) => p.id),
        totalAmount: effectiveTotalAmount,
        ratios: effectiveTotalAmount > 0 ? ratios : undefined,
      });
    }

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
    contextKey,
    participants,
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
        <View style={[styles.container, { backgroundColor: theme.dark ? 'rgba(13,15,20,0.94)' : 'rgba(250,250,252,0.96)' }]}>
          {/* Header — title + payer share one block so no separate payer row
              burns vertical space below. Tapping the subtitle opens the payer
              picker as an overlay. */}
          <View style={[styles.header, { borderBottomColor: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)' }]}>
            <TouchableOpacity onPress={onCancel} activeOpacity={0.7} style={styles.headerSide}>
              <Text variant="labelLarge" style={{ color: theme.colors.primary }}>Cancel</Text>
            </TouchableOpacity>
            <Pressable
              style={({ pressed }) => [styles.headerCenter, pressed && { opacity: 0.6 }]}
              onPress={() => { selectionHaptic(); setShowPayerMenu((v) => !v); }}
              accessibilityRole="button"
              accessibilityLabel={`Paid by ${payerName}. Tap to change payer`}
            >
              <Text variant="titleMedium" style={[styles.headerTitle, { color: theme.colors.onSurface }]}>
                Split options
              </Text>
              <View style={styles.headerPayerRow}>
                <Text variant="labelSmall" style={{ color: theme.colors.muted }}>
                  Paid by{' '}
                  <Text variant="labelSmall" style={{ color: theme.colors.primary, fontWeight: '700' }}>{payerName}</Text>
                </Text>
                <Icon source={showPayerMenu ? 'chevron-up' : 'chevron-down'} size={13} color={theme.colors.primary} />
              </View>
            </Pressable>
            <TouchableOpacity
              onPress={handleDone}
              activeOpacity={0.7}
              disabled={!canDone}
              style={[styles.headerSide, { alignItems: 'flex-end' }]}
            >
              <Text
                variant="labelLarge"
                style={{
                  color: canDone ? theme.colors.primary : theme.colors.muted,
                  fontWeight: '700',
                }}
              >
                Done
              </Text>
            </TouchableOpacity>
          </View>

          {/* Payer picker — overlay under the header, solid surface */}
          {showPayerMenu && (
            <Animated.View entering={FadeInDown.duration(150)} exiting={FadeOut.duration(120)} style={styles.payerOverlay}>
              <View style={[
                styles.payerDropdownInner,
                {
                  backgroundColor: theme.dark ? 'rgba(28,31,38,0.99)' : 'rgba(255,255,255,0.99)',
                  borderColor: theme.dark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)',
                },
              ]}>
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
              </View>
            </Animated.View>
          )}

          {/* Learned suggestions — only when this group has real history.
              Lives OUTSIDE the ScrollView: the row loads async, and inserting
              a sibling above Reanimated entering-animated scroll content
              leaves that content un-shifted (overlap). Out here, insertion
              just resizes the flex ScrollView — deterministic. */}
          {suggestions.length > 0 && (
            <View style={styles.suggestionsRow}>
              <SmartSuggestionsBar suggestions={suggestions} onSelect={handleSuggestion} />
            </View>
          )}

          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
          >
            {/* Method rail — all eleven methods, one line, always visible */}
            <MethodRail
              activeMethod={currentMethod}
              onSelectBasic={handleBasicMethodSelect}
              onSelectAdvanced={handleAdvancedMethodSelect}
            />


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
                  onToggleParticipant={handleAdvancedToggleParticipant}
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
                  karmaResetKey={karmaResetKey}
                  onKarmaIntensityChange={setKarmaIntensity}
                  onKarmaComplete={handleKarmaComplete}
                  itemCategories={itemCategories}
                  onItemCategoriesChange={setItemCategories}
                />
              </Animated.View>
            )}

          </ScrollView>

          {/* Full-screen winner reveal — the payoff owns the WHOLE screen,
              footer included. Nothing celebratory ever hides behind chrome. */}
          {currentMethod === 'gamified' && gamifiedMode === 'roulette' && loserId && !isSpinning && !revealDismissed && (
            <Animated.View
              entering={FadeIn.duration(220)}
              exiting={FadeOut.duration(150)}
              style={[styles.winnerOverlay, { backgroundColor: theme.dark ? 'rgba(13,15,20,0.98)' : 'rgba(250,250,252,0.99)' }]}
            >
              <ConfettiBurst key={loserId} />
              <TouchableOpacity
                style={styles.winnerClose}
                onPress={() => { lightHaptic(); setRevealDismissed(true); }}
                accessibilityLabel="Close winner reveal"
              >
                <Icon source="close" size={22} color={theme.colors.muted} />
              </TouchableOpacity>

              <View style={styles.winnerCenter}>
                <Text style={[styles.winnerKicker, { color: theme.colors.muted }]}>THE WHEEL HAS SPOKEN</Text>
                <Text style={[styles.winnerName, { color: theme.colors.onSurface }]} numberOfLines={1} adjustsFontSizeToFit>
                  {participants.find((p) => p.id === loserId)?.name ?? '—'}
                </Text>
                <Text style={[styles.winnerAmount, { color: theme.colors.primary }]}>
                  pays {formatCurrency(effectiveTotalAmount, currency)}
                </Text>
                {included.length > 1 && (
                  <Text variant="bodyMedium" style={{ color: theme.colors.muted }}>
                    {included.length - 1} {included.length - 1 === 1 ? 'friend eats' : 'friends eat'} free tonight
                  </Text>
                )}
              </View>

              <View style={styles.winnerActions}>
                <TouchableOpacity
                  style={[styles.winnerSecondaryBtn, { borderColor: theme.dark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.16)' }]}
                  onPress={handleSpin}
                  activeOpacity={0.8}
                >
                  <Icon source="rotate-right" size={17} color={theme.colors.onSurface} />
                  <Text style={{ color: theme.colors.onSurface, fontSize: 15, fontWeight: '700' }}>Spin again</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.winnerPrimaryBtn, { backgroundColor: theme.colors.success }]}
                  onPress={handleDone}
                  activeOpacity={0.8}
                >
                  <Icon source="check" size={17} color="#FFF" />
                  <Text style={{ color: '#FFF', fontSize: 15, fontWeight: '800' }}>Lock it in</Text>
                </TouchableOpacity>
              </View>
            </Animated.View>
          )}

          {/* Double Wheel uses the same payoff rule as Roulette: completion is
              a destination, not a card stranded below a scrolling editor. */}
          {currentMethod === 'gamified' && gamifiedMode === 'weightedRoulette' && weightedSplitComplete && !weightedRevealDismissed && (
            <Animated.View
              entering={FadeIn.duration(220)}
              exiting={FadeOut.duration(150)}
              style={[styles.winnerOverlay, { backgroundColor: theme.dark ? 'rgba(13,15,20,0.98)' : 'rgba(250,250,252,0.99)' }]}
            >
              <ConfettiBurst key={weightedOutcomeRows.map((row) => `${row.id}:${row.percentage}`).join('|')} />
              <TouchableOpacity
                style={styles.winnerClose}
                onPress={() => { lightHaptic(); setWeightedRevealDismissed(true); }}
                accessibilityLabel="Close split result"
              >
                <Icon source="close" size={22} color={theme.colors.muted} />
              </TouchableOpacity>

              <View style={styles.weightedOutcomeHeader}>
                <Text style={[styles.winnerKicker, { color: theme.colors.muted }]}>SHARES ASSIGNED</Text>
                <Text style={[styles.weightedOutcomeTitle, { color: theme.colors.onSurface }]}>The split is set</Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.muted }}>Everyone can see their final share.</Text>
              </View>

              <ScrollView style={[
                styles.weightedOutcomeList,
                { backgroundColor: theme.dark ? 'rgba(28,31,38,0.98)' : 'rgba(255,255,255,0.98)', borderColor: theme.dark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)' },
              ]} showsVerticalScrollIndicator={false}>
                {weightedOutcomeRows.map((row, index) => (
                  <View key={row.id} style={[
                    styles.weightedOutcomeRow,
                    index < weightedOutcomeRows.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)' },
                  ]}>
                    <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, fontWeight: '700', flex: 1 }} numberOfLines={1}>{row.name}</Text>
                    <Text variant="titleMedium" style={{ color: theme.colors.primary, fontWeight: '800' }}>{row.percentage}%</Text>
                    <Text variant="bodyMedium" style={{ color: theme.colors.muted, width: 78, textAlign: 'right' }}>{formatCurrency(row.amount, currency)}</Text>
                  </View>
                ))}
              </ScrollView>

              <View style={styles.winnerActions}>
                <TouchableOpacity
                  style={[styles.winnerSecondaryBtn, { borderColor: theme.dark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.16)' }]}
                  onPress={handleWeightedRestart}
                  activeOpacity={0.8}
                >
                  <Icon source="rotate-right" size={17} color={theme.colors.onSurface} />
                  <Text style={{ color: theme.colors.onSurface, fontSize: 15, fontWeight: '700' }}>Spin again</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.winnerPrimaryBtn, { backgroundColor: theme.colors.success }]}
                  onPress={handleDone}
                  activeOpacity={0.8}
                >
                  <Icon source="check" size={17} color="#FFF" />
                  <Text style={{ color: '#FFF', fontSize: 15, fontWeight: '800' }}>Lock it in</Text>
                </TouchableOpacity>
              </View>
            </Animated.View>
          )}

          {/* Karma has the same result contract as the two wheels. Its applied
              split is reviewed in a dedicated result layer, never an inline
              card that competes with the editor or footer. */}
          {currentMethod === 'gamified' && gamifiedMode === 'scrooge' && karmaResultActive && (
            <Animated.View
              entering={FadeIn.duration(220)}
              exiting={FadeOut.duration(150)}
              style={[styles.winnerOverlay, { backgroundColor: theme.dark ? 'rgba(13,15,20,0.98)' : 'rgba(250,250,252,0.99)' }]}
            >
              <ConfettiBurst key={karmaOutcomeRows.map((row) => `${row.id}:${row.amount}`).join('|')} />
              <TouchableOpacity
                style={styles.winnerClose}
                onPress={() => { lightHaptic(); setKarmaResultActive(false); }}
                accessibilityLabel="Close karma result"
              >
                <Icon source="close" size={22} color={theme.colors.muted} />
              </TouchableOpacity>

              <View style={styles.weightedOutcomeHeader}>
                <Text style={[styles.winnerKicker, { color: theme.colors.muted }]}>KARMA APPLIED</Text>
                <Text style={[styles.weightedOutcomeTitle, { color: theme.colors.onSurface }]}>The split is balanced</Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.muted }}>Past contributions are reflected in every share.</Text>
              </View>

              <ScrollView style={[
                styles.weightedOutcomeList,
                { backgroundColor: theme.dark ? 'rgba(28,31,38,0.98)' : 'rgba(255,255,255,0.98)', borderColor: theme.dark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)' },
              ]} showsVerticalScrollIndicator={false}>
                {karmaOutcomeRows.map((row, index) => (
                  <View key={row.id} style={[
                    styles.weightedOutcomeRow,
                    index < karmaOutcomeRows.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)' },
                  ]}>
                    <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, fontWeight: '700', flex: 1 }} numberOfLines={1}>{row.name}</Text>
                    <Text variant="titleMedium" style={{ color: theme.colors.primary, fontWeight: '800' }}>{formatCurrency(row.amount, currency)}</Text>
                  </View>
                ))}
              </ScrollView>

              <View style={styles.winnerActions}>
                <TouchableOpacity
                  style={[styles.winnerSecondaryBtn, { borderColor: theme.dark ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.16)' }]}
                  onPress={handleKarmaRestart}
                  activeOpacity={0.8}
                >
                  <Icon source="tune-variant" size={17} color={theme.colors.onSurface} />
                  <Text style={{ color: theme.colors.onSurface, fontSize: 15, fontWeight: '700' }}>Adjust split</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.winnerPrimaryBtn, { backgroundColor: theme.colors.success }]}
                  onPress={handleDone}
                  activeOpacity={0.8}
                >
                  <Icon source="check" size={17} color="#FFF" />
                  <Text style={{ color: '#FFF', fontSize: 15, fontWeight: '800' }}>Lock it in</Text>
                </TouchableOpacity>
              </View>
            </Animated.View>
          )}

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
    // Presented as a pageSheet — the card already sits below the status bar,
    // so the old 56px of top padding was pure dead space.
    paddingTop: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerSide: {
    minWidth: 56,
  },
  headerCenter: {
    alignItems: 'center',
    gap: 1,
  },
  headerPayerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  headerTitle: {
    fontWeight: '700',
  },
  payerOverlay: {
    position: 'absolute',
    top: 64,
    left: spacing.md,
    right: spacing.md,
    zIndex: 50,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 12,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: spacing.sm,
    gap: spacing.sm,
    paddingBottom: spacing.lg,
  },
  suggestionsRow: {
    minHeight: 34,
    marginBottom: spacing.sm,
  },
  payerDropdownInner: {
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
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
  footerWrapper: {
    // Docked in normal flow (the ScrollView flexes above it) — nothing can
    // ever hide underneath, and no bottom padding needs reserving.
    paddingBottom: 30,
  },
  winnerOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 56,
    paddingBottom: 124,
  },
  winnerClose: {
    position: 'absolute',
    top: 18,
    right: 18,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  winnerCenter: {
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.xl,
  },
  weightedOutcomeHeader: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.lg,
  },
  weightedOutcomeTitle: {
    fontSize: 32,
    fontWeight: '900',
    textAlign: 'center',
  },
  weightedOutcomeList: {
    alignSelf: 'stretch',
    marginHorizontal: spacing.md,
    maxHeight: '52%',
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  weightedOutcomeRow: {
    minHeight: 58,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  winnerKicker: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 3,
  },
  winnerName: {
    fontSize: 44,
    fontWeight: '900',
    textAlign: 'center',
  },
  winnerAmount: {
    fontSize: 22,
    fontWeight: '800',
  },
  winnerActions: {
    position: 'absolute',
    bottom: 44,
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    gap: 10,
  },
  winnerSecondaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
  },
  winnerPrimaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: 26,
  },
});
