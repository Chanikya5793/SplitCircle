import { GlassView } from '@/components/GlassView';
import { GroupAvatar } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import { useMoneyDisplay } from '@/hooks/useMoneyDisplay';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import { usePressFeedback } from '@/hooks/usePressFeedback';
import { heavyHaptic, lightHaptic } from '@/utils/haptics';
import { clearOpenSwipeable, setOpenSwipeable } from '@/utils/swipeableRegistry';
import React, { useRef } from 'react';
import { Animated as RNAnimated, StyleSheet, View } from 'react-native';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { ActivityIndicator, Icon, IconButton, Text, TouchableRipple } from 'react-native-paper';

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
  const isFlat = theme?.surfaceStyle === 'flat';
  const swipeableRef = useRef<Swipeable>(null);
  const { pressScaleStyle, touchableProps } = usePressFeedback();
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
      <RNAnimated.View style={[styles.rightAction, !isFlat && styles.rightActionGlass, { transform: [{ translateX }, { scale }] }]}>
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
        onSwipeableWillOpen={() => {
        lightHaptic();
        setOpenSwipeable(swipeableRef.current);
      }}
      onSwipeableClose={() => clearOpenSwipeable(swipeableRef.current)}
      >
        <Animated.View style={pressScaleStyle}>
        <GlassView style={[styles.container, !isFlat && styles.containerGlass]}>
          <TouchableRipple
            onPress={loading ? undefined : handlePress}
            onLongPress={loading || !onLongPress ? undefined : () => { lightHaptic(); onLongPress(group); }}
            style={{ flex: 1 }}
            disabled={loading}
            {...touchableProps}
          >
            {/* Two lines, not three. The total used to sit on its own
                right-aligned third line under a "Total spent " label, which
                cost a full line of height per row for one number — it now
                sits at the end of the row, where a list amount belongs, and
                the label is dropped (the currency beside it already says
                what it is). */}
            <View style={styles.content}>
              <View style={styles.header}>
                <GroupAvatar photoURL={group.photoURL} name={displayName} size={40} />
                <View style={styles.meta}>
                  <Text variant="titleMedium" style={{ fontWeight: '600', color: theme.colors.onSurface }} numberOfLines={1}>{displayName}</Text>
                  <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]} numberOfLines={1}>
                    {group.members.length} members · {group.currency}
                  </Text>
                </View>
                <Text variant="bodyMedium" style={[styles.total, { color: theme.colors.primary }]} numberOfLines={1}>
                  {fmtMoney(total, group.currency)}
                </Text>
                {loading ? (
                  <View style={styles.loadingIndicator}>
                    <ActivityIndicator animating size="small" color={theme.colors.primary} />
                  </View>
                ) : (
                  <Icon source="chevron-right" size={20} color={theme.colors.onSurfaceVariant} />
                )}
              </View>
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
    marginHorizontal: 4,
  },
  /** Glass only: the gap between floating cards IS the row separation. In
   *  flat mode the rows butt together and a ListSeparator draws the line, so
   *  this margin collapses — otherwise the separator sits inside the margin
   *  and reads asymmetric. Must stay in step with rightAction's margin, or
   *  the swipe action drifts out of alignment with the row. */
  containerGlass: {
    marginBottom: 6,
  },
  content: {
    paddingVertical: 8,
    paddingHorizontal: 11,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  meta: {
    flex: 1,
    minWidth: 0,
    marginLeft: 4,
  },
  subtitle: {
    // color handled dynamically
  },
  total: {
    fontWeight: '700',
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
    marginRight: 4,
  },
  /** Mirrors containerGlass — see the note there. */
  rightActionGlass: {
    marginBottom: 6,
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
