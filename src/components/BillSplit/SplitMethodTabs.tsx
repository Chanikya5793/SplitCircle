import { colors, darkColors, spacing } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import { mediumHaptic } from '@/utils/haptics';
import React, { useCallback } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Text } from 'react-native-paper';
import {
    useSharedValue,
    withSpring
} from 'react-native-reanimated';
import type { BasicSplitMethod } from './types';

interface Tab {
  key: BasicSplitMethod;
  label: string;
  icon: string;
}

const TABS: Tab[] = [
  { key: 'equal', label: '=', icon: '=' },
  { key: 'exact', label: '1.23', icon: '1.23' },
  { key: 'percentage', label: '%', icon: '%' },
  { key: 'shares', label: 'Shares', icon: '∷' },
  { key: 'adjustment', label: '+/−', icon: '+/−' },
];

interface SplitMethodTabsProps {
  activeMethod: BasicSplitMethod;
  onSelect: (method: BasicSplitMethod) => void;
}

export const SplitMethodTabs = React.memo(({ activeMethod, onSelect }: SplitMethodTabsProps) => {
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;
  const activeIndex = useSharedValue(TABS.findIndex((t) => t.key === activeMethod));

  const handleSelect = useCallback((method: BasicSplitMethod, index: number) => {
    mediumHaptic();
    activeIndex.value = withSpring(index, { damping: 15, stiffness: 150 });
    onSelect(method);
  }, [onSelect, activeIndex]);

  return (
    <View style={styles.container}>
      <View style={[styles.tabRow, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }]}>
        {TABS.map((tab, index) => {
          const isActive = tab.key === activeMethod;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[
                styles.tab,
                isActive && { backgroundColor: theme.colors.primary },
              ]}
              activeOpacity={0.7}
              onPress={() => handleSelect(tab.key, index)}
            >
              <Text
                style={[
                  styles.tabText,
                  {
                    color: isActive ? '#FFF' : palette.muted,
                    fontWeight: isActive ? '700' : '500',
                  },
                ]}
              >
                {tab.icon}
              </Text>
              <Text
                style={[
                  styles.tabLabel,
                  {
                    color: isActive ? '#FFF' : palette.muted,
                    fontWeight: isActive ? '600' : '400',
                  },
                ]}
                numberOfLines={1}
              >
                {tab.label === tab.icon ? '' : tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  tabRow: {
    flexDirection: 'row',
    borderRadius: 14,
    padding: 3,
    gap: 2,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 12,
    gap: 2,
  },
  tabText: {
    fontSize: 16,
    fontWeight: '600',
  },
  tabLabel: {
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
