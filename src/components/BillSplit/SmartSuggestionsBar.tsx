import { GlassView } from '@/components/GlassView';
import { colors, darkColors, spacing } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import { lightHaptic } from '@/utils/haptics';
import React from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import Animated, { FadeInRight } from 'react-native-reanimated';
import type { SmartSuggestion } from './types';

interface SmartSuggestionsBarProps {
  suggestions: SmartSuggestion[];
  onSelect: (id: string) => void;
}

export const SmartSuggestionsBar = React.memo(({ suggestions, onSelect }: SmartSuggestionsBarProps) => {
  const { isDark, theme } = useTheme();
  const palette = isDark ? darkColors : colors;

  return (
    <View style={styles.wrapper}>
      <Text variant="labelSmall" style={[styles.label, { color: palette.muted }]}>
        Smart suggestions
      </Text>
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
            >
              <GlassView style={styles.chip} intensity={20}>
                <View style={styles.chipInner}>
                  <Icon source={s.icon} size={16} color={theme.colors.primary} />
                  <Text
                    variant="labelMedium"
                    style={[styles.chipLabel, { color: theme.colors.onSurface }]}
                    numberOfLines={1}
                  >
                    {s.label}
                  </Text>
                </View>
              </GlassView>
            </TouchableOpacity>
          </Animated.View>
        ))}
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    marginBottom: spacing.sm,
  },
  label: {
    marginLeft: spacing.md,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontSize: 10,
  },
  scrollContent: {
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  chip: {
    borderRadius: 20,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  chipInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chipLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
});
