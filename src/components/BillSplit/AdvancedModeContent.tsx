import { GlassView } from '@/components/GlassView';
import { colors, darkColors, spacing } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import { formatCurrency } from '@/utils/currency';
import { heavyHaptic, lightHaptic, mediumHaptic, successHaptic } from '@/utils/haptics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Button, Icon, IconButton, Text } from 'react-native-paper';
import Animated, { FadeIn, FadeInDown, ZoomIn, runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import type { RouletteWheelRef } from './RouletteWheel';
import RouletteWheel from './RouletteWheel';
import { computeKarma, listDatesBetween } from './splitMath';
import type { AdvancedSplitMethod, GamifiedMode, ItemCategory, Participant, ReceiptItem, TimeSplitVariant } from './types';
import type { WeightedRouletteWheelRef } from './WeightedRouletteWheel';
import WeightedRouletteWheel, { generatePercentageOptions } from './WeightedRouletteWheel';

const AVATAR_COLORS = ['#4F46E5', '#0891B2', '#059669', '#D97706', '#DC2626', '#7C3AED'];

function getInitials(name: string): string {
  return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
}

function getDateChipLabel(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, (month ?? 1) - 1, day ?? 1);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function parseCalendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const day = Number(dayText);
  const date = new Date(year, monthIndex, day);

  if (
    Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== monthIndex
    || date.getDate() !== day
  ) {
    return null;
  }

  date.setHours(0, 0, 0, 0);
  return date;
}

function toCalendarIso(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addCalendarMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function getCalendarMonthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getCalendarMonthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function getCalendarMonthKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  return `${year}-${month}`;
}

function buildCalendarMonthCells(monthDate: Date): Array<string | null> {
  const start = getCalendarMonthStart(monthDate);
  const firstWeekday = start.getDay();
  const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const cells: Array<string | null> = [];

  for (let i = 0; i < firstWeekday; i += 1) {
    cells.push(null);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(toCalendarIso(new Date(start.getFullYear(), start.getMonth(), day)));
  }

  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  return cells;
}

function isWeekendCalendarDate(value: string): boolean {
  const date = parseCalendarDate(value);
  if (!date) return false;
  const day = date.getDay();
  return day === 0 || day === 6;
}

function splitDatesByType(dates: string[]): {
  longWeekends: string[];
  weekdays: string[];
  weekdaysNoFriday: string[];
  weekends: string[];
} {
  const longWeekends: string[] = [];
  const weekdays: string[] = [];
  const weekdaysNoFriday: string[] = [];
  const weekends: string[] = [];

  dates.forEach((value) => {
    const date = parseCalendarDate(value);
    if (!date) return;
    const day = date.getDay();

    if (day === 5 || day === 6 || day === 0) {
      longWeekends.push(value);
    }

    if (day === 0 || day === 6) {
      weekends.push(value);
    }

    if (day >= 1 && day <= 5) {
      weekdays.push(value);
    }

    if (day >= 1 && day <= 4) {
      weekdaysNoFriday.push(value);
    }
  });

  return {
    longWeekends,
    weekdays,
    weekdaysNoFriday,
    weekends,
  };
}

function addScopedDates(selectedDates: Set<string>, datesToAdd: string[]): string[] {
  return Array.from(new Set([...Array.from(selectedDates), ...datesToAdd])).sort();
}

function removeScopedDates(selectedDates: Set<string>, datesToRemove: string[]): string[] {
  const removalSet = new Set(datesToRemove);
  return Array.from(selectedDates).filter((value) => !removalSet.has(value));
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

interface CalendarMonthGridProps {
  accentColor: string;
  enabledDates?: Set<string>;
  monthDate: Date;
  onPressDate: (value: string) => void;
  rangeEnd?: string;
  rangeStart?: string;
  selectedDates?: Set<string>;
}

const CalendarMonthGrid = React.memo(({
  accentColor,
  enabledDates,
  monthDate,
  onPressDate,
  rangeEnd,
  rangeStart,
  selectedDates,
}: CalendarMonthGridProps) => {
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;
  const monthCells = useMemo(() => buildCalendarMonthCells(monthDate), [monthDate]);
  const normalizedRangeStart = rangeStart && rangeEnd ? (rangeStart <= rangeEnd ? rangeStart : rangeEnd) : rangeStart;
  const normalizedRangeEnd = rangeStart && rangeEnd ? (rangeStart <= rangeEnd ? rangeEnd : rangeStart) : rangeEnd;

  return (
    <GlassView style={styles.calendarMonthCard} intensity={10}>
      <View style={styles.calendarMonthHeader}>
        <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
          {getCalendarMonthLabel(monthDate)}
        </Text>
      </View>

      <View style={styles.calendarWeekHeader}>
        {WEEKDAY_LABELS.map((label, index) => (
          <Text key={`${label}-${index}`} style={[styles.calendarWeekLabel, { color: palette.muted }]}>
            {label}
          </Text>
        ))}
      </View>

      <View style={styles.calendarGrid}>
        {monthCells.map((value, index) => {
          if (!value) {
            return <View key={`empty-${index}`} style={styles.calendarEmptyCell} />;
          }

          const dayNumber = Number(value.slice(-2));
          const isEnabled = !enabledDates || enabledDates.has(value);
          const isSelected = selectedDates?.has(value) ?? false;
          const isRangeStart = Boolean(rangeStart && value === rangeStart);
          const isRangeEnd = Boolean(rangeEnd && value === rangeEnd);
          const isPendingStart = Boolean(rangeStart && !rangeEnd && value === rangeStart);
          const isInRange = Boolean(
            normalizedRangeStart
            && normalizedRangeEnd
            && value >= normalizedRangeStart
            && value <= normalizedRangeEnd,
          );
          const showSolidSelection = isSelected || isRangeStart || isRangeEnd || isPendingStart;

          return (
            <TouchableOpacity
              key={value}
              disabled={!isEnabled}
              style={styles.calendarCellWrap}
              onPress={() => onPressDate(value)}
            >
              <View
                style={[
                  styles.calendarDayCell,
                  {
                    backgroundColor: showSolidSelection
                      ? accentColor
                      : isInRange
                        ? `${accentColor}16`
                        : 'transparent',
                    borderColor: showSolidSelection
                      ? accentColor
                      : isInRange
                        ? `${accentColor}44`
                        : palette.border,
                    opacity: isEnabled ? 1 : 0.3,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.calendarDayText,
                    {
                      color: showSolidSelection ? '#FFFFFF' : theme.colors.onSurface,
                    },
                  ]}
                >
                  {dayNumber}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </GlassView>
  );
});

CalendarMonthGrid.displayName = 'CalendarMonthGrid';

interface TimeValueSliderProps {
  accentColor: string;
  isDark: boolean;
  maximumValue: number;
  minimumValue: number;
  onSlidingComplete?: () => void;
  onValueChange: (value: number) => void;
  value: number;
}

const THUMB_SIZE = 24;
const TRACK_HEIGHT = 6;

const TimeValueSlider = ({
  accentColor,
  isDark,
  maximumValue,
  minimumValue,
  onSlidingComplete,
  onValueChange,
  value,
}: TimeValueSliderProps) => {
  const range = Math.max(1, maximumValue - minimumValue);
  const clampedValue = Math.min(maximumValue, Math.max(minimumValue, value));
  const fraction = (clampedValue - minimumValue) / range;

  const trackWidth = useSharedValue(0);
  const thumbX = useSharedValue(0);
  const startX = useSharedValue(0);
  const isDragging = useSharedValue(false);
  const lastSteppedValue = useSharedValue(clampedValue);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const w = event.nativeEvent.layout.width;
    trackWidth.value = w;
    thumbX.value = fraction * w;
  }, [fraction, thumbX, trackWidth]);

  // Sync external value changes when not dragging
  useEffect(() => {
    if (!isDragging.value && trackWidth.value > 0) {
      thumbX.value = fraction * trackWidth.value;
      lastSteppedValue.value = clampedValue;
    }
  }, [clampedValue, fraction, isDragging, lastSteppedValue, thumbX, trackWidth]);

  const emitValue = useCallback((x: number, withHaptic: boolean) => {
    const w = trackWidth.value;
    if (w <= 0) return;
    const ratio = Math.max(0, Math.min(1, x / w));
    const stepped = Math.round(ratio * range + minimumValue);
    if (withHaptic && stepped !== lastSteppedValue.value) {
      lightHaptic();
    }
    lastSteppedValue.value = stepped;
    onValueChange(stepped);
  }, [lastSteppedValue, minimumValue, onValueChange, range, trackWidth]);

  const emitComplete = useCallback(() => {
    onSlidingComplete?.();
  }, [onSlidingComplete]);

  const panGesture = Gesture.Pan()
    .hitSlop({ top: 16, bottom: 16, left: 8, right: 8 })
    .onStart(() => {
      isDragging.value = true;
      startX.value = thumbX.value;
    })
    .onUpdate((event) => {
      const newX = Math.max(0, Math.min(trackWidth.value, startX.value + event.translationX));
      thumbX.value = newX;
      runOnJS(emitValue)(newX, true);
    })
    .onEnd(() => {
      isDragging.value = false;
      runOnJS(emitComplete)();
    })
    .onFinalize(() => {
      isDragging.value = false;
    });

  const tapGesture = Gesture.Tap()
    .onEnd((event) => {
      const tapX = Math.max(0, Math.min(trackWidth.value, event.x));
      thumbX.value = tapX;
      runOnJS(emitValue)(tapX, true);
      runOnJS(emitComplete)();
    });

  const gesture = Gesture.Exclusive(panGesture, tapGesture);

  const trackColor = isDark ? 'rgba(255,255,255,0.18)' : 'rgba(15,23,42,0.12)';

  const fillStyle = useAnimatedStyle(() => ({
    width: thumbX.value,
    backgroundColor: accentColor,
  }));

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: thumbX.value - THUMB_SIZE / 2 }],
  }));

  return (
    <View style={styles.timeSliderInner}>
      <GestureDetector gesture={gesture}>
        <View style={styles.timeSliderTouchArea} onLayout={onLayout}>
          <View style={[styles.timeSliderTrack, { backgroundColor: trackColor }]}>
            <Animated.View style={[styles.timeSliderFill, fillStyle]} />
          </View>
          <Animated.View style={[styles.timeSliderThumb, { backgroundColor: accentColor }, thumbStyle]}>
            <View style={[styles.timeSliderThumbInner, { backgroundColor: isDark ? '#1e1e1e' : '#fff' }]} />
          </Animated.View>
        </View>
      </GestureDetector>
    </View>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// A. ITEMIZED RECEIPT SPLIT
// ═══════════════════════════════════════════════════════════════════════════════
interface ItemizedReceiptProps {
  items: ReceiptItem[];
  onItemsChange: (items: ReceiptItem[]) => void;
  taxAmount: number;
  onTaxChange: (v: number) => void;
  tipAmount: number;
  onTipChange: (v: number) => void;
  participants: Participant[];
  currency: string;
}

const ItemizedReceiptMode = React.memo(({
  items, onItemsChange, taxAmount, onTaxChange, tipAmount, onTipChange, participants, currency,
}: ItemizedReceiptProps) => {
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;

  const addItem = useCallback(() => {
    lightHaptic();
    onItemsChange([...items, { id: `item_${Date.now()}`, name: '', price: 0, assignedTo: [] }]);
  }, [items, onItemsChange]);

  const updateItem = useCallback((id: string, field: keyof ReceiptItem, value: string | number | string[]) => {
    onItemsChange(items.map((it) => (it.id === id ? { ...it, [field]: value } : it)));
  }, [items, onItemsChange]);

  const removeItem = useCallback((id: string) => {
    mediumHaptic();
    onItemsChange(items.filter((it) => it.id !== id));
  }, [items, onItemsChange]);

  const toggleAssignment = useCallback((itemId: string, userId: string) => {
    lightHaptic();
    const item = items.find((it) => it.id === itemId);
    if (!item) return;
    const assigned = item.assignedTo.includes(userId)
      ? item.assignedTo.filter((id) => id !== userId)
      : [...item.assignedTo, userId];
    updateItem(itemId, 'assignedTo', assigned);
  }, [items, updateItem]);

  const subtotal = items.reduce((s, it) => s + it.price, 0);

  return (
    <View style={styles.section}>
      <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
        Receipt Items
      </Text>

      {items.map((item, idx) => (
        <Animated.View key={item.id} entering={FadeInDown.delay(idx * 40).springify()}>
          <GlassView style={styles.itemCard} intensity={15}>
            <View style={styles.itemRow}>
              <TextInput
                style={[styles.itemNameInput, { color: theme.colors.onSurface, borderColor: palette.border }]}
                value={item.name}
                onChangeText={(v) => updateItem(item.id, 'name', v)}
                placeholder="Item name"
                placeholderTextColor={palette.muted}
              />
              <View style={styles.itemPriceRow}>
                <Text style={{ color: palette.muted }}>$</Text>
                <TextInput
                  style={[styles.itemPriceInput, { color: theme.colors.onSurface, borderColor: palette.border }]}
                  value={item.price > 0 ? item.price.toString() : ''}
                  onChangeText={(v) => updateItem(item.id, 'price', parseFloat(v) || 0)}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={palette.muted}
                />
              </View>
              <IconButton icon="close-circle" size={18} iconColor={palette.muted} onPress={() => removeItem(item.id)} />
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.assignRow}>
              {participants.filter((p) => p.included).map((p, pi) => {
                const isAssigned = item.assignedTo.includes(p.id);
                return (
                  <TouchableOpacity
                    key={p.id}
                    onPress={() => toggleAssignment(item.id, p.id)}
                    style={[
                      styles.assignChip,
                      { backgroundColor: isAssigned ? `${theme.colors.primary}20` : 'transparent', borderColor: isAssigned ? theme.colors.primary : palette.border },
                    ]}
                  >
                    <View style={[styles.miniAvatar, { backgroundColor: AVATAR_COLORS[pi % AVATAR_COLORS.length] }]}>
                      <Text style={styles.miniInitials}>{getInitials(p.name)}</Text>
                    </View>
                    <Text style={[styles.assignName, { color: isAssigned ? theme.colors.primary : palette.muted }]}>{p.name.split(' ')[0]}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </GlassView>
        </Animated.View>
      ))}

      <Button mode="outlined" icon="plus" onPress={addItem} style={styles.addBtn}>
        Add Item
      </Button>

      <View style={styles.extraRow}>
        <View style={styles.extraField}>
          <Text variant="bodySmall" style={{ color: palette.muted }}>Tax</Text>
          <View style={styles.inputRow}>
            <Text style={{ color: palette.muted }}>$</Text>
            <TextInput
              style={[styles.extraInput, { color: theme.colors.onSurface, borderColor: palette.border }]}
              value={taxAmount > 0 ? taxAmount.toString() : ''}
              onChangeText={(v) => onTaxChange(parseFloat(v) || 0)}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={palette.muted}
            />
          </View>
        </View>
        <View style={styles.extraField}>
          <Text variant="bodySmall" style={{ color: palette.muted }}>Tip</Text>
          <View style={styles.inputRow}>
            <Text style={{ color: palette.muted }}>$</Text>
            <TextInput
              style={[styles.extraInput, { color: theme.colors.onSurface, borderColor: palette.border }]}
              value={tipAmount > 0 ? tipAmount.toString() : ''}
              onChangeText={(v) => onTipChange(parseFloat(v) || 0)}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={palette.muted}
            />
          </View>
        </View>
      </View>

      <Text variant="bodySmall" style={[styles.hint, { color: palette.muted }]}>
        Subtotal: {formatCurrency(subtotal, currency)} · Tax & tip are prorated by each person's subtotal share.
      </Text>
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. INCOME-PROPORTIONAL
// ═══════════════════════════════════════════════════════════════════════════════
interface IncomeProps {
  participants: Participant[];
  onWeightChange: (id: string, weight: string) => void;
  currency: string;
}

const IncomeProportionalMode = React.memo(({ participants, onWeightChange, currency }: IncomeProps) => {
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;
  const included = participants.filter((p) => p.included);
  const totalWeight = included.reduce((s, p) => s + p.incomeWeight, 0);

  return (
    <View style={styles.section}>
      <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
        Income / Weight Ratios
      </Text>
      <Text variant="bodySmall" style={[styles.hint, { color: palette.muted }]}>
        Enter annual salary or arbitrary weight for each person. The bill is split proportionally.
      </Text>

      {participants.map((p, index) => {
        const pct = totalWeight > 0 ? ((p.incomeWeight / totalWeight) * 100).toFixed(1) : '0';
        return (
          <Animated.View key={p.id} entering={FadeInDown.delay(index * 40).springify()}>
            <View style={styles.incomeRow}>
              <View style={[styles.miniAvatar, { backgroundColor: AVATAR_COLORS[index % AVATAR_COLORS.length] }]}>
                <Text style={styles.miniInitials}>{getInitials(p.name)}</Text>
              </View>
              <Text style={[styles.incomeName, { color: theme.colors.onSurface }]}>{p.name}</Text>
              <TextInput
                style={[styles.incomeInput, { color: theme.colors.onSurface, borderColor: palette.border }]}
                value={p.incomeWeight > 0 ? p.incomeWeight.toString() : ''}
                onChangeText={(v) => onWeightChange(p.id, v)}
                keyboardType="numeric"
                placeholder="0"
                placeholderTextColor={palette.muted}
              />
              <Text variant="bodySmall" style={[styles.incomePct, { color: palette.muted }]}>
                {pct}%
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.primary, fontWeight: '600', minWidth: 60, textAlign: 'right' }}>
                {formatCurrency(p.computedAmount, currency)}
              </Text>
            </View>
          </Animated.View>
        );
      })}
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. CONSUMPTION / FRACTION
// ═══════════════════════════════════════════════════════════════════════════════
interface ConsumptionProps {
  totalParts: number;
  onTotalPartsChange: (v: number) => void;
  participants: Participant[];
  onPartsChange: (id: string, parts: string) => void;
  currency: string;
}

const ConsumptionMode = React.memo(({ totalParts, onTotalPartsChange, participants, onPartsChange, currency }: ConsumptionProps) => {
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;
  const consumed = participants.filter((p) => p.included).reduce((s, p) => s + p.partsConsumed, 0);

  return (
    <View style={styles.section}>
      <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
        Consumption Split
      </Text>
      <Text variant="bodySmall" style={[styles.hint, { color: palette.muted }]}>
        How many total parts? Assign how many each person consumed.
      </Text>

      <View style={styles.totalPartsRow}>
        <Text style={{ color: theme.colors.onSurface, fontWeight: '600' }}>Total parts:</Text>
        <View style={styles.shareControls}>
          <TouchableOpacity
            style={[styles.shareBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
            onPress={() => { lightHaptic(); onTotalPartsChange(Math.max(1, totalParts - 1)); }}
          >
            <Text style={[styles.shareBtnText, { color: theme.colors.onSurface }]}>−</Text>
          </TouchableOpacity>
          <Text style={[styles.shareValue, { color: theme.colors.onSurface }]}>{totalParts}</Text>
          <TouchableOpacity
            style={[styles.shareBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
            onPress={() => { lightHaptic(); onTotalPartsChange(totalParts + 1); }}
          >
            <Text style={[styles.shareBtnText, { color: theme.colors.onSurface }]}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      {consumed > totalParts && (
        <Text style={[styles.warningText, { color: colors.danger }]}>
          ⚠ Consumed parts ({consumed}) exceed total ({totalParts})
        </Text>
      )}

      {participants.filter((p) => p.included).map((p, index) => (
        <Animated.View key={p.id} entering={FadeInDown.delay(index * 40).springify()}>
          <View style={styles.incomeRow}>
            <View style={[styles.miniAvatar, { backgroundColor: AVATAR_COLORS[index % AVATAR_COLORS.length] }]}>
              <Text style={styles.miniInitials}>{getInitials(p.name)}</Text>
            </View>
            <Text style={[styles.incomeName, { color: theme.colors.onSurface }]}>{p.name}</Text>
            <View style={styles.shareControls}>
              <TouchableOpacity
                style={[styles.shareBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
                onPress={() => { lightHaptic(); onPartsChange(p.id, Math.max(0, p.partsConsumed - 1).toString()); }}
              >
                <Text style={[styles.shareBtnText, { color: theme.colors.onSurface }]}>−</Text>
              </TouchableOpacity>
              <Text style={[styles.shareValue, { color: theme.colors.onSurface }]}>{p.partsConsumed}</Text>
              <TouchableOpacity
                style={[styles.shareBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
                onPress={() => { lightHaptic(); onPartsChange(p.id, (p.partsConsumed + 1).toString()); }}
              >
                <Text style={[styles.shareBtnText, { color: theme.colors.onSurface }]}>+</Text>
              </TouchableOpacity>
            </View>
            <Text variant="bodySmall" style={{ color: theme.colors.primary, fontWeight: '600', minWidth: 60, textAlign: 'right' }}>
              {formatCurrency(p.computedAmount, currency)}
            </Text>
          </View>
        </Animated.View>
      ))}
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. TIME-BASED / PRORATED
// ═══════════════════════════════════════════════════════════════════════════════
interface TimeBasedProps {
  participants: Participant[];
  onDaysChange: (id: string, days: string) => void;
  onDateRangeChange: (id: string, checkIn: string, checkOut: string) => void;
  onSetAllDays: (days: number) => void;
  onStayDatesChange: (id: string, dates: string[]) => void;
  currency: string;
  totalAmount: number;
  timeSplitVariant: TimeSplitVariant;
  onTimeSplitVariantChange: (variant: TimeSplitVariant) => void;
  timePeriodDays: number;
  timePeriodStartDate: string;
  timePeriodEndDate: string;
  onTimePeriodRangeChange: (startDate: string, endDate: string) => void;
}

type TimeInputMode = 'days' | 'dates';

const DURATION_PRESETS = [
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 },
];

const TimeBasedMode = React.memo(({
  participants,
  onDaysChange,
  onDateRangeChange,
  onSetAllDays,
  onStayDatesChange,
  currency,
  totalAmount,
  timeSplitVariant,
  onTimeSplitVariantChange,
  timePeriodDays,
  timePeriodStartDate,
  timePeriodEndDate,
  onTimePeriodRangeChange,
}: TimeBasedProps) => {
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;
  const [inputMode, setInputMode] = useState<TimeInputMode>('days');
  const [periodInputValue, setPeriodInputValue] = useState(timePeriodDays.toString());
  const [periodCalendarMonth, setPeriodCalendarMonth] = useState(() => (
    parseCalendarDate(timePeriodStartDate) ?? getCalendarMonthStart(new Date())
  ));
  const [participantCalendarMonth, setParticipantCalendarMonth] = useState(() => (
    parseCalendarDate(timePeriodStartDate) ?? getCalendarMonthStart(new Date())
  ));
  const [expandedParticipantId, setExpandedParticipantId] = useState<string | null>(null);

  const included = participants.filter((participant) => participant.included);
  const periodDays = Math.max(1, timePeriodDays);
  const isStandardMode = timeSplitVariant === 'standard';
  const periodDateOptions = useMemo(
    () => listDatesBetween(timePeriodStartDate, timePeriodEndDate),
    [timePeriodEndDate, timePeriodStartDate],
  );
  const periodDateSet = useMemo(() => new Set(periodDateOptions), [periodDateOptions]);
  const participantCalendarMonthKey = useMemo(
    () => getCalendarMonthKey(participantCalendarMonth),
    [participantCalendarMonth],
  );
  const participantVisibleMonthDates = useMemo(
    () => periodDateOptions.filter((dateValue) => dateValue.startsWith(participantCalendarMonthKey)),
    [participantCalendarMonthKey, periodDateOptions],
  );
  const periodDateGroups = useMemo(
    () => splitDatesByType(periodDateOptions),
    [periodDateOptions],
  );
  const participantVisibleMonthDateGroups = useMemo(
    () => splitDatesByType(participantVisibleMonthDates),
    [participantVisibleMonthDates],
  );
  const periodStartMonth = useMemo(() => {
    const parsed = parseCalendarDate(timePeriodStartDate);
    return parsed ? getCalendarMonthStart(parsed) : null;
  }, [timePeriodStartDate]);
  const periodEndMonth = useMemo(() => {
    const parsed = parseCalendarDate(timePeriodEndDate);
    return parsed ? getCalendarMonthStart(parsed) : null;
  }, [timePeriodEndDate]);
  const baseMemberDailyCost = included.length > 0 ? totalAmount / periodDays / included.length : 0;
  const totalMissingDays = included.reduce((sum, participant) => sum + Math.max(0, periodDays - participant.daysStayed), 0);
  const redistributedPool = totalMissingDays * baseMemberDailyCost;
  const totalPersonDays = included.reduce((sum, participant) => sum + participant.daysStayed, 0);
  const averageStay = included.length > 0 ? totalPersonDays / included.length : 0;
  const householdDailyCost = totalAmount / periodDays;
  const occupiedDayCost = totalPersonDays > 0 ? totalAmount / totalPersonDays : 0;
  const allZero = included.every((participant) => participant.daysStayed === 0);
  const allSame = !allZero && included.every((participant) => participant.daysStayed === included[0].daysStayed);
  const filledCount = included.filter((participant) => participant.daysStayed === periodDays).length;

  useEffect(() => {
    setPeriodInputValue(timePeriodDays.toString());
  }, [timePeriodDays]);

  useEffect(() => {
    if (timePeriodStartDate) {
      const nextMonth = parseCalendarDate(timePeriodStartDate);
      if (nextMonth) {
        setPeriodCalendarMonth(getCalendarMonthStart(nextMonth));
        setParticipantCalendarMonth((current) => {
          const currentMonth = getCalendarMonthStart(current);
          const nextMonthStart = getCalendarMonthStart(nextMonth);
          if (
            periodEndMonth
            && currentMonth.getTime() >= nextMonthStart.getTime()
            && currentMonth.getTime() <= periodEndMonth.getTime()
          ) {
            return currentMonth;
          }
          return nextMonthStart;
        });
      }
    }
  }, [periodEndMonth, timePeriodStartDate]);

  useEffect(() => {
    setParticipantCalendarMonth((current) => {
      const currentMonth = getCalendarMonthStart(current);

      if (periodStartMonth && currentMonth.getTime() < periodStartMonth.getTime()) {
        return periodStartMonth;
      }

      if (periodEndMonth && currentMonth.getTime() > periodEndMonth.getTime()) {
        return periodEndMonth;
      }

      return currentMonth;
    });
  }, [periodEndMonth, periodStartMonth]);

  const applyPeriodDays = useCallback((value: string | number) => {
    const parsedValue = typeof value === 'number' ? value : parseInt(value, 10);
    if (Number.isNaN(parsedValue)) {
      setPeriodInputValue(periodDays.toString());
      return;
    }

    const normalized = Math.max(1, Math.round(parsedValue));
    setPeriodInputValue(normalized.toString());
    onSetAllDays(normalized);
    setInputMode('days');
  }, [onSetAllDays, periodDays]);

  const handlePeriodCalendarDayPress = useCallback((value: string) => {
    lightHaptic();

    if (!timePeriodStartDate || (timePeriodStartDate && timePeriodEndDate)) {
      onTimePeriodRangeChange(value, '');
      return;
    }

    if (value === timePeriodStartDate) {
      onTimePeriodRangeChange(value, value);
      return;
    }

    if (value < timePeriodStartDate) {
      onTimePeriodRangeChange(value, timePeriodStartDate);
      return;
    }

    onTimePeriodRangeChange(timePeriodStartDate, value);
  }, [onTimePeriodRangeChange, timePeriodEndDate, timePeriodStartDate]);

  return (
    <View style={styles.section}>
      <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
        Time-Based Split
      </Text>
      <Text variant="bodySmall" style={[styles.hint, { color: palette.muted }]}>
        Set the full billing period once, then adjust each person's stayed days.
      </Text>

      <View style={styles.timeVariantRow}>
        {([
          { key: 'dynamic' as TimeSplitVariant, label: 'Dynamic', description: 'Prorates by entered stayed days.' },
          { key: 'standard' as TimeSplitVariant, label: 'Standard', description: 'Keeps every bill day allocated, then redistributes missed days.' },
        ]).map((option) => (
          <TouchableOpacity
            key={option.key}
            style={[
              styles.timeVariantChip,
              {
                backgroundColor: timeSplitVariant === option.key ? `${theme.colors.primary}20` : 'transparent',
                borderColor: timeSplitVariant === option.key ? theme.colors.primary : palette.border,
              },
            ]}
            onPress={() => {
              mediumHaptic();
              onTimeSplitVariantChange(option.key);
            }}
          >
            <Text style={{ color: timeSplitVariant === option.key ? theme.colors.primary : theme.colors.onSurface, fontSize: 14, fontWeight: '800' }}>
              {option.label}
            </Text>
            <Text style={{ color: palette.muted, fontSize: 11, lineHeight: 16, textAlign: 'center' }}>
              {option.description}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.timeInputModeRow}>
        {([
          { key: 'days' as TimeInputMode, label: 'By Days', icon: 'counter' },
          { key: 'dates' as TimeInputMode, label: 'By Dates', icon: 'calendar-range' },
        ]).map((option) => (
          <TouchableOpacity
            key={option.key}
            style={[
              styles.timeInputModeChip,
              {
                backgroundColor: inputMode === option.key ? `${theme.colors.primary}20` : 'transparent',
                borderColor: inputMode === option.key ? theme.colors.primary : palette.border,
              },
            ]}
            onPress={() => {
              lightHaptic();
              setInputMode(option.key);
            }}
          >
            <Icon source={option.icon} size={16} color={inputMode === option.key ? theme.colors.primary : palette.muted} />
            <Text
              style={{
                color: inputMode === option.key ? theme.colors.primary : palette.muted,
                fontSize: 13,
                fontWeight: '700',
              }}
            >
              {option.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <GlassView style={styles.timePeriodCard} intensity={14}>
        <View style={styles.timePeriodHeader}>
          <View style={styles.timePeriodHeaderText}>
            <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
              Total days in this period
            </Text>
            <Text variant="bodySmall" style={{ color: palette.muted }}>
              Changing this fills every included person and sets the slider range.
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.timeFillAllBtn, { borderColor: theme.colors.primary }]}
            onPress={() => {
              applyPeriodDays(periodInputValue);
            }}
          >
            <Icon source="account-sync" size={14} color={theme.colors.primary} />
            <Text style={{ color: theme.colors.primary, fontSize: 12, fontWeight: '700' }}>
              Fill all
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.timePeriodControlsRow}>
          <TouchableOpacity
            style={[styles.shareBtn, styles.timePeriodStepBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
            onPress={() => applyPeriodDays(periodDays - 1)}
          >
            <Text style={[styles.shareBtnText, { color: theme.colors.onSurface }]}>-</Text>
          </TouchableOpacity>
          <TextInput
            style={[styles.timePeriodInput, { color: theme.colors.onSurface, borderColor: palette.border }]}
            value={periodInputValue}
            onChangeText={setPeriodInputValue}
            onBlur={() => applyPeriodDays(periodInputValue)}
            onSubmitEditing={() => applyPeriodDays(periodInputValue)}
            keyboardType="number-pad"
            placeholder="30"
            placeholderTextColor={palette.muted}
          />
          <TouchableOpacity
            style={[styles.shareBtn, styles.timePeriodStepBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
            onPress={() => applyPeriodDays(periodDays + 1)}
          >
            <Text style={[styles.shareBtnText, { color: theme.colors.onSurface }]}>+</Text>
          </TouchableOpacity>
          <Text variant="bodySmall" style={{ color: palette.muted }}>
            day{periodDays !== 1 ? 's' : ''}
          </Text>
        </View>

        {inputMode === 'dates' && (
          <View style={styles.timeRangeSection}>
            <View style={styles.timeRangeSummaryRow}>
              <View style={styles.timeRangeSummaryText}>
                <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                  Billing period calendar
                </Text>
                <Text variant="bodySmall" style={{ color: palette.muted }}>
                  Tap a start date, then tap an end date to set the full period.
                </Text>
              </View>
              {(timePeriodStartDate || timePeriodEndDate) && (
                <TouchableOpacity
                  style={[styles.timeMiniActionChip, { borderColor: palette.border }]}
                  onPress={() => {
                    mediumHaptic();
                    onTimePeriodRangeChange('', '');
                  }}
                >
                  <Icon source="close" size={14} color={palette.muted} />
                  <Text style={{ color: palette.muted, fontSize: 12, fontWeight: '700' }}>
                    Clear
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.timeRangeSelectedRow}>
              <View style={[styles.timeRangeSelectedChip, { borderColor: palette.border }]}>
                <Text style={{ color: palette.muted, fontSize: 11, fontWeight: '700' }}>Start</Text>
                <Text style={{ color: theme.colors.onSurface, fontSize: 13, fontWeight: '700' }}>
                  {timePeriodStartDate ? getDateChipLabel(timePeriodStartDate) : 'Pick a day'}
                </Text>
              </View>
              <View style={[styles.timeRangeSelectedChip, { borderColor: palette.border }]}>
                <Text style={{ color: palette.muted, fontSize: 11, fontWeight: '700' }}>End</Text>
                <Text style={{ color: theme.colors.onSurface, fontSize: 13, fontWeight: '700' }}>
                  {timePeriodEndDate ? getDateChipLabel(timePeriodEndDate) : 'Pick a day'}
                </Text>
              </View>
            </View>

            <View style={styles.calendarNavRow}>
              <TouchableOpacity
                style={[styles.calendarNavButton, { borderColor: palette.border }]}
                onPress={() => setPeriodCalendarMonth((prev) => addCalendarMonths(prev, -1))}
              >
                <Icon source="chevron-left" size={18} color={theme.colors.onSurface} />
              </TouchableOpacity>
              <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                {getCalendarMonthLabel(periodCalendarMonth)}
              </Text>
              <TouchableOpacity
                style={[styles.calendarNavButton, { borderColor: palette.border }]}
                onPress={() => setPeriodCalendarMonth((prev) => addCalendarMonths(prev, 1))}
              >
                <Icon source="chevron-right" size={18} color={theme.colors.onSurface} />
              </TouchableOpacity>
            </View>

            <CalendarMonthGrid
              accentColor={theme.colors.primary}
              monthDate={periodCalendarMonth}
              onPressDate={handlePeriodCalendarDayPress}
              rangeEnd={timePeriodEndDate || undefined}
              rangeStart={timePeriodStartDate || undefined}
            />

            <Text variant="labelSmall" style={{ color: palette.muted }}>
              {timePeriodStartDate && !timePeriodEndDate
                ? 'Now choose the last day in the billing period.'
                : 'The selected range becomes the total number of bill days.'}
            </Text>
          </View>
        )}

        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.timePresetRow}>
            {DURATION_PRESETS.map((preset) => (
              <TouchableOpacity
                key={preset.label}
                style={[
                  styles.timePresetChip,
                  {
                    borderColor: preset.days === periodDays ? theme.colors.primary : palette.border,
                    backgroundColor: preset.days === periodDays ? `${theme.colors.primary}18` : 'transparent',
                  },
                ]}
                onPress={() => applyPeriodDays(preset.days)}
              >
                <Text
                  style={{
                    color: preset.days === periodDays ? theme.colors.primary : palette.muted,
                    fontSize: 12,
                    fontWeight: '600',
                  }}
                >
                  {preset.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </GlassView>

      <Animated.View entering={FadeInDown.springify()}>
        <GlassView style={styles.timeSummaryCard} intensity={15}>
          <View style={styles.timeSummaryHeader}>
            <View style={styles.timeSummaryHeaderText}>
              <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                {isStandardMode
                  ? (allSame ? 'Standard mode is splitting the full period evenly' : 'Standard mode redistributes missed-day share')
                  : (allSame ? 'Everyone is on the full stay right now' : `${included.length} people with custom stays`)}
              </Text>
              <Text variant="bodySmall" style={{ color: palette.muted }}>
                {isStandardMode
                  ? 'Each missed day hands that member\'s base daily share back to the rest of the group.'
                  : (inputMode === 'dates'
                    ? 'Dates are counted inclusively and capped to this billing period.'
                    : 'Move the slider or type a value to update the split instantly.')}
              </Text>
            </View>
            <View style={[styles.timeSummaryBadge, { backgroundColor: `${theme.colors.primary}16` }]}>
              <Text style={{ color: theme.colors.primary, fontSize: 12, fontWeight: '800' }}>
                {filledCount}/{included.length} full stay
              </Text>
            </View>
          </View>

          <View style={styles.timeMetricGrid}>
            <View style={[styles.timeMetricCard, { borderColor: palette.border }]}>
              <Text style={[styles.timeMetricLabel, { color: palette.muted }]}>Period</Text>
              <Text style={[styles.timeMetricValue, { color: theme.colors.onSurface }]}>{periodDays}d</Text>
            </View>
            <View style={[styles.timeMetricCard, { borderColor: palette.border }]}>
              <Text style={[styles.timeMetricLabel, { color: palette.muted }]}>House/day</Text>
              <Text style={[styles.timeMetricValue, { color: theme.colors.onSurface }]}>
                {formatCurrency(householdDailyCost, currency)}
              </Text>
            </View>
            <View style={[styles.timeMetricCard, { borderColor: palette.border }]}>
              <Text style={[styles.timeMetricLabel, { color: palette.muted }]}>
                {isStandardMode ? 'Base/member/day' : 'Occupied days'}
              </Text>
              <Text style={[styles.timeMetricValue, { color: theme.colors.onSurface }]}>
                {isStandardMode ? formatCurrency(baseMemberDailyCost, currency) : `${totalPersonDays}d`}
              </Text>
            </View>
            <View style={[styles.timeMetricCard, { borderColor: palette.border }]}>
              <Text style={[styles.timeMetricLabel, { color: palette.muted }]}>
                {isStandardMode ? 'Redistributed pool' : 'Occupied/day'}
              </Text>
              <Text style={[styles.timeMetricValue, { color: theme.colors.onSurface }]}>
                {isStandardMode
                  ? formatCurrency(redistributedPool, currency)
                  : (totalPersonDays > 0 ? formatCurrency(occupiedDayCost, currency) : '-')}
              </Text>
            </View>
          </View>

          <Text variant="bodySmall" style={{ color: palette.muted, paddingHorizontal: 14, paddingBottom: 14 }}>
            {isStandardMode
              ? `Missing days across the group: ${totalMissingDays} day${totalMissingDays === 1 ? '' : 's'}`
              : `Average stay: ${included.length > 0 ? averageStay.toFixed(1) : '0.0'} day${averageStay === 1 ? '' : 's'}`}
          </Text>
        </GlassView>
      </Animated.View>

      {allZero && (
        <Animated.View entering={FadeIn.duration(300)}>
          <GlassView style={styles.timeEmptyCard} intensity={10}>
            <View style={styles.timeEmptyContent}>
              <Icon source="calendar-clock" size={32} color={palette.muted} />
              <Text variant="bodySmall" style={{ color: palette.muted, textAlign: 'center', paddingHorizontal: 16 }}>
                Everyone starts at the full period. Reduce the people who stayed fewer days.
              </Text>
            </View>
          </GlassView>
        </Animated.View>
      )}

      {included.map((participant, index) => {
        const splitPct = totalAmount > 0 ? (participant.computedAmount / totalAmount) * 100 : 0;
        const periodPct = (participant.daysStayed / periodDays) * 100;
        const costPerStayedDay = participant.daysStayed > 0 ? participant.computedAmount / participant.daysStayed : 0;
        const missingDays = Math.max(0, periodDays - participant.daysStayed);
        const redistributedAmount = participant.computedAmount - (participant.daysStayed * baseMemberDailyCost);
        const avatarColor = AVATAR_COLORS[index % AVATAR_COLORS.length];
        const selectedDateSet = new Set(
          participant.selectedStayDates ?? (periodDateOptions.length === participant.daysStayed ? periodDateOptions : []),
        );
        const hasManualDaysWithoutDates = selectedDateSet.size === 0 && participant.daysStayed > 0;
        const isExpanded = expandedParticipantId === participant.id;
        const canGoToPreviousParticipantMonth = !periodStartMonth
          || participantCalendarMonth.getTime() > periodStartMonth.getTime();
        const canGoToNextParticipantMonth = !periodEndMonth
          || participantCalendarMonth.getTime() < periodEndMonth.getTime();
        const visibleMonthDates = isExpanded ? participantVisibleMonthDates : [];
        const selectedVisibleMonthCount = visibleMonthDates.filter((dateValue) => selectedDateSet.has(dateValue)).length;
        const isVisibleMonthFullySelected = visibleMonthDates.length > 0
          && selectedVisibleMonthCount === visibleMonthDates.length;
        const monthToggleLabel = isVisibleMonthFullySelected ? 'Clear month' : 'Select month';
        const selectedAllWeekdayCount = periodDateGroups.weekdays.filter((dateValue) => selectedDateSet.has(dateValue)).length;
        const selectedAllWeekdayNoFridayCount = periodDateGroups.weekdaysNoFriday
          .filter((dateValue) => selectedDateSet.has(dateValue)).length;
        const selectedAllWeekendCount = periodDateGroups.weekends.filter((dateValue) => selectedDateSet.has(dateValue)).length;
        const selectedAllLongWeekendCount = periodDateGroups.longWeekends
          .filter((dateValue) => selectedDateSet.has(dateValue)).length;
        const areAllWeekdaysSelected = periodDateGroups.weekdays.length > 0
          && selectedAllWeekdayCount === periodDateGroups.weekdays.length;
        const areAllWeekdaysNoFridaySelected = periodDateGroups.weekdaysNoFriday.length > 0
          && selectedAllWeekdayNoFridayCount === periodDateGroups.weekdaysNoFriday.length;
        const areAllWeekendsSelected = periodDateGroups.weekends.length > 0
          && selectedAllWeekendCount === periodDateGroups.weekends.length;
        const areAllLongWeekendsSelected = periodDateGroups.longWeekends.length > 0
          && selectedAllLongWeekendCount === periodDateGroups.longWeekends.length;
        const allWeekdayToggleLabel = areAllWeekdaysSelected ? 'Remove all weekdays' : 'Add all weekdays';
        const allWeekdayNoFridayToggleLabel = areAllWeekdaysNoFridaySelected
          ? 'Remove all Mon-Thu'
          : 'Add all Mon-Thu';
        const allWeekendToggleLabel = areAllWeekendsSelected ? 'Remove all weekends' : 'Add all weekends';
        const allLongWeekendToggleLabel = areAllLongWeekendsSelected
          ? 'Remove all long weekends'
          : 'Add all long weekends';
        const selectedVisibleWeekdayCount = participantVisibleMonthDateGroups.weekdays.filter((dateValue) => selectedDateSet.has(dateValue)).length;
        const selectedVisibleWeekdayNoFridayCount = participantVisibleMonthDateGroups.weekdaysNoFriday
          .filter((dateValue) => selectedDateSet.has(dateValue)).length;
        const selectedVisibleWeekendCount = participantVisibleMonthDateGroups.weekends.filter((dateValue) => selectedDateSet.has(dateValue)).length;
        const selectedVisibleLongWeekendCount = participantVisibleMonthDateGroups.longWeekends
          .filter((dateValue) => selectedDateSet.has(dateValue)).length;
        const areVisibleWeekdaysSelected = participantVisibleMonthDateGroups.weekdays.length > 0
          && selectedVisibleWeekdayCount === participantVisibleMonthDateGroups.weekdays.length;
        const areVisibleWeekdaysNoFridaySelected = participantVisibleMonthDateGroups.weekdaysNoFriday.length > 0
          && selectedVisibleWeekdayNoFridayCount === participantVisibleMonthDateGroups.weekdaysNoFriday.length;
        const areVisibleWeekendsSelected = participantVisibleMonthDateGroups.weekends.length > 0
          && selectedVisibleWeekendCount === participantVisibleMonthDateGroups.weekends.length;
        const areVisibleLongWeekendsSelected = participantVisibleMonthDateGroups.longWeekends.length > 0
          && selectedVisibleLongWeekendCount === participantVisibleMonthDateGroups.longWeekends.length;
        const visibleWeekdayToggleLabel = areVisibleWeekdaysSelected ? 'Remove weekdays' : 'Add weekdays';
        const visibleWeekdayNoFridayToggleLabel = areVisibleWeekdaysNoFridaySelected
          ? 'Remove Mon-Thu'
          : 'Add Mon-Thu';
        const visibleWeekendToggleLabel = areVisibleWeekendsSelected ? 'Remove weekends' : 'Add weekends';
        const visibleLongWeekendToggleLabel = areVisibleLongWeekendsSelected
          ? 'Remove long weekends'
          : 'Add long weekends';

        return (
          <Animated.View key={participant.id} entering={FadeInDown.delay(index * 50).springify()}>
            <GlassView style={styles.timeParticipantCard} intensity={12}>
              <View style={styles.timeCardInner}>
                <View style={styles.timeRowTop}>
                  <View style={styles.timeRowNameGroup}>
                    <View style={[styles.miniAvatar, { backgroundColor: avatarColor }]}>
                      <Text style={styles.miniInitials}>{getInitials(participant.name)}</Text>
                    </View>
                    <View style={styles.timeParticipantTitleBlock}>
                      <Text style={{ color: theme.colors.onSurface, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>
                        {participant.name}
                      </Text>
                      <Text variant="bodySmall" style={{ color: palette.muted }}>
                        {participant.daysStayed}/{periodDays} day{participant.daysStayed === 1 ? '' : 's'} in period
                      </Text>
                    </View>
                  </View>
                  <Text style={{ color: theme.colors.primary, fontWeight: '800', fontSize: 18 }}>
                    {formatCurrency(participant.computedAmount, currency)}
                  </Text>
                </View>

                <View style={styles.timeMetaRow}>
                  <View style={[styles.timeMetaChip, { borderColor: palette.border }]}>
                    <Text style={{ color: palette.muted, fontSize: 12, fontWeight: '600' }}>
                      {splitPct.toFixed(0)}% of split
                    </Text>
                  </View>
                  <View style={[styles.timeMetaChip, { borderColor: palette.border }]}>
                    <Text style={{ color: palette.muted, fontSize: 12, fontWeight: '600' }}>
                      {isStandardMode
                        ? `${missingDays} missed day${missingDays === 1 ? '' : 's'}`
                        : `${periodPct.toFixed(0)}% of period`}
                    </Text>
                  </View>
                  {(participant.daysStayed > 0 || isStandardMode) && (
                    <View style={[styles.timeMetaChip, { borderColor: palette.border }]}>
                      <Text style={{ color: palette.muted, fontSize: 12, fontWeight: '600' }}>
                        {isStandardMode
                          ? `${redistributedAmount >= 0 ? '+' : ''}${formatCurrency(redistributedAmount, currency)} backfill`
                          : `${formatCurrency(costPerStayedDay, currency)}/day`}
                      </Text>
                    </View>
                  )}
                </View>

                {inputMode === 'days' && (
                  <>
                    <View style={styles.timeDaysInputRow}>
                      <TouchableOpacity
                        style={[styles.shareBtn, styles.timePeriodStepBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
                        onPress={() => {
                          lightHaptic();
                          onDaysChange(participant.id, Math.max(0, participant.daysStayed - 1).toString());
                        }}
                      >
                        <Text style={[styles.shareBtnText, { color: theme.colors.onSurface }]}>-</Text>
                      </TouchableOpacity>
                      <TextInput
                        style={[styles.timeDaysInput, { color: theme.colors.onSurface, borderColor: palette.border }]}
                        value={participant.daysStayed.toString()}
                        onChangeText={(value) => onDaysChange(participant.id, value)}
                        keyboardType="number-pad"
                        placeholder="0"
                        placeholderTextColor={palette.muted}
                      />
                      <TouchableOpacity
                        style={[styles.shareBtn, styles.timePeriodStepBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
                        onPress={() => {
                          lightHaptic();
                          onDaysChange(participant.id, Math.min(periodDays, participant.daysStayed + 1).toString());
                        }}
                      >
                        <Text style={[styles.shareBtnText, { color: theme.colors.onSurface }]}>+</Text>
                      </TouchableOpacity>
                      <Text variant="bodySmall" style={{ color: palette.muted, marginLeft: 4 }}>
                        day{participant.daysStayed !== 1 ? 's' : ''}
                      </Text>
                      {participant.daysStayed === periodDays && (
                        <View style={[styles.timeInlinePill, { backgroundColor: `${theme.colors.primary}16` }]}>
                          <Text style={{ color: theme.colors.primary, fontSize: 11, fontWeight: '800' }}>
                            Full stay
                          </Text>
                        </View>
                      )}
                    </View>

                    <TimeValueSlider
                      accentColor={avatarColor}
                      isDark={isDark}
                      maximumValue={periodDays}
                      minimumValue={0}
                      onValueChange={(nextValue) => onDaysChange(participant.id, nextValue.toString())}
                      onSlidingComplete={() => lightHaptic()}
                      value={participant.daysStayed}
                    />

                    <View style={styles.timeSliderLabels}>
                      <Text variant="labelSmall" style={{ color: palette.muted }}>0d</Text>
                      <Text variant="labelSmall" style={{ color: palette.muted }}>
                        {periodDays}d max
                      </Text>
                    </View>
                  </>
                )}

                {inputMode === 'dates' && (
                  <View style={styles.timeDateContainer}>
                    {periodDateOptions.length > 0 ? (
                      <>
                        <View style={styles.timeParticipantDateHeader}>
                          <View style={styles.timeParticipantDateSummary}>
                            <Text variant="labelSmall" style={{ color: palette.muted }}>
                              {selectedDateSet.size > 0
                                ? `${selectedDateSet.size} selected day${selectedDateSet.size === 1 ? '' : 's'}`
                                : hasManualDaysWithoutDates
                                  ? `${participant.daysStayed} day${participant.daysStayed === 1 ? '' : 's'} set manually`
                                  : 'No selected days yet'}
                            </Text>
                            <Text variant="bodySmall" style={{ color: palette.muted }}>
                              {hasManualDaysWithoutDates
                                ? 'Tap exact days below to replace the manual count with real dates.'
                                : 'Tap exact days from the billing range below.'}
                            </Text>
                          </View>
                          <View style={styles.timeParticipantDateActions}>
                            <TouchableOpacity
                              style={[styles.timeMiniActionChip, { borderColor: palette.border }]}
                              onPress={() => {
                                lightHaptic();
                                if (!isExpanded) {
                                  const anchorDate = participant.selectedStayDates?.[0]
                                    ?? timePeriodStartDate
                                    ?? timePeriodEndDate;
                                  const anchorMonth = anchorDate ? parseCalendarDate(anchorDate) : null;
                                  if (anchorMonth) {
                                    setParticipantCalendarMonth(getCalendarMonthStart(anchorMonth));
                                  }
                                }
                                setExpandedParticipantId(isExpanded ? null : participant.id);
                              }}
                            >
                              <Icon
                                source={isExpanded ? 'calendar-collapse-horizontal' : 'calendar-month'}
                                size={14}
                                color={theme.colors.primary}
                              />
                              <Text style={{ color: theme.colors.primary, fontSize: 12, fontWeight: '700' }}>
                                {isExpanded ? 'Hide' : 'Calendar'}
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[styles.timeMiniActionChip, { borderColor: palette.border }]}
                              onPress={() => {
                                mediumHaptic();
                                onStayDatesChange(participant.id, periodDateOptions);
                              }}
                            >
                              <Text style={{ color: palette.muted, fontSize: 12, fontWeight: '700' }}>All days</Text>
                            </TouchableOpacity>
                            {periodDateGroups.weekdays.length > 0 && (
                              <TouchableOpacity
                                style={[
                                  styles.timeMiniActionChip,
                                  {
                                    borderColor: areAllWeekdaysSelected ? palette.border : avatarColor,
                                    backgroundColor: areAllWeekdaysSelected ? 'transparent' : `${avatarColor}12`,
                                  },
                                ]}
                                onPress={() => {
                                  const nextDates = areAllWeekdaysSelected
                                    ? removeScopedDates(selectedDateSet, periodDateGroups.weekdays)
                                    : addScopedDates(selectedDateSet, periodDateGroups.weekdays);
                                  mediumHaptic();
                                  onStayDatesChange(participant.id, nextDates);
                                }}
                              >
                                <Text
                                  style={{
                                    color: areAllWeekdaysSelected ? palette.muted : avatarColor,
                                    fontSize: 12,
                                    fontWeight: '700',
                                  }}
                                >
                                  {allWeekdayToggleLabel}
                                </Text>
                              </TouchableOpacity>
                            )}
                            {periodDateGroups.weekdaysNoFriday.length > 0 && (
                              <TouchableOpacity
                                style={[
                                  styles.timeMiniActionChip,
                                  {
                                    borderColor: areAllWeekdaysNoFridaySelected ? palette.border : avatarColor,
                                    backgroundColor: areAllWeekdaysNoFridaySelected ? 'transparent' : `${avatarColor}12`,
                                  },
                                ]}
                                onPress={() => {
                                  const nextDates = areAllWeekdaysNoFridaySelected
                                    ? removeScopedDates(selectedDateSet, periodDateGroups.weekdaysNoFriday)
                                    : addScopedDates(selectedDateSet, periodDateGroups.weekdaysNoFriday);
                                  mediumHaptic();
                                  onStayDatesChange(participant.id, nextDates);
                                }}
                              >
                                <Text
                                  style={{
                                    color: areAllWeekdaysNoFridaySelected ? palette.muted : avatarColor,
                                    fontSize: 12,
                                    fontWeight: '700',
                                  }}
                                >
                                  {allWeekdayNoFridayToggleLabel}
                                </Text>
                              </TouchableOpacity>
                            )}
                            {periodDateGroups.weekends.length > 0 && (
                              <TouchableOpacity
                                style={[
                                  styles.timeMiniActionChip,
                                  {
                                    borderColor: areAllWeekendsSelected ? palette.border : avatarColor,
                                    backgroundColor: areAllWeekendsSelected ? 'transparent' : `${avatarColor}12`,
                                  },
                                ]}
                                onPress={() => {
                                  const nextDates = areAllWeekendsSelected
                                    ? removeScopedDates(selectedDateSet, periodDateGroups.weekends)
                                    : addScopedDates(selectedDateSet, periodDateGroups.weekends);
                                  mediumHaptic();
                                  onStayDatesChange(participant.id, nextDates);
                                }}
                              >
                                <Text
                                  style={{
                                    color: areAllWeekendsSelected ? palette.muted : avatarColor,
                                    fontSize: 12,
                                    fontWeight: '700',
                                  }}
                                >
                                  {allWeekendToggleLabel}
                                </Text>
                              </TouchableOpacity>
                            )}
                            {periodDateGroups.longWeekends.length > 0 && (
                              <TouchableOpacity
                                style={[
                                  styles.timeMiniActionChip,
                                  {
                                    borderColor: areAllLongWeekendsSelected ? palette.border : avatarColor,
                                    backgroundColor: areAllLongWeekendsSelected ? 'transparent' : `${avatarColor}12`,
                                  },
                                ]}
                                onPress={() => {
                                  const nextDates = areAllLongWeekendsSelected
                                    ? removeScopedDates(selectedDateSet, periodDateGroups.longWeekends)
                                    : addScopedDates(selectedDateSet, periodDateGroups.longWeekends);
                                  mediumHaptic();
                                  onStayDatesChange(participant.id, nextDates);
                                }}
                              >
                                <Text
                                  style={{
                                    color: areAllLongWeekendsSelected ? palette.muted : avatarColor,
                                    fontSize: 12,
                                    fontWeight: '700',
                                  }}
                                >
                                  {allLongWeekendToggleLabel}
                                </Text>
                              </TouchableOpacity>
                            )}
                            <TouchableOpacity
                              style={[styles.timeMiniActionChip, { borderColor: palette.border }]}
                              onPress={() => {
                                mediumHaptic();
                                onStayDatesChange(participant.id, []);
                              }}
                            >
                              <Text style={{ color: palette.muted, fontSize: 12, fontWeight: '700' }}>Clear</Text>
                            </TouchableOpacity>
                          </View>
                        </View>

                        {isExpanded && (
                          <View style={styles.timeParticipantCalendarStack}>
                            <View style={styles.calendarNavRow}>
                              <TouchableOpacity
                                disabled={!canGoToPreviousParticipantMonth}
                                style={[
                                  styles.calendarNavButton,
                                  {
                                    borderColor: palette.border,
                                    opacity: canGoToPreviousParticipantMonth ? 1 : 0.35,
                                  },
                                ]}
                                onPress={() => {
                                  if (!canGoToPreviousParticipantMonth) return;
                                  setParticipantCalendarMonth((current) => addCalendarMonths(current, -1));
                                }}
                              >
                                <Icon source="chevron-left" size={18} color={theme.colors.onSurface} />
                              </TouchableOpacity>
                              <Text variant="labelLarge" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                                {getCalendarMonthLabel(participantCalendarMonth)}
                              </Text>
                              <TouchableOpacity
                                disabled={!canGoToNextParticipantMonth}
                                style={[
                                  styles.calendarNavButton,
                                  {
                                    borderColor: palette.border,
                                    opacity: canGoToNextParticipantMonth ? 1 : 0.35,
                                  },
                                ]}
                                onPress={() => {
                                  if (!canGoToNextParticipantMonth) return;
                                  setParticipantCalendarMonth((current) => addCalendarMonths(current, 1));
                                }}
                              >
                                <Icon source="chevron-right" size={18} color={theme.colors.onSurface} />
                              </TouchableOpacity>
                            </View>

                            {visibleMonthDates.length > 0 && (
                              <View style={styles.timeParticipantMonthActionRow}>
                                <Text variant="bodySmall" style={{ color: palette.muted }}>
                                  {selectedVisibleMonthCount}/{visibleMonthDates.length} selected this month
                                </Text>
                                <View style={styles.timeParticipantMonthActionButtons}>
                                  <TouchableOpacity
                                    style={[
                                      styles.timeMiniActionChip,
                                      {
                                        borderColor: isVisibleMonthFullySelected ? palette.border : avatarColor,
                                        backgroundColor: isVisibleMonthFullySelected ? 'transparent' : `${avatarColor}12`,
                                      },
                                    ]}
                                    onPress={() => {
                                      const nextDates = isVisibleMonthFullySelected
                                        ? removeScopedDates(selectedDateSet, visibleMonthDates)
                                        : addScopedDates(selectedDateSet, visibleMonthDates);
                                      mediumHaptic();
                                      onStayDatesChange(participant.id, nextDates);
                                    }}
                                  >
                                    <Text
                                      style={{
                                        color: isVisibleMonthFullySelected ? palette.muted : avatarColor,
                                        fontSize: 12,
                                        fontWeight: '700',
                                      }}
                                    >
                                      {monthToggleLabel}
                                    </Text>
                                  </TouchableOpacity>
                                  {participantVisibleMonthDateGroups.weekdays.length > 0 && (
                                    <TouchableOpacity
                                      style={[
                                        styles.timeMiniActionChip,
                                        {
                                          borderColor: areVisibleWeekdaysSelected ? palette.border : avatarColor,
                                          backgroundColor: areVisibleWeekdaysSelected ? 'transparent' : `${avatarColor}12`,
                                        },
                                      ]}
                                      onPress={() => {
                                        const nextDates = areVisibleWeekdaysSelected
                                          ? removeScopedDates(selectedDateSet, participantVisibleMonthDateGroups.weekdays)
                                          : addScopedDates(selectedDateSet, participantVisibleMonthDateGroups.weekdays);
                                        mediumHaptic();
                                        onStayDatesChange(participant.id, nextDates);
                                      }}
                                    >
                                      <Text
                                        style={{
                                          color: areVisibleWeekdaysSelected ? palette.muted : avatarColor,
                                          fontSize: 12,
                                          fontWeight: '700',
                                        }}
                                      >
                                        {visibleWeekdayToggleLabel}
                                      </Text>
                                    </TouchableOpacity>
                                  )}
                                  {participantVisibleMonthDateGroups.weekdaysNoFriday.length > 0 && (
                                    <TouchableOpacity
                                      style={[
                                        styles.timeMiniActionChip,
                                        {
                                          borderColor: areVisibleWeekdaysNoFridaySelected ? palette.border : avatarColor,
                                          backgroundColor: areVisibleWeekdaysNoFridaySelected ? 'transparent' : `${avatarColor}12`,
                                        },
                                      ]}
                                      onPress={() => {
                                        const nextDates = areVisibleWeekdaysNoFridaySelected
                                          ? removeScopedDates(selectedDateSet, participantVisibleMonthDateGroups.weekdaysNoFriday)
                                          : addScopedDates(selectedDateSet, participantVisibleMonthDateGroups.weekdaysNoFriday);
                                        mediumHaptic();
                                        onStayDatesChange(participant.id, nextDates);
                                      }}
                                    >
                                      <Text
                                        style={{
                                          color: areVisibleWeekdaysNoFridaySelected ? palette.muted : avatarColor,
                                          fontSize: 12,
                                          fontWeight: '700',
                                        }}
                                      >
                                        {visibleWeekdayNoFridayToggleLabel}
                                      </Text>
                                    </TouchableOpacity>
                                  )}
                                  {participantVisibleMonthDateGroups.weekends.length > 0 && (
                                    <TouchableOpacity
                                      style={[
                                        styles.timeMiniActionChip,
                                        {
                                          borderColor: areVisibleWeekendsSelected ? palette.border : avatarColor,
                                          backgroundColor: areVisibleWeekendsSelected ? 'transparent' : `${avatarColor}12`,
                                        },
                                      ]}
                                      onPress={() => {
                                        const nextDates = areVisibleWeekendsSelected
                                          ? removeScopedDates(selectedDateSet, participantVisibleMonthDateGroups.weekends)
                                          : addScopedDates(selectedDateSet, participantVisibleMonthDateGroups.weekends);
                                        mediumHaptic();
                                        onStayDatesChange(participant.id, nextDates);
                                      }}
                                    >
                                      <Text
                                        style={{
                                          color: areVisibleWeekendsSelected ? palette.muted : avatarColor,
                                          fontSize: 12,
                                          fontWeight: '700',
                                        }}
                                      >
                                        {visibleWeekendToggleLabel}
                                      </Text>
                                    </TouchableOpacity>
                                  )}
                                  {participantVisibleMonthDateGroups.longWeekends.length > 0 && (
                                    <TouchableOpacity
                                      style={[
                                        styles.timeMiniActionChip,
                                        {
                                          borderColor: areVisibleLongWeekendsSelected ? palette.border : avatarColor,
                                          backgroundColor: areVisibleLongWeekendsSelected ? 'transparent' : `${avatarColor}12`,
                                        },
                                      ]}
                                      onPress={() => {
                                        const nextDates = areVisibleLongWeekendsSelected
                                          ? removeScopedDates(selectedDateSet, participantVisibleMonthDateGroups.longWeekends)
                                          : addScopedDates(selectedDateSet, participantVisibleMonthDateGroups.longWeekends);
                                        mediumHaptic();
                                        onStayDatesChange(participant.id, nextDates);
                                      }}
                                    >
                                      <Text
                                        style={{
                                          color: areVisibleLongWeekendsSelected ? palette.muted : avatarColor,
                                          fontSize: 12,
                                          fontWeight: '700',
                                        }}
                                      >
                                        {visibleLongWeekendToggleLabel}
                                      </Text>
                                    </TouchableOpacity>
                                  )}
                                </View>
                              </View>
                            )}

                            <CalendarMonthGrid
                              accentColor={avatarColor}
                              enabledDates={periodDateSet}
                              monthDate={participantCalendarMonth}
                              onPressDate={(dateValue) => {
                                const nextDates = selectedDateSet.has(dateValue)
                                  ? Array.from(selectedDateSet).filter((value) => value !== dateValue)
                                  : [...Array.from(selectedDateSet), dateValue].sort();
                                lightHaptic();
                                onStayDatesChange(participant.id, nextDates);
                              }}
                              selectedDates={selectedDateSet}
                            />
                          </View>
                        )}
                      </>
                    ) : (
                      <View style={[styles.timeDateHintBox, { borderColor: palette.border }]}>
                        <Text variant="bodySmall" style={{ color: palette.muted, textAlign: 'center' }}>
                          Choose the total billing period on the calendar above first, then each member can pick their stayed days from it.
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </View>
            </GlassView>
          </Animated.View>
        );
      })}

      {!allZero && included.length > 0 && (
        <Text variant="labelSmall" style={{ color: palette.muted, textAlign: 'center', marginTop: 4 }}>
          Equal split baseline: {formatCurrency(totalAmount / included.length, currency)}/person
        </Text>
      )}
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. GAMIFIED / RANDOMIZED SPLITS
// ═══════════════════════════════════════════════════════════════════════════════
interface GamifiedProps {
  mode: GamifiedMode;
  onModeChange: (mode: GamifiedMode) => void;
  participants: Participant[];
  onWeightChange: (id: string, weight: string) => void;
  loserId: string | null;
  onSpin: () => void;
  spinTargetIndex: number | null;
  onSpinComplete: (winnerId: string) => void;
  isSpinning: boolean;
  currency: string;
  totalAmount: number;
  onWeightedComplete?: (assignments: { userId: string; percentage: number }[]) => void;
  onKarmaComplete?: (results: { userId: string; amount: number }[]) => void;
}

const GamifiedMode_ = React.memo(({
  mode, onModeChange, participants, onWeightChange, loserId, onSpin,
  spinTargetIndex, onSpinComplete, isSpinning, currency, totalAmount, onWeightedComplete, onKarmaComplete,
}: GamifiedProps) => {
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;
  const included = participants.filter((p) => p.included);
  const loserName = included.find((p) => p.id === loserId)?.name;

  // Wheel ref for roulette / weighted modes
  const wheelRef = useRef<RouletteWheelRef>(null);

  // When parent sets spinTargetIndex, trigger the wheel animation
  useEffect(() => {
    if (spinTargetIndex !== null && mode === 'roulette') {
      wheelRef.current?.spin(spinTargetIndex);
    }
  }, [spinTargetIndex, mode]);

  const MODES: { key: GamifiedMode; label: string; icon: string }[] = [
    { key: 'roulette', label: 'Roulette', icon: 'poker-chip' },
    { key: 'weightedRoulette', label: 'Weighted', icon: 'scale-balance' },
    { key: 'scrooge', label: 'Karma', icon: 'scale-balance' },
  ];

  const showWheel = mode === 'roulette';

  // ── Karma State ─────────────────────────────────────────────────────
  const KARMA_PRESETS = [
    { key: 0.25, label: 'Gentle', emoji: '🌱' },
    { key: 0.5, label: 'Moderate', emoji: '⚖️' },
    { key: 0.75, label: 'Strong', emoji: '💪' },
    { key: 1.0, label: 'Full', emoji: '🔥' },
  ];
  const [karmaIntensity, setKarmaIntensity] = useState(0.5);
  const [karmaApplied, setKarmaApplied] = useState(false);

  const karmaComputed = useMemo(() => {
    if (mode !== 'scrooge') return [];
    return computeKarma(totalAmount, participants, karmaIntensity);
  }, [mode, totalAmount, participants, karmaIntensity]);

  const karmaData = useMemo(() => {
    if (mode !== 'scrooge' || included.length === 0) return [];
    const avgPaid = included.reduce((s, p) => s + p.historicalPaid, 0) / included.length;
    const maxDev = Math.max(...included.map((p) => Math.abs(p.historicalPaid - avgPaid)), 1);
    const equalShare = totalAmount / included.length;

    return included.map((p) => {
      const computed = karmaComputed.find((c) => c.id === p.id);
      const deviation = p.historicalPaid - avgPaid;
      const computedAmt = computed?.computedAmount ?? equalShare;
      return {
        id: p.id,
        name: p.name,
        historicalPaid: p.historicalPaid,
        deviation,
        isOverpayer: deviation > 0,
        barWidth: Math.min(100, (Math.abs(deviation) / maxDev) * 100),
        computedAmount: computedAmt,
        karmaAdjustment: computedAmt - equalShare,
      };
    });
  }, [mode, included, karmaComputed, totalAmount]);

  useEffect(() => {
    if (mode === 'scrooge') {
      setKarmaApplied(false);
      setKarmaIntensity(0.5);
    }
  }, [mode]);

  const handleApplyKarma = useCallback(() => {
    successHaptic();
    setKarmaApplied(true);
    const results = karmaComputed
      .filter((p) => p.included)
      .map((p) => ({ userId: p.id, amount: p.computedAmount }));
    onKarmaComplete?.(results);
  }, [karmaComputed, onKarmaComplete]);

  const handleResetKarma = useCallback(() => {
    mediumHaptic();
    setKarmaApplied(false);
    setKarmaIntensity(0.5);
  }, []);

  // ── Weighted Roulette State ─────────────────────────────────────────
  const weightedWheelRef = useRef<WeightedRouletteWheelRef>(null);
  const [wAssignments, setWAssignments] = useState<{ userId: string; name: string; percentage: number }[]>([]);
  const [wPhase, setWPhase] = useState<'idle' | 'spinning-user' | 'user-selected' | 'spinning-pct' | 'complete'>('idle');
  const [wPercentOptions, setWPercentOptions] = useState<number[]>(() => generatePercentageOptions(100));
  const [wSelectedUser, setWSelectedUser] = useState<string | null>(null);

  const wAllocated = useMemo(() => wAssignments.reduce((s, a) => s + a.percentage, 0), [wAssignments]);
  const wRemainingPct = 100 - wAllocated;
  const wRemainingParticipants = useMemo(
    () => included.filter((p) => !wAssignments.some((a) => a.userId === p.id)),
    [included, wAssignments],
  );
  const wBusy = wPhase === 'spinning-user' || wPhase === 'user-selected' || wPhase === 'spinning-pct';

  // Reset weighted state when switching modes
  useEffect(() => {
    if (mode !== 'weightedRoulette') return;
    setWAssignments([]);
    setWPhase('idle');
    setWSelectedUser(null);
    setWPercentOptions(generatePercentageOptions(100));
  }, [mode]);

  // Store references for async callbacks
  const wSelectedUserRef = useRef<string | null>(null);
  const wPctTargetIdxRef = useRef<number>(0);

  const finalizeWeighted = useCallback(
    (assignments: { userId: string; name: string; percentage: number }[]) => {
      setWAssignments(assignments);
      setWPhase('complete');
      successHaptic();
      onWeightedComplete?.(assignments.map((a) => ({ userId: a.userId, percentage: a.percentage })));
    },
    [onWeightedComplete],
  );

  const handleWeightedSpin = useCallback(() => {
    if (wRemainingParticipants.length === 0 || wRemainingPct <= 0 || wPhase !== 'idle') return;
    heavyHaptic();
    setWPhase('spinning-user');

    const idx = Math.floor(Math.random() * wRemainingParticipants.length);
    wSelectedUserRef.current = wRemainingParticipants[idx].id;
    setWSelectedUser(wRemainingParticipants[idx].id);

    // Pre-pick the percentage target so inner spin can fire right after outer completes
    const pctOptions = generatePercentageOptions(wRemainingPct);
    setWPercentOptions(pctOptions);
    wPctTargetIdxRef.current = Math.floor(Math.random() * pctOptions.length);

    weightedWheelRef.current?.spinOuter(idx);
  }, [wRemainingParticipants, wRemainingPct, wPhase]);

  const handleWeightedOuterComplete = useCallback((_userId: string) => {
    setWPhase('user-selected');
    // Quick pause then spin the inner ring
    setTimeout(() => {
      setWPhase('spinning-pct');
      weightedWheelRef.current?.spinInner(wPctTargetIdxRef.current);
    }, 700);
  }, []);

  const handleWeightedInnerComplete = useCallback(
    (percentage: number) => {
      const userId = wSelectedUserRef.current!;
      const userName = included.find((p) => p.id === userId)?.name ?? '';

      const newAssignment = { userId, name: userName, percentage };
      const allAssignments = [...wAssignments, newAssignment];

      const newRemainingPct = 100 - allAssignments.reduce((s, a) => s + a.percentage, 0);
      const newRemainingUsers = included.filter((p) => !allAssignments.some((a) => a.userId === p.id));

      if (newRemainingPct <= 0 || newRemainingUsers.length === 0) {
        finalizeWeighted(allAssignments);
      } else if (newRemainingUsers.length === 1) {
        // Auto-assign remaining to last person
        const last = { userId: newRemainingUsers[0].id, name: newRemainingUsers[0].name, percentage: newRemainingPct };
        finalizeWeighted([...allAssignments, last]);
      } else {
        setWAssignments(allAssignments);
        setWSelectedUser(null);
        setWPhase('idle');
        setWPercentOptions(generatePercentageOptions(newRemainingPct));
      }
    },
    [wAssignments, included, finalizeWeighted],
  );

  const handleWeightedReset = useCallback(() => {
    setWAssignments([]);
    setWPhase('idle');
    setWSelectedUser(null);
    setWPercentOptions(generatePercentageOptions(100));
  }, []);

  return (
    <View style={styles.section}>
      <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
        Fun Mode 🎲
      </Text>

      <View style={styles.gameModeRow}>
        {MODES.map((m) => (
          <TouchableOpacity
            key={m.key}
            style={[
              styles.gameModeChip,
              {
                backgroundColor: mode === m.key ? `${theme.colors.primary}20` : 'transparent',
                borderColor: mode === m.key ? theme.colors.primary : palette.border,
              },
            ]}
            onPress={() => { mediumHaptic(); onModeChange(m.key); }}
          >
            <Icon source={m.icon} size={18} color={mode === m.key ? theme.colors.primary : palette.muted} />
            <Text style={{ color: mode === m.key ? theme.colors.primary : palette.muted, fontSize: 12, fontWeight: '600' }}>
              {m.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {mode === 'roulette' && (
        <Text variant="bodySmall" style={[styles.hint, { color: palette.muted }]}>
          One random person pays 100%. Spin the wheel to find out who!
        </Text>
      )}

      {mode === 'weightedRoulette' && (
        <View>
          <Text variant="bodySmall" style={[styles.hint, { color: palette.muted }]}>
            Dual-ring roulette! Outer ring picks a person, inner ring picks their share. Spin until 100% is split.
          </Text>

          {/* Progress bar */}
          <View style={styles.wProgressContainer}>
            <View style={styles.wProgressBar}>
              <View style={[styles.wProgressFill, { width: `${wAllocated}%`, backgroundColor: theme.colors.primary }]} />
            </View>
            <Text variant="labelSmall" style={{ color: theme.colors.primary, fontWeight: '700' }}>
              {wAllocated}% / 100%
            </Text>
          </View>

          {/* The dual-ring wheel */}
          <WeightedRouletteWheel
            ref={weightedWheelRef}
            participants={wRemainingParticipants.map((p) => ({ ...p }))}
            percentages={wPercentOptions}
            onOuterSpinComplete={handleWeightedOuterComplete}
            onInnerSpinComplete={handleWeightedInnerComplete}
            disabled={wBusy}
            highlightedUserId={wSelectedUser}
          />

          {/* Status message */}
          {wPhase === 'spinning-user' && (
            <Animated.View entering={FadeIn.duration(200)}>
              <Text variant="bodySmall" style={{ color: '#F59E0B', textAlign: 'center', fontWeight: '700', marginTop: 4 }}>
                🎯 Selecting who's next…
              </Text>
            </Animated.View>
          )}
          {(wPhase === 'user-selected' || wPhase === 'spinning-pct') && (
            <Animated.View entering={FadeIn.duration(200)}>
              <Text variant="bodySmall" style={{ color: '#14B8A6', textAlign: 'center', fontWeight: '700', marginTop: 4 }}>
                📊 Selecting their share…
              </Text>
            </Animated.View>
          )}

          {/* Spin Button - placed right after wheel to stay visible */}
          {wPhase !== 'complete' && (
            <View style={styles.spinContainerInline}>
              <TouchableOpacity
                style={[
                  styles.spinButton,
                  {
                    backgroundColor: wBusy ? `${theme.colors.primary}80` : theme.colors.primary,
                  },
                ]}
                onPress={handleWeightedSpin}
                disabled={wBusy}
                activeOpacity={0.8}
              >
                <Icon source={wBusy ? 'loading' : 'rotate-right'} size={24} color="#FFF" />
                <Text style={styles.spinText}>
                  {wBusy ? 'Spinning…' : `Spin! (${wRemainingPct}% left)`}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Assignment list */}
          {wAssignments.length > 0 && (
            <View style={styles.wAssignmentList}>
              {wAssignments.map((a, i) => (
                <Animated.View key={a.userId} entering={FadeInDown.delay(i * 60).springify()}>
                  <View style={[styles.wAssignmentRow, { borderColor: palette.border }]}>
                    <View style={[styles.miniAvatar, { backgroundColor: AVATAR_COLORS[i % AVATAR_COLORS.length] }]}>
                      <Text style={styles.miniInitials}>{getInitials(a.name)}</Text>
                    </View>
                    <Text style={[styles.incomeName, { color: theme.colors.onSurface }]}>{a.name}</Text>
                    <Text variant="titleSmall" style={{ color: theme.colors.primary, fontWeight: '800' }}>
                      {a.percentage}%
                    </Text>
                    <Text variant="bodySmall" style={{ color: palette.muted }}>
                      {formatCurrency(totalAmount * a.percentage / 100, currency)}
                    </Text>
                  </View>
                </Animated.View>
              ))}
            </View>
          )}

          {/* Completion / reset */}
          {wPhase === 'complete' && (
            <Animated.View entering={ZoomIn.springify()}>
              <GlassView style={styles.resultCard} intensity={25}>
                <View style={styles.resultContent}>
                  <Text style={styles.resultEmoji}>✅</Text>
                  <Text variant="titleMedium" style={[styles.resultName, { color: theme.colors.onSurface }]}>
                    All shares assigned!
                  </Text>
                  <Text variant="bodySmall" style={{ color: palette.muted, textAlign: 'center' }}>
                    {(() => {
                      const count = included.filter((p) => !wAssignments.some((a) => a.userId === p.id)).length;
                      if (count === 0) return 'Everyone has a share!';
                      return count === 1 ? '1 person pays nothing 🎉' : `${count} people pay nothing 🎉`;
                    })()}
                  </Text>
                  <TouchableOpacity
                    style={[styles.wResetBtn, { borderColor: theme.colors.primary }]}
                    onPress={handleWeightedReset}
                  >
                    <Icon source="refresh" size={16} color={theme.colors.primary} />
                    <Text style={{ color: theme.colors.primary, fontSize: 13, fontWeight: '700' }}>Spin Again</Text>
                  </TouchableOpacity>
                </View>
              </GlassView>
            </Animated.View>
          )}
        </View>
      )}

      {mode === 'scrooge' && (
        <View>
          <Text variant="bodySmall" style={[styles.hint, { color: palette.muted }]}>
            Balance past payments — those who've paid less chip in more this time. ⚖️
          </Text>

          {/* Intensity Presets */}
          <View style={styles.karmaPresetsRow}>
            {KARMA_PRESETS.map((preset) => (
              <TouchableOpacity
                key={preset.key}
                style={[
                  styles.karmaPresetChip,
                  {
                    backgroundColor: karmaIntensity === preset.key ? `${theme.colors.primary}20` : 'transparent',
                    borderColor: karmaIntensity === preset.key ? theme.colors.primary : palette.border,
                  },
                ]}
                onPress={() => { lightHaptic(); setKarmaIntensity(preset.key); setKarmaApplied(false); }}
              >
                <Text style={{ fontSize: 14 }}>{preset.emoji}</Text>
                <Text
                  style={{
                    color: karmaIntensity === preset.key ? theme.colors.primary : palette.muted,
                    fontSize: 11,
                    fontWeight: '700',
                  }}
                >
                  {preset.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Karma Breakdown */}
          {karmaData.map((item, index) => {
            const equalShare = totalAmount / Math.max(included.length, 1);
            return (
              <Animated.View key={item.id} entering={FadeInDown.delay(index * 60).springify()}>
                <View style={[styles.karmaRow, { borderBottomColor: palette.border }]}>
                  <View style={[styles.miniAvatar, { backgroundColor: AVATAR_COLORS[index % AVATAR_COLORS.length] }]}>
                    <Text style={styles.miniInitials}>{getInitials(item.name)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.incomeName, { color: theme.colors.onSurface }]}>{item.name}</Text>
                    <View style={styles.karmaBarContainer}>
                      <View
                        style={[
                          styles.karmaBar,
                          {
                            width: `${Math.max(8, item.barWidth)}%`,
                            backgroundColor: item.isOverpayer ? '#10B981' : '#F59E0B',
                          },
                        ]}
                      />
                    </View>
                    <Text variant="labelSmall" style={{ color: palette.muted, marginTop: 2 }}>
                      {item.isOverpayer ? 'Overpaid' : 'Underpaid'} by {formatCurrency(Math.abs(item.deviation), currency)}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', minWidth: 70 }}>
                    <Text variant="titleSmall" style={{ color: theme.colors.primary, fontWeight: '800' }}>
                      {formatCurrency(item.computedAmount, currency)}
                    </Text>
                    {Math.abs(item.karmaAdjustment) >= 0.01 && (
                      <Text
                        variant="labelSmall"
                        style={{
                          color: item.karmaAdjustment < 0 ? '#10B981' : '#F59E0B',
                          fontWeight: '600',
                        }}
                      >
                        {item.karmaAdjustment > 0 ? '+' : ''}{formatCurrency(item.karmaAdjustment, currency)} vs equal
                      </Text>
                    )}
                  </View>
                </View>
              </Animated.View>
            );
          })}

          {/* Equal split reference */}
          {included.length > 0 && (
            <Text variant="labelSmall" style={{ color: palette.muted, textAlign: 'center', marginTop: 8 }}>
              Equal split would be {formatCurrency(totalAmount / included.length, currency)}/person
            </Text>
          )}

          {/* Apply / Reset */}
          {!karmaApplied ? (
            <View style={styles.spinContainer}>
              <TouchableOpacity
                style={[styles.spinButton, { backgroundColor: theme.colors.primary }]}
                onPress={handleApplyKarma}
                activeOpacity={0.8}
              >
                <Icon source="check-circle" size={24} color="#FFF" />
                <Text style={styles.spinText}>Apply Karma Split</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Animated.View entering={ZoomIn.springify()}>
              <GlassView style={styles.resultCard} intensity={25}>
                <View style={styles.resultContent}>
                  <Text style={styles.resultEmoji}>⚖️</Text>
                  <Text variant="titleMedium" style={[styles.resultName, { color: theme.colors.onSurface }]}>
                    Karma split applied!
                  </Text>
                  <Text variant="bodySmall" style={{ color: palette.muted, textAlign: 'center' }}>
                    Balanced based on past payments
                  </Text>
                  <TouchableOpacity
                    style={[styles.wResetBtn, { borderColor: theme.colors.primary }]}
                    onPress={handleResetKarma}
                  >
                    <Icon source="refresh" size={16} color={theme.colors.primary} />
                    <Text style={{ color: theme.colors.primary, fontSize: 13, fontWeight: '700' }}>Adjust &amp; Reapply</Text>
                  </TouchableOpacity>
                </View>
              </GlassView>
            </Animated.View>
          )}
        </View>
      )}

      {/* ── The Roulette Wheel ──────────────────────────────────────────── */}
      {showWheel && (
        <RouletteWheel
          ref={wheelRef}
          participants={participants}
          onSpinComplete={onSpinComplete}
          disabled={isSpinning}
        />
      )}

      {/* Spin Button */}
      {mode === 'roulette' && (
        <View style={styles.spinContainer}>
          <TouchableOpacity
            style={[
              styles.spinButton,
              {
                backgroundColor: isSpinning ? `${theme.colors.primary}80` : theme.colors.primary,
              },
            ]}
            onPress={onSpin}
            disabled={isSpinning}
            activeOpacity={0.8}
          >
            <Icon source={isSpinning ? 'loading' : 'rotate-right'} size={24} color="#FFF" />
            <Text style={styles.spinText}>
              {isSpinning ? 'Spinning…' : 'Spin the wheel!'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Winner Reveal (roulette only) ──────────────────────────────── */}
      {loserId && !isSpinning && mode === 'roulette' && (
        <Animated.View entering={ZoomIn.springify()}>
          <GlassView style={styles.resultCard} intensity={25}>
            <View style={styles.resultContent}>
              <Text style={styles.resultEmoji}>🎯</Text>
              <Text variant="headlineSmall" style={[styles.resultName, { color: theme.colors.onSurface }]}>
                {loserName} pays!
              </Text>
              <Text variant="titleLarge" style={{ color: theme.colors.primary, fontWeight: '800' }}>
                {formatCurrency(totalAmount, currency)}
              </Text>
            </View>
          </GlassView>
        </Animated.View>
      )}
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// F. ITEM-TYPE SPLIT
// ═══════════════════════════════════════════════════════════════════════════════
interface ItemTypeProps {
  categories: ItemCategory[];
  onCategoriesChange: (cats: ItemCategory[]) => void;
  participants: Participant[];
  currency: string;
  totalAmount: number;
}

const PRESET_CATEGORIES = [
  { label: 'Alcohol', icon: 'glass-cocktail' },
  { label: 'Meat', icon: 'food-drumstick' },
  { label: 'Dessert', icon: 'cupcake' },
  { label: 'Appetizers', icon: 'food' },
];

const ItemTypeMode = React.memo(({ categories, onCategoriesChange, participants, currency, totalAmount }: ItemTypeProps) => {
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;
  const included = participants.filter((p) => p.included);

  const addCategory = useCallback((label: string) => {
    lightHaptic();
    if (categories.find((c) => c.label === label)) return;
    onCategoriesChange([...categories, { id: `cat_${Date.now()}`, label, amount: 0, excludedParticipants: [] }]);
  }, [categories, onCategoriesChange]);

  const updateCategory = useCallback((id: string, field: string, value: number | string[]) => {
    onCategoriesChange(categories.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  }, [categories, onCategoriesChange]);

  const removeCategory = useCallback((id: string) => {
    mediumHaptic();
    onCategoriesChange(categories.filter((c) => c.id !== id));
  }, [categories, onCategoriesChange]);

  const toggleExclusion = useCallback((catId: string, userId: string) => {
    lightHaptic();
    const cat = categories.find((c) => c.id === catId);
    if (!cat) return;
    const excluded = cat.excludedParticipants.includes(userId)
      ? cat.excludedParticipants.filter((id) => id !== userId)
      : [...cat.excludedParticipants, userId];
    updateCategory(catId, 'excludedParticipants', excluded);
  }, [categories, updateCategory]);

  const categorizedTotal = categories.reduce((s, c) => s + c.amount, 0);
  const remaining = totalAmount - categorizedTotal;

  return (
    <View style={styles.section}>
      <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
        Category-Based Exclusions
      </Text>
      <Text variant="bodySmall" style={[styles.hint, { color: palette.muted }]}>
        Non-drinkers skip alcohol, vegetarians skip meat, etc. The remainder is split equally.
      </Text>

      <View style={styles.presetRow}>
        {PRESET_CATEGORIES.map((preset) => {
          const added = categories.find((c) => c.label === preset.label);
          return (
            <TouchableOpacity
              key={preset.label}
              style={[
                styles.presetChip,
                {
                  borderColor: added ? theme.colors.primary : palette.border,
                  backgroundColor: added ? `${theme.colors.primary}15` : 'transparent',
                },
              ]}
              onPress={() => added ? removeCategory(added.id) : addCategory(preset.label)}
            >
              <Icon source={preset.icon} size={16} color={added ? theme.colors.primary : palette.muted} />
              <Text style={{ color: added ? theme.colors.primary : palette.muted, fontSize: 12, fontWeight: '600' }}>
                {preset.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {categories.map((cat, ci) => (
        <Animated.View key={cat.id} entering={FadeInDown.delay(ci * 40).springify()}>
          <GlassView style={styles.itemCard} intensity={15}>
            <View style={styles.catHeader}>
              <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
                {cat.label}
              </Text>
              <View style={styles.inputRow}>
                <Text style={{ color: palette.muted }}>$</Text>
                <TextInput
                  style={[styles.catAmountInput, { color: theme.colors.onSurface, borderColor: palette.border }]}
                  value={cat.amount > 0 ? cat.amount.toString() : ''}
                  onChangeText={(v) => updateCategory(cat.id, 'amount', parseFloat(v) || 0)}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={palette.muted}
                />
              </View>
              <IconButton icon="close" size={16} iconColor={palette.muted} onPress={() => removeCategory(cat.id)} />
            </View>
            <Text variant="bodySmall" style={{ color: palette.muted, marginBottom: 8 }}>
              Exclude from this category:
            </Text>
            <View style={styles.exclusionRow}>
              {included.map((p, pi) => {
                const isExcluded = cat.excludedParticipants.includes(p.id);
                return (
                  <TouchableOpacity
                    key={p.id}
                    onPress={() => toggleExclusion(cat.id, p.id)}
                    style={[
                      styles.exclusionChip,
                      {
                        backgroundColor: isExcluded ? `${colors.danger}15` : 'transparent',
                        borderColor: isExcluded ? colors.danger : palette.border,
                      },
                    ]}
                  >
                    <Text style={{ color: isExcluded ? colors.danger : palette.muted, fontSize: 12, fontWeight: '600' }}>
                      {isExcluded ? '✗ ' : ''}{p.name.split(' ')[0]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </GlassView>
        </Animated.View>
      ))}

      {remaining > 0 && (
        <Text variant="bodySmall" style={[styles.hint, { color: palette.muted }]}>
          Remaining {formatCurrency(remaining, currency)} split equally among all {included.length} people.
        </Text>
      )}
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════
interface AdvancedModeContentProps {
  method: AdvancedSplitMethod;
  participants: Participant[];
  currency: string;
  totalAmount: number;
  // Itemized
  receiptItems: ReceiptItem[];
  onReceiptItemsChange: (items: ReceiptItem[]) => void;
  taxAmount: number;
  onTaxChange: (v: number) => void;
  tipAmount: number;
  onTipChange: (v: number) => void;
  // Income
  onIncomeWeightChange: (id: string, weight: string) => void;
  // Consumption
  totalParts: number;
  onTotalPartsChange: (v: number) => void;
  onPartsConsumedChange: (id: string, parts: string) => void;
  // Time
  onDaysChange: (id: string, days: string) => void;
  onDateRangeChange: (id: string, checkIn: string, checkOut: string) => void;
  onSetAllDays: (days: number) => void;
  onStayDatesChange: (id: string, dates: string[]) => void;
  timeSplitVariant: TimeSplitVariant;
  onTimeSplitVariantChange: (variant: TimeSplitVariant) => void;
  timePeriodDays: number;
  timePeriodStartDate: string;
  timePeriodEndDate: string;
  onTimePeriodRangeChange: (startDate: string, endDate: string) => void;
  // Gamified
  gamifiedMode: GamifiedMode;
  onGamifiedModeChange: (mode: GamifiedMode) => void;
  onRouletteWeightChange: (id: string, weight: string) => void;
  loserId: string | null;
  onSpin: () => void;
  spinTargetIndex: number | null;
  onSpinComplete: (winnerId: string) => void;
  isSpinning: boolean;
  onWeightedComplete?: (assignments: { userId: string; percentage: number }[]) => void;
  onKarmaComplete?: (results: { userId: string; amount: number }[]) => void;
  // Item Type
  itemCategories: ItemCategory[];
  onItemCategoriesChange: (cats: ItemCategory[]) => void;
}

export const AdvancedModeContent = React.memo((props: AdvancedModeContentProps) => {
  switch (props.method) {
    case 'itemized':
      return (
        <ItemizedReceiptMode
          items={props.receiptItems}
          onItemsChange={props.onReceiptItemsChange}
          taxAmount={props.taxAmount}
          onTaxChange={props.onTaxChange}
          tipAmount={props.tipAmount}
          onTipChange={props.onTipChange}
          participants={props.participants}
          currency={props.currency}
        />
      );
    case 'income':
      return (
        <IncomeProportionalMode
          participants={props.participants}
          onWeightChange={props.onIncomeWeightChange}
          currency={props.currency}
        />
      );
    case 'consumption':
      return (
        <ConsumptionMode
          totalParts={props.totalParts}
          onTotalPartsChange={props.onTotalPartsChange}
          participants={props.participants}
          onPartsChange={props.onPartsConsumedChange}
          currency={props.currency}
        />
      );
    case 'timeBased':
      return (
        <TimeBasedMode
          participants={props.participants}
          onDaysChange={props.onDaysChange}
          onDateRangeChange={props.onDateRangeChange}
          onSetAllDays={props.onSetAllDays}
          onStayDatesChange={props.onStayDatesChange}
          currency={props.currency}
          totalAmount={props.totalAmount}
          timeSplitVariant={props.timeSplitVariant}
          onTimeSplitVariantChange={props.onTimeSplitVariantChange}
          timePeriodDays={props.timePeriodDays}
          timePeriodStartDate={props.timePeriodStartDate}
          timePeriodEndDate={props.timePeriodEndDate}
          onTimePeriodRangeChange={props.onTimePeriodRangeChange}
        />
      );
    case 'gamified':
      return (
        <GamifiedMode_
          mode={props.gamifiedMode}
          onModeChange={props.onGamifiedModeChange}
          participants={props.participants}
          onWeightChange={props.onRouletteWeightChange}
          loserId={props.loserId}
          onSpin={props.onSpin}
          spinTargetIndex={props.spinTargetIndex}
          onSpinComplete={props.onSpinComplete}
          isSpinning={props.isSpinning}
          currency={props.currency}
          totalAmount={props.totalAmount}
          onWeightedComplete={props.onWeightedComplete}
          onKarmaComplete={props.onKarmaComplete}
        />
      );
    case 'itemType':
      return (
        <ItemTypeMode
          categories={props.itemCategories}
          onCategoriesChange={props.onItemCategoriesChange}
          participants={props.participants}
          currency={props.currency}
          totalAmount={props.totalAmount}
        />
      );
    default:
      return null;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════════
const styles = StyleSheet.create({
  section: {
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  sectionTitle: {
    fontWeight: '700',
    marginBottom: 4,
  },
  hint: {
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 8,
  },
  warningText: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  // Itemized
  itemCard: {
    borderRadius: 14,
    marginBottom: 8,
    padding: 0,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 8,
  },
  itemNameInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
  },
  itemPriceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  itemPriceInput: {
    width: 72,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
    textAlign: 'right',
  },
  assignRow: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  assignChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 6,
  },
  miniAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniInitials: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: '700',
  },
  assignName: {
    fontSize: 12,
    fontWeight: '600',
  },
  addBtn: {
    alignSelf: 'flex-start',
    borderRadius: 12,
  },
  extraRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: 8,
  },
  extraField: {
    flex: 1,
    gap: 4,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  extraInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
    textAlign: 'right',
  },
  // Income
  incomeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.15)',
  },
  incomeName: {
    flex: 1,
    fontWeight: '600',
    fontSize: 14,
  },
  incomeInput: {
    width: 80,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    fontSize: 13,
    textAlign: 'right',
  },
  incomePct: {
    minWidth: 40,
    textAlign: 'right',
  },
  // Consumption & shares
  totalPartsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.15)',
  },
  shareControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  shareBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareBtnText: {
    fontSize: 18,
    fontWeight: '600',
  },
  shareValue: {
    fontSize: 16,
    fontWeight: '700',
    minWidth: 20,
    textAlign: 'center',
  },
  // Time-Based (enhanced)
  timeVariantRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  timeVariantChip: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  timeInputModeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  timeInputModeChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
  },
  timePresetRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  timePresetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  timePeriodCard: {
    borderRadius: 18,
    marginBottom: 10,
  },
  timePeriodHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingTop: 14,
  },
  timePeriodHeaderText: {
    flex: 1,
    gap: 2,
  },
  timeFillAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  timePeriodControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  timeRangeSection: {
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  timeRangeSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  timeRangeSummaryText: {
    flex: 1,
    gap: 2,
  },
  timeMiniActionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  timeRangeSelectedRow: {
    flexDirection: 'row',
    gap: 8,
  },
  timeRangeSelectedChip: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  calendarNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  calendarNavButton: {
    width: 36,
    height: 36,
    borderWidth: 1,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarMonthCard: {
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 12,
  },
  calendarMonthHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  calendarWeekHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  calendarWeekLabel: {
    width: '14.2857%',
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calendarEmptyCell: {
    width: '14.2857%',
    height: 48,
  },
  calendarCellWrap: {
    width: '14.2857%',
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarDayCell: {
    width: 40,
    height: 40,
    borderWidth: 1,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarDayText: {
    fontSize: 14,
    fontWeight: '700',
  },
  timePeriodStepBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  timePeriodInput: {
    width: 76,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
  },
  timeSummaryCard: {
    borderRadius: 18,
    marginBottom: 8,
  },
  timeSummaryHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingTop: 14,
  },
  timeSummaryHeaderText: {
    flex: 1,
    gap: 2,
  },
  timeSummaryBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  timeMetricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  timeMetricCard: {
    width: '48%',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  timeMetricLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  timeMetricValue: {
    fontSize: 16,
    fontWeight: '800',
  },
  timeEmptyCard: {
    borderRadius: 14,
    marginBottom: 4,
  },
  timeEmptyContent: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 10,
  },
  timeParticipantCard: {
    borderRadius: 14,
    marginBottom: 8,
  },
  timeCardInner: {
    padding: 12,
    gap: 10,
  },
  timeRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  timeRowNameGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  timeParticipantTitleBlock: {
    flex: 1,
    gap: 1,
  },
  timeMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  timeMetaChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  timeDaysInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  timeDaysInput: {
    width: 64,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
  },
  timeInlinePill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  timeSliderInner: {
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  timeSliderTouchArea: {
    height: 40,
    justifyContent: 'center',
  },
  timeSliderTrack: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    overflow: 'hidden',
  },
  timeSliderFill: {
    height: '100%',
    borderRadius: TRACK_HEIGHT / 2,
  },
  timeSliderThumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    top: (40 - THUMB_SIZE) / 2,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 4,
  },
  timeSliderThumbInner: {
    width: THUMB_SIZE - 6,
    height: THUMB_SIZE - 6,
    borderRadius: (THUMB_SIZE - 6) / 2,
  },
  timeSliderLabels: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  timeDateContainer: {
    gap: 8,
  },
  timeDateFieldGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  timeDateField: {
    flex: 1,
  },
  timeDateLabel: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
  timeDateInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  timeDateHintBox: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  timeParticipantDateHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  timeParticipantDateSummary: {
    flex: 1,
    gap: 2,
  },
  timeParticipantDateActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 8,
  },
  timeParticipantCalendarStack: {
    gap: 10,
  },
  timeParticipantMonthActionRow: {
    gap: 8,
  },
  timeParticipantMonthActionButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  // Gamified
  gameModeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  gameModeChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
  },
  weightInput: {
    width: 56,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 13,
    textAlign: 'center',
  },
  spinContainer: {
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 100,
  },
  spinContainerInline: {
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 16,
  },
  spinButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 24,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
  },
  spinText: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '800',
  },
  resultCard: {
    borderRadius: 18,
    marginTop: 12,
  },
  resultContent: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 8,
  },
  resultEmoji: {
    fontSize: 40,
  },
  resultName: {
    fontWeight: '800',
  },
  // Item Type
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  presetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  catHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  catAmountInput: {
    width: 72,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 13,
    textAlign: 'right',
  },
  exclusionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  exclusionChip: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  // Weighted Roulette
  wProgressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4,
  },
  wProgressBar: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(128,128,128,0.15)',
    overflow: 'hidden',
  },
  wProgressFill: {
    height: '100%',
    borderRadius: 4,
  },
  wAssignmentList: {
    marginTop: 12,
    gap: 6,
  },
  wAssignmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  wResetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginTop: 12,
  },
  // Karma
  karmaPresetsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  karmaPresetChip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
  },
  karmaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  karmaBarContainer: {
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(128,128,128,0.12)',
    marginTop: 4,
    overflow: 'hidden',
  },
  karmaBar: {
    height: '100%',
    borderRadius: 3,
  },
});
