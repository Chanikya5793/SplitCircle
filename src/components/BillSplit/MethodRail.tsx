// MethodRail — THE method selector for split options. One horizontal rail of
// all eleven methods (5 basic + 6 advanced) replaces the old two-tier stack
// (segmented tabs + "Advanced Splits" accordion + 2×3 grid + breadcrumb),
// reclaiming ~300px of vertical space and removing a whole navigation level.
// Selected pill is solid accent; everything else is quiet. The rail scrolls
// horizontally and reveals the selection only when it is clipped.

import { useTheme } from '@/context/ThemeContext';
import { mediumHaptic } from '@/utils/haptics';
import React, { useEffect, useRef } from 'react';
import { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import type { AdvancedSplitMethod, BasicSplitMethod, SplitMethod } from './types';

interface RailItem {
  key: SplitMethod;
  label: string;
  icon: string;
  advanced: boolean;
  description: string;
}

const ITEMS: RailItem[] = [
  { key: 'equal', label: 'Equally', icon: 'equal', advanced: false, description: 'Divide the total equally among the included people.' },
  { key: 'exact', label: 'Exact amounts', icon: 'calculator-variant-outline', advanced: false, description: 'Enter the amount each person pays. The amounts must add up to the total.' },
  { key: 'percentage', label: 'Percentages', icon: 'percent', advanced: false, description: 'Enter each person’s percentage. Together they must add up to 100%.' },
  { key: 'shares', label: 'Shares', icon: 'chart-pie', advanced: false, description: 'Give each person a number of shares. Two shares pay twice as much as one.' },
  { key: 'adjustment', label: 'Adjust amounts', icon: 'plus-minus-variant', advanced: false, description: 'Add or subtract amounts for each person, then divide the remainder equally.' },
  { key: 'itemized', label: 'By receipt item', icon: 'receipt', advanced: true, description: 'Assign receipt items to people and choose how to split tax and tip.' },
  { key: 'income', label: 'By weight', icon: 'scale-balance', advanced: true, description: 'Enter a weight for each person. Higher weights pay a larger share.' },
  { key: 'consumption', label: 'By portions', icon: 'food-apple', advanced: true, description: 'Set the total portions, then enter how many each person had.' },
  { key: 'timeBased', label: 'By time', icon: 'calendar-clock', advanced: true, description: 'Choose the billing period and the days each person stayed.' },
  { key: 'gamified', label: 'Games', icon: 'dice-multiple', advanced: true, description: 'Choose a game, review its result, then confirm the split.' },
  { key: 'itemType', label: 'By category', icon: 'tag-multiple', advanced: true, description: 'Enter an amount for each category and exclude anyone who should not pay for it.' },
];

interface MethodRailProps {
  activeMethod: SplitMethod;
  onSelectBasic: (method: BasicSplitMethod) => void;
  onSelectAdvanced: (method: AdvancedSplitMethod) => void;
}

// Margin kept between the active pill and the rail's clipped edges when we do
// have to scroll — enough to reveal a sliver of the neighbouring pill so the
// rail still reads as scrollable.
const EDGE_PEEK = 28;

export const MethodRail = React.memo(({ activeMethod, onSelectBasic, onSelectAdvanced }: MethodRailProps) => {
  const { theme } = useTheme();
  const scrollRef = useRef<ScrollView>(null);
  const pillLayouts = useRef<Partial<Record<SplitMethod, { x: number; width: number }>>>({});
  const scrollX = useRef(0);
  const viewportWidth = useRef(0);
  const activeMethodRef = useRef(activeMethod);
  activeMethodRef.current = activeMethod;
  const didInitialRevealRef = useRef(false);

  // Scroll ONLY when the active pill is clipped, and only just far enough to
  // uncover it. Tapping an already-visible pill must never move the rail —
  // the old "auto-center everything" behaviour yanked the whole row sideways
  // on every selection.
  const revealActivePill = () => {
    const layout = pillLayouts.current[activeMethodRef.current];
    const viewport = viewportWidth.current;
    if (!layout || viewport <= 0) return false;

    const visibleLeft = scrollX.current;
    const visibleRight = scrollX.current + viewport;

    if (layout.x < visibleLeft + EDGE_PEEK) {
      scrollRef.current?.scrollTo({ x: Math.max(0, layout.x - EDGE_PEEK), animated: !theme.reduceMotion });
    } else if (layout.x + layout.width > visibleRight - EDGE_PEEK) {
      scrollRef.current?.scrollTo({ x: layout.x + layout.width - viewport + EDGE_PEEK, animated: !theme.reduceMotion });
    }
    return true;
  };

  useEffect(() => {
    revealActivePill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMethod, theme.reduceMotion]);

  // On first mount the effect above runs before any pill has reported its
  // layout, so reopening an expense saved with an advanced method would leave
  // the selection stranded off-screen. Layout callbacks retry the reveal once
  // measurements exist.
  const maybeInitialReveal = () => {
    if (didInitialRevealRef.current) return;
    if (revealActivePill()) didInitialRevealRef.current = true;
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollX.current = event.nativeEvent.contentOffset.x;
  };

  const handleViewportLayout = (event: LayoutChangeEvent) => {
    viewportWidth.current = event.nativeEvent.layout.width;
    maybeInitialReveal();
  };

  const activeItem = ITEMS.find((item) => item.key === activeMethod);

  return (
    <View>
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.rail}
      onScroll={handleScroll}
      scrollEventThrottle={32}
      onLayout={handleViewportLayout}
    >
      {ITEMS.map((item) => {
        const selected = item.key === activeMethod;
        return (
          <TouchableOpacity
            key={item.key}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={item.label}
            accessibilityHint={item.description}
            activeOpacity={0.75}
            onLayout={(event) => {
              pillLayouts.current[item.key] = {
                x: event.nativeEvent.layout.x,
                width: event.nativeEvent.layout.width,
              };
              if (item.key === activeMethodRef.current) maybeInitialReveal();
            }}
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
                borderColor: selected
                  ? theme.colors.primary
                  : theme.dark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)',
              },
            ]}
          >
            <Icon source={item.icon} size={16} color={selected ? theme.colors.onPrimary : theme.colors.muted} />
            <Text
              style={{
                color: selected ? theme.colors.onPrimary : theme.colors.onSurface,
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
    <Text
      style={[styles.explanation, theme.typography.caption, { color: theme.colors.onSurfaceVariant }]}
      accessibilityLiveRegion="polite"
    >
      {activeItem?.description}
    </Text>
    </View>
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
    paddingVertical: 10,
    borderRadius: 19,
    borderWidth: 1,
  },
  explanation: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  advancedDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginLeft: 1,
  },
});
