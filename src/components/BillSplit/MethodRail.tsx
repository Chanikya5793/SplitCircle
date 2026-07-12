// MethodRail — THE method selector for split options. One horizontal rail of
// all eleven methods (5 basic + 6 advanced) replaces the old two-tier stack
// (segmented tabs + "Advanced Splits" accordion + 2×3 grid + breadcrumb),
// reclaiming ~300px of vertical space and removing a whole navigation level.
// Selected pill is solid accent; everything else is quiet. The rail scrolls
// horizontally and auto-centers the selection.

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
      scrollRef.current?.scrollTo({ x: Math.max(0, layout.x - EDGE_PEEK), animated: true });
    } else if (layout.x + layout.width > visibleRight - EDGE_PEEK) {
      scrollRef.current?.scrollTo({ x: layout.x + layout.width - viewport + EDGE_PEEK, animated: true });
    }
    return true;
  };

  useEffect(() => {
    revealActivePill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMethod]);

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

  return (
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
