import { GlassView } from '@/components/GlassView';
import { GroupAvatar } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import { useMoneyDisplay } from '@/hooks/useMoneyDisplay';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import { usePressScale } from '@/hooks/usePressScale';
import { heavyHaptic, lightHaptic } from '@/utils/haptics';
import React, { useRef } from 'react';
import { Animated as RNAnimated, StyleSheet, View } from 'react-native';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { ActivityIndicator, IconButton, Text, TouchableRipple } from 'react-native-paper';

interface SwipeableGroupCardProps {
  group: Group;
  onPress?: () => void;
  /** Long-press: quick-actions menu (add expense, settle, stats, archive). */
  onLongPress?: (group: Group) => void;
  /** Swipe-left action. Archives normally; unarchives when `archived` is set. */
  onArchive?: (group: Group) => void;
  /** Renders the card in its archived variant (unarchive swipe action). */
  archived?: boolean;
  index?: number;
  loading?: boolean;
}

export const SwipeableGroupCard = React.memo(({ group, onPress, onLongPress, onArchive, archived = false, index = 0, loading = false }: SwipeableGroupCardProps) => {
  const fmtMoney = useMoneyDisplay(group.groupId);
  const { maskGroupName } = usePrivacyMask();
  const displayName = maskGroupName(group.name, group.groupId);
  const { theme } = useTheme();
  const swipeableRef = useRef<Swipeable>(null);
  const { pressScaleStyle, onPressIn, onPressOut } = usePressScale();
  const total = group.expenses.reduce((sum, expense) => sum + expense.amount, 0);

  const handlePress = () => {
    if (loading) {
      return;
    }
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
          style={[styles.archiveButton, { backgroundColor: archived ? '#34C759' : (theme.colors.tertiary || '#FF9500') }]}
          onPress={() => {
            heavyHaptic();
            swipeableRef.current?.close();
            onArchive?.(group);
          }}
        >
          <IconButton icon={archived ? 'archive-arrow-up' : 'archive'} iconColor="#fff" size={24} />
          <Text style={styles.actionText}>{archived ? 'Restore' : 'Archive'}</Text>
        </RectButton>
      </RNAnimated.View>
    );
  };

  return (
    <View>
      <Swipeable
        ref={swipeableRef}
        renderRightActions={onArchive ? renderRightActions : undefined}
        friction={2}
        rightThreshold={40}
        overshootFriction={8}
        onSwipeableWillOpen={lightHaptic}
      >
        <Animated.View style={pressScaleStyle}>
        <GlassView style={styles.container}>
          <TouchableRipple onPress={loading ? undefined : handlePress} onLongPress={loading || !onLongPress ? undefined : () => { lightHaptic(); onLongPress(group); }} onPressIn={onPressIn} onPressOut={onPressOut} style={{ flex: 1 }} disabled={loading}>
            <View style={styles.content}>
              <View style={styles.header}>
                <GroupAvatar photoURL={group.photoURL} name={displayName} size={48} />
                <View style={styles.meta}>
                  <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>{displayName}</Text>
                  <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
                    {group.members.length} members · {group.currency}
                  </Text>
                </View>
                {loading ? (
                  <View style={styles.loadingIndicator}>
                    <ActivityIndicator animating size="small" color={theme.colors.primary} />
                  </View>
                ) : (
                  <IconButton icon="chevron-right" onPress={handlePress} accessibilityLabel="Open group" iconColor={theme.colors.onSurfaceVariant} />
                )}
              </View>
              <Text variant="bodyMedium" style={[styles.total, { color: theme.colors.primary }]}>
                Total spent {fmtMoney(total, group.currency)}
              </Text>
            </View>
          </TouchableRipple>
        </GlassView>
        </Animated.View>
      </Swipeable>
    </View>
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
  loadingIndicator: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
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
