import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import { formatCurrency } from '@/utils/currency';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Avatar, IconButton, Text, TouchableRipple } from 'react-native-paper';
import Animated, { FadeInRight } from 'react-native-reanimated';

interface GroupCardProps {
  group: Group;
  onPress?: () => void;
  index?: number;
}

export const GroupCard = React.memo(({ group, onPress, index = 0 }: GroupCardProps) => {
  const { theme, isDark } = useTheme();
  const total = group.expenses.reduce((sum, expense) => sum + expense.amount, 0);

  return (
    <Animated.View entering={FadeInRight.delay(index * 80).springify()}>
      <GlassView style={styles.container}>
        <TouchableRipple onPress={onPress} style={{ flex: 1 }}>
          <View style={styles.content}>
            <View style={styles.header}>
              <Avatar.Text
                size={48}
                label={group.name.slice(0, 2).toUpperCase()}
                style={{ backgroundColor: theme.colors.primaryContainer }}
                color={theme.colors.onPrimaryContainer}
              />
              <View style={styles.meta}>
                <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>{group.name}</Text>
                <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
                  {group.members.length} members · {group.currency}
                </Text>
              </View>
              <IconButton icon="chevron-right" onPress={onPress} accessibilityLabel="Open group" iconColor={theme.colors.onSurfaceVariant} />
            </View>
            <Text variant="bodyMedium" style={[styles.total, { color: theme.colors.primary }]}>
              Total spent {formatCurrency(total, group.currency)}
            </Text>
          </View>
        </TouchableRipple>
      </GlassView>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  container: {
    borderRadius: 24,
    marginBottom: 12,
    marginHorizontal: 4,
  },
  content: {
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  meta: {
    flex: 1,
    marginLeft: 12,
  },
  subtitle: {
    // color handled dynamically
  },
  total: {
    marginTop: 12,
    fontWeight: '600',
    textAlign: 'right',
  },
});
