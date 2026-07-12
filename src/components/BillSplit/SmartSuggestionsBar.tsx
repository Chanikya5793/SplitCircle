// SmartSuggestionsBar — chips learned from this group's real split history
// (see splitHistoryService). The parent renders this only when suggestions
// exist, so an empty history costs zero vertical space.
import { spacing } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import type { SplitSuggestion } from '@/services/splitHistoryService';
import { lightHaptic } from '@/utils/haptics';
import React from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import Animated, { FadeInRight } from 'react-native-reanimated';

interface SmartSuggestionsBarProps {
  suggestions: SplitSuggestion[];
  onSelect: (id: string) => void;
}

export const SmartSuggestionsBar = React.memo(({ suggestions, onSelect }: SmartSuggestionsBarProps) => {
  const { theme } = useTheme();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.scrollContent}
    >
      {suggestions.map((s, index) => (
        <Animated.View key={s.id} entering={FadeInRight.delay(index * 60).springify()}>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => { lightHaptic(); onSelect(s.id); }}
            style={[
              styles.chip,
              {
                backgroundColor: theme.dark ? 'rgba(28,31,38,0.96)' : 'rgba(255,255,255,0.97)',
                borderColor: theme.dark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)',
              },
            ]}
          >
            <Icon source={s.icon} size={15} color={theme.colors.primary} />
            <Text
              variant="labelMedium"
              style={[styles.chipLabel, { color: theme.colors.onSurface }]}
              numberOfLines={1}
            >
              {s.label}
            </Text>
          </TouchableOpacity>
        </Animated.View>
      ))}
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
});
