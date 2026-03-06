import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import { formatCurrency } from '@/utils/currency';
import { heavyHaptic, lightHaptic } from '@/utils/haptics';
import React, { useRef } from 'react';
import { Animated as RNAnimated, StyleSheet, View } from 'react-native';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { Avatar, IconButton, Text, TouchableRipple } from 'react-native-paper';
import Animated, { FadeInRight } from 'react-native-reanimated';

interface SwipeableGroupCardProps {
  group: Group;
  onPress?: () => void;
  onArchive?: (group: Group) => void;
  index?: number;
}

export const SwipeableGroupCard = React.memo(({ group, onPress, onArchive, index = 0 }: SwipeableGroupCardProps) => {
  const { theme } = useTheme();
  const swipeableRef = useRef<Swipeable>(null);
  const total = group.expenses.reduce((sum, expense) => sum + expense.amount, 0);

  const handlePress = () => {
    lightHaptic();
    onPress?.();
  };

  const renderRightActions = (
    progress: RNAnimated.AnimatedInterpolation<number>,
    dragX: RNAnimated.AnimatedInterpolation<number>
  ) => {
    const translateX = dragX.interpolate({
      inputRange: [-100, 0],
      outputRange: [0, 100],
      extrapolate: 'clamp',
    });

    const scale = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [0.8, 1],
      extrapolate: 'clamp',
    });

    return (
      <RNAnimated.View style={[styles.rightAction, { transform: [{ translateX }, { scale }] }]}>
        <RectButton
          style={[styles.archiveButton, { backgroundColor: theme.colors.tertiary || '#FF9500' }]}
          onPress={() => {
            heavyHaptic();
            swipeableRef.current?.close();
            onArchive?.(group);
          }}
        >
          <IconButton icon="archive" iconColor="#fff" size={24} />
          <Text style={styles.actionText}>Archive</Text>
        </RectButton>
      </RNAnimated.View>
    );
  };

  return (
    <Animated.View entering={FadeInRight.delay(index * 80).springify()}>
      <Swipeable
        ref={swipeableRef}
        renderRightActions={onArchive ? renderRightActions : undefined}
        friction={2}
        rightThreshold={40}
        overshootRight={false}
      >
        <GlassView style={styles.container}>
          <TouchableRipple onPress={handlePress} style={{ flex: 1 }}>
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
                <IconButton icon="chevron-right" onPress={handlePress} accessibilityLabel="Open group" iconColor={theme.colors.onSurfaceVariant} />
              </View>
              <Text variant="bodyMedium" style={[styles.total, { color: theme.colors.primary }]}>
                Total spent {formatCurrency(total, group.currency)}
              </Text>
            </View>
          </TouchableRipple>
        </GlassView>
      </Swipeable>
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
  rightAction: {
    justifyContent: 'center',
    marginBottom: 12,
    marginRight: 4,
  },
  archiveButton: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    borderRadius: 24,
  },
  actionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    marginTop: -8,
  },
});
