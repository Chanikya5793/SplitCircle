import { GlassView } from '@/components/GlassView';
import { colors, darkColors, spacing } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import { mediumHaptic } from '@/utils/haptics';
import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import Animated, { FadeInDown } from 'react-native-reanimated';
import type { AdvancedSplitMethod } from './types';

interface AdvancedOption {
  key: AdvancedSplitMethod;
  label: string;
  icon: string;
  description: string;
}

const ADVANCED_OPTIONS: AdvancedOption[] = [
  { key: 'itemized', label: 'Itemized Receipt', icon: 'receipt', description: 'Assign items & prorate tax/tip' },
  { key: 'income', label: 'By Income', icon: 'cash-multiple', description: 'Split proportional to salary' },
  { key: 'consumption', label: 'Consumption', icon: 'food-apple', description: 'E.g. 3 of 8 slices eaten' },
  { key: 'timeBased', label: 'Time-Based', icon: 'calendar-clock', description: 'Prorate by days stayed' },
  { key: 'gamified', label: 'Fun Mode', icon: 'dice-multiple', description: 'Roulette, Scrooge & more' },
  { key: 'itemType', label: 'By Category', icon: 'tag-multiple', description: 'Exclude non-drinkers etc.' },
];

interface AdvancedModePickerProps {
  onSelect: (method: AdvancedSplitMethod) => void;
}

export const AdvancedModePicker = React.memo(({ onSelect }: AdvancedModePickerProps) => {
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;

  return (
    <View style={styles.grid}>
      {ADVANCED_OPTIONS.map((opt, index) => (
        <Animated.View
          key={opt.key}
          entering={FadeInDown.delay(index * 60).springify()}
          style={styles.gridItem}
        >
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => { mediumHaptic(); onSelect(opt.key); }}
          >
            <GlassView style={styles.card} intensity={20}>
              <View style={styles.cardContent}>
                <View style={[styles.iconCircle, { backgroundColor: `${theme.colors.primary}18` }]}>
                  <Icon source={opt.icon} size={24} color={theme.colors.primary} />
                </View>
                <Text variant="labelLarge" style={[styles.cardLabel, { color: theme.colors.onSurface }]}>
                  {opt.label}
                </Text>
                <Text variant="bodySmall" style={[styles.cardDesc, { color: palette.muted }]} numberOfLines={2}>
                  {opt.description}
                </Text>
              </View>
            </GlassView>
          </TouchableOpacity>
        </Animated.View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  gridItem: {
    width: '47%',
  },
  card: {
    borderRadius: 16,
  },
  cardContent: {
    alignItems: 'center',
    paddingVertical: 18,
    paddingHorizontal: 12,
    gap: 8,
  },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  cardLabel: {
    fontWeight: '700',
    textAlign: 'center',
  },
  cardDesc: {
    textAlign: 'center',
    lineHeight: 16,
  },
});
