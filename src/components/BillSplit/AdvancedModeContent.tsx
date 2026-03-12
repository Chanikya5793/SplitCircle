import { GlassView } from '@/components/GlassView';
import { colors, darkColors, spacing } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import { formatCurrency } from '@/utils/currency';
import { lightHaptic, mediumHaptic } from '@/utils/haptics';
import React, { useCallback, useEffect, useRef } from 'react';
import { ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Button, Icon, IconButton, Text } from 'react-native-paper';
import Animated, { FadeInDown, ZoomIn, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import type { RouletteWheelRef } from './RouletteWheel';
import RouletteWheel from './RouletteWheel';
import type { AdvancedSplitMethod, GamifiedMode, ItemCategory, Participant, ReceiptItem } from './types';

const AVATAR_COLORS = ['#4F46E5', '#0891B2', '#059669', '#D97706', '#DC2626', '#7C3AED'];

function getInitials(name: string): string {
  return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
}

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
  currency: string;
}

const TimeBasedMode = React.memo(({ participants, onDaysChange, currency }: TimeBasedProps) => {
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;
  const totalDays = participants.filter((p) => p.included).reduce((s, p) => s + p.daysStayed, 0);

  return (
    <View style={styles.section}>
      <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
        Time-Based Split
      </Text>
      <Text variant="bodySmall" style={[styles.hint, { color: palette.muted }]}>
        Enter number of days each person stayed. Great for rent, Airbnb, or utilities.
      </Text>
      <Text variant="bodySmall" style={[styles.hint, { color: palette.muted }]}>
        Total: {totalDays} day{totalDays !== 1 ? 's' : ''}
      </Text>

      {participants.filter((p) => p.included).map((p, index) => {
        const pct = totalDays > 0 ? ((p.daysStayed / totalDays) * 100).toFixed(1) : '0';
        return (
          <Animated.View key={p.id} entering={FadeInDown.delay(index * 40).springify()}>
            <View style={styles.incomeRow}>
              <View style={[styles.miniAvatar, { backgroundColor: AVATAR_COLORS[index % AVATAR_COLORS.length] }]}>
                <Text style={styles.miniInitials}>{getInitials(p.name)}</Text>
              </View>
              <Text style={[styles.incomeName, { color: theme.colors.onSurface }]}>{p.name}</Text>
              <View style={styles.shareControls}>
                <TouchableOpacity
                  style={[styles.shareBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
                  onPress={() => { lightHaptic(); onDaysChange(p.id, Math.max(0, p.daysStayed - 1).toString()); }}
                >
                  <Text style={[styles.shareBtnText, { color: theme.colors.onSurface }]}>−</Text>
                </TouchableOpacity>
                <Text style={[styles.shareValue, { color: theme.colors.onSurface }]}>{p.daysStayed}</Text>
                <TouchableOpacity
                  style={[styles.shareBtn, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
                  onPress={() => { lightHaptic(); onDaysChange(p.id, (p.daysStayed + 1).toString()); }}
                >
                  <Text style={[styles.shareBtnText, { color: theme.colors.onSurface }]}>+</Text>
                </TouchableOpacity>
              </View>
              <Text variant="bodySmall" style={{ color: palette.muted }}>{pct}%</Text>
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
// E. GAMIFIED / RANDOMIZED SPLITS
// ═══════════════════════════════════════════════════════════════════════════════
interface GamifiedProps {
  mode: GamifiedMode;
  onModeChange: (mode: GamifiedMode) => void;
  participants: Participant[];
  onWeightChange: (id: string, weight: string) => void;
  loserId: string | null;
  /** Called to request a spin – parent should compute the winner, then call onSpinReady */
  onSpin: () => void;
  /** Index of the winner segment – set by parent after computing, triggers the wheel animation */
  spinTargetIndex: number | null;
  onSpinComplete: (winnerId: string) => void;
  isSpinning: boolean;
  currency: string;
  totalAmount: number;
}

const GamifiedMode_ = React.memo(({
  mode, onModeChange, participants, onWeightChange, loserId, onSpin,
  spinTargetIndex, onSpinComplete, isSpinning, currency, totalAmount,
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

  // Scrooge fallback spinner animation (no wheel needed)
  const spinRotation = useSharedValue(0);
  useEffect(() => {
    if (isSpinning && mode === 'scrooge') {
      spinRotation.value = 0;
      spinRotation.value = withRepeat(
        withTiming(360, { duration: 400 }),
        -1,
        false,
      );
    } else if (mode === 'scrooge') {
      spinRotation.value = withTiming(0, { duration: 300 });
    }
  }, [isSpinning, mode, spinRotation]);

  const scroogeSpinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spinRotation.value}deg` }],
  }));

  const MODES: { key: GamifiedMode; label: string; icon: string }[] = [
    { key: 'roulette', label: 'Roulette', icon: 'poker-chip' },
    { key: 'weightedRoulette', label: 'Weighted', icon: 'scale-balance' },
    { key: 'scrooge', label: 'Scrooge', icon: 'currency-usd-off' },
  ];

  const showWheel = mode === 'roulette';

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
            Set probability weights for each person, then spin.
          </Text>
          {included.map((p, index) => {
            const totalWeight = included.reduce((s, pp) => s + pp.rouletteWeight, 0);
            const pct = totalWeight > 0 ? ((p.rouletteWeight / totalWeight) * 100).toFixed(0) : '0';
            return (
              <View key={p.id} style={styles.incomeRow}>
                <View style={[styles.miniAvatar, { backgroundColor: AVATAR_COLORS[index % AVATAR_COLORS.length] }]}>
                  <Text style={styles.miniInitials}>{getInitials(p.name)}</Text>
                </View>
                <Text style={[styles.incomeName, { color: theme.colors.onSurface }]}>{p.name}</Text>
                <TextInput
                  style={[styles.weightInput, { color: theme.colors.onSurface, borderColor: palette.border }]}
                  value={p.rouletteWeight > 0 ? p.rouletteWeight.toString() : ''}
                  onChangeText={(v) => onWeightChange(p.id, v)}
                  keyboardType="numeric"
                  placeholder="0"
                  placeholderTextColor={palette.muted}
                />
                <Text variant="bodySmall" style={{ color: palette.muted, minWidth: 36 }}>{pct}%</Text>
              </View>
            );
          })}
        </View>
      )}

      {mode === 'scrooge' && (
        <View>
          <Text variant="bodySmall" style={[styles.hint, { color: palette.muted }]}>
            The person who has paid the least historically foots this bill. 💸
          </Text>
          {included.map((p, index) => (
            <View key={p.id} style={styles.incomeRow}>
              <View style={[styles.miniAvatar, { backgroundColor: AVATAR_COLORS[index % AVATAR_COLORS.length] }]}>
                <Text style={styles.miniInitials}>{getInitials(p.name)}</Text>
              </View>
              <Text style={[styles.incomeName, { color: theme.colors.onSurface }]}>{p.name}</Text>
              <Text variant="bodySmall" style={{ color: palette.muted }}>
                Paid: {formatCurrency(p.historicalPaid, currency)}
              </Text>
            </View>
          ))}
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
          {mode === 'scrooge' ? (
            <Animated.View style={scroogeSpinStyle}>
              <Icon source="dice-multiple" size={24} color="#FFF" />
            </Animated.View>
          ) : (
            <Icon source={isSpinning ? 'loading' : 'rotate-right'} size={24} color="#FFF" />
          )}
          <Text style={styles.spinText}>
            {isSpinning ? 'Spinning…' : showWheel ? 'Spin the wheel!' : 'Spin!'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Winner Reveal ──────────────────────────────────────────────── */}
      {loserId && !isSpinning && (
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
  // Gamified
  gamifiedMode: GamifiedMode;
  onGamifiedModeChange: (mode: GamifiedMode) => void;
  onRouletteWeightChange: (id: string, weight: string) => void;
  loserId: string | null;
  onSpin: () => void;
  spinTargetIndex: number | null;
  onSpinComplete: (winnerId: string) => void;
  isSpinning: boolean;
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
          currency={props.currency}
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
    marginBottom: 8,
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
});
