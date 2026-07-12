// MethodRail — THE method selector for split options. One horizontal rail of
// all eleven methods (5 basic + 6 advanced) replaces the old two-tier stack
// (segmented tabs + "Advanced Splits" accordion + 2×3 grid + breadcrumb),
// reclaiming ~300px of vertical space and removing a whole navigation level.
// Selected pill is solid accent; everything else is quiet. The rail scrolls
// horizontally and auto-centers the selection.

import { useTheme } from '@/context/ThemeContext';
import { mediumHaptic } from '@/utils/haptics';
import React, { useEffect, useRef } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import type { AdvancedSplitMethod, BasicSplitMethod, SplitMethod } from './types';

interface RailItem {
  key: SplitMethod;
  label: string;
  icon: string;
  advanced: boolean;
}

const ITEMS: RailItem[] = [
  { key: 'equal', label: 'Equal', icon: 'equal', advanced: false },
  { key: 'exact', label: 'Exact', icon: 'currency-usd', advanced: false },
  { key: 'percentage', label: 'Percent', icon: 'percent', advanced: false },
  { key: 'shares', label: 'Shares', icon: 'chart-pie', advanced: false },
  { key: 'adjustment', label: 'Adjust', icon: 'plus-minus-variant', advanced: false },
  { key: 'itemized', label: 'Receipt', icon: 'receipt', advanced: true },
  { key: 'income', label: 'Income', icon: 'cash-multiple', advanced: true },
  { key: 'consumption', label: 'Consumed', icon: 'food-apple', advanced: true },
  { key: 'timeBased', label: 'Time', icon: 'calendar-clock', advanced: true },
  { key: 'gamified', label: 'Fun', icon: 'dice-multiple', advanced: true },
  { key: 'itemType', label: 'Category', icon: 'tag-multiple', advanced: true },
];

const PILL_WIDTH = 86; // approximate, for auto-centering math

interface MethodRailProps {
  activeMethod: SplitMethod;
  onSelectBasic: (method: BasicSplitMethod) => void;
  onSelectAdvanced: (method: AdvancedSplitMethod) => void;
}

export const MethodRail = React.memo(({ activeMethod, onSelectBasic, onSelectAdvanced }: MethodRailProps) => {
  const { theme } = useTheme();
  const scrollRef = useRef<ScrollView>(null);

  // Keep the active pill in view (e.g. reopening an expense saved with an
  // advanced method that lives off-screen to the right).
  useEffect(() => {
    const index = ITEMS.findIndex((item) => item.key === activeMethod);
    if (index > 3) {
      scrollRef.current?.scrollTo({ x: index * PILL_WIDTH - PILL_WIDTH * 1.5, animated: true });
    } else if (index >= 0 && index <= 1) {
      scrollRef.current?.scrollTo({ x: 0, animated: true });
    }
  }, [activeMethod]);

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.rail}
    >
      {ITEMS.map((item) => {
        const selected = item.key === activeMethod;
        return (
          <TouchableOpacity
            key={item.key}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            activeOpacity={0.75}
            onPress={() => {
              if (selected) return;
              mediumHaptic();
              if (item.advanced) onSelectAdvanced(item.key as AdvancedSplitMethod);
              else onSelectBasic(item.key as BasicSplitMethod);
            }}
            style={[
              styles.pill,
              {
                backgroundColor: selected ? theme.colors.primary : theme.colors.pressed,
                borderColor: selected ? theme.colors.primary : 'transparent',
              },
            ]}
          >
            <Icon source={item.icon} size={16} color={selected ? '#FFF' : theme.colors.muted} />
            <Text
              style={{
                color: selected ? '#FFF' : theme.colors.onSurface,
                fontSize: 12,
                fontWeight: selected ? '800' : '600',
              }}
              numberOfLines={1}
            >
              {item.label}
            </Text>
            {item.advanced && !selected && <View style={[styles.advancedDot, { backgroundColor: theme.colors.primary }]} />}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  rail: {
    paddingHorizontal: 16,
    gap: 8,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
  },
  advancedDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginLeft: 1,
  },
});
