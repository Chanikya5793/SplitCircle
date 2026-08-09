import { GlassView } from '@/components/GlassView';
import { fullBleed, GroupAvatar } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import { useMoneyDisplay } from '@/hooks/useMoneyDisplay';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import { usePressFeedback } from '@/hooks/usePressFeedback';
import { shouldStackRow } from '@/utils/a11yText';
import { computeMyGroupBalance } from '@/utils/myBalance';
import { useAuth } from '@/context/AuthContext';
import { heavyHaptic, lightHaptic } from '@/utils/haptics';
import { clearOpenSwipeable, setOpenSwipeable } from '@/utils/swipeableRegistry';
import React, { useRef } from 'react';
import { Animated as RNAnimated, StyleSheet, useWindowDimensions, View } from 'react-native';
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
  // Restacks rather than truncating. Width-aware, not just scale-aware: money
  // is the one thing on this row that must never be cut off, and whether it
  // fits depends on the screen as much as the text size (see a11yText).
  const { width: windowWidth } = useWindowDimensions();
  const bigText = shouldStackRow(theme?.fontScale ?? 1, windowWidth);
  const swipeableRef = useRef<Swipeable>(null);
  const { pressScaleStyle, pressHighlightStyle, touchableProps } = usePressFeedback();
  // What the row shows is YOUR position, not the group's turnover: total
  // spend is the same number for everyone in the group and says nothing about
  // whether you need to do anything. Derived on-device from the expenses and
  // settlements already in memory — no Firebase read, and correct even for an
  // expense added offline that hasn't pushed yet. See utils/myBalance.ts.
  const { user } = useAuth();
  const myBalance = computeMyGroupBalance(user?.userId, group);
  const balanceLabel =
    myBalance > 0 ? 'you are owed' : myBalance < 0 ? 'you owe' : 'settled up';
  const balanceColor =
    myBalance > 0
      ? theme.colors.moneyPositive
      : myBalance < 0
        ? theme.colors.moneyNegative
        : theme.colors.moneyNeutral;

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

    // Flat rows are FULL-BLEED: they cancel the list's gutter so the press
    // highlight and the row divider reach both screen edges, like a native
    // list. Both consumers (GroupListScreen, ArchivedGroupsScreen) use the
    // standard SCREEN_GUTTER, so this is safe to bake in. See ui/layout.
  return (
    <View style={isFlat ? styles.bleed : undefined}>
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
            accessibilityRole="button"
            // Spelled out rather than left to RN's child-concatenation, which
            // produced "Budget, 7 members · USD, $29,214.18" — the middot is
            // read aloud and the amount arrives with no idea what it means.
            accessibilityLabel={`${displayName}, ${group.members.length} member${group.members.length === 1 ? '' : 's'}, ${myBalance === 0 ? 'settled up' : `${balanceLabel} ${fmtMoney(Math.abs(myBalance), group.currency)}`}`}
            accessibilityHint="Opens the group"
            accessibilityState={{ busy: loading }}
            // Archive is otherwise a SWIPE-ONLY action, i.e. unreachable with a
            // screen reader on. Exposing it as a custom action puts it in
            // VoiceOver's rotor / TalkBack's actions menu. Same for the
            // long-press quick actions.
            accessibilityActions={[
              ...(onArchive ? [{ name: 'archive', label: archived ? 'Restore group' : 'Archive group' }] : []),
              ...(onLongPress ? [{ name: 'magicTap', label: 'Quick actions' }] : []),
            ]}
            onAccessibilityAction={({ nativeEvent: { actionName } }) => {
              if (actionName === 'archive') onArchive?.(group);
              if (actionName === 'magicTap') onLongPress?.(group);
            }}
            {...touchableProps}
          >
            {/* Two lines, not three. The total used to sit on its own
                right-aligned third line under a "Total spent " label, which
                cost a full line of height per row for one number — it now
                sits at the end of the row, where a list amount belongs, and
                the label is dropped (the currency beside it already says
                what it is). */}
            <Animated.View style={[styles.content, isFlat && styles.contentFlat, pressHighlightStyle]}>
              {/* At accessibility text sizes the amount moves BELOW the name
                  instead of competing with it for width. Keeping the single
                  row there truncates both ("Not lona anvmore" / "$6.16…") —
                  restacking is Apple's own pattern for this. */}
              <View style={[styles.header, bigText && styles.headerStacked]}>
                <GroupAvatar photoURL={group.photoURL} name={displayName} size={40} />
                <View style={styles.meta}>
                  <Text
                    variant="titleMedium"
                    style={{ fontWeight: '600', color: theme.colors.onSurface }}
                    // Names wrap rather than truncate once there is room to.
                    numberOfLines={bigText ? 3 : 1}
                  >
                    {displayName}
                  </Text>
                  <Text
                    variant="bodySmall"
                    style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}
                    numberOfLines={bigText ? 2 : 1}
                  >
                    {group.members.length} members · {group.currency}
                  </Text>
                  {bigText && (
                    <Text variant="bodyMedium" style={[styles.totalStacked, { color: balanceColor }]}>
                      {myBalance === 0 ? 'Settled up' : `${myBalance > 0 ? 'Owed' : 'You owe'} ${fmtMoney(Math.abs(myBalance), group.currency)}`}
                    </Text>
                  )}
                </View>
                {!bigText && (
                  <Text variant="bodyMedium" style={[styles.total, { color: balanceColor }]} numberOfLines={1}>
                    {myBalance === 0 ? 'Settled' : fmtMoney(Math.abs(myBalance), group.currency)}
                  </Text>
                )}
                {loading ? (
                  <View style={styles.loadingIndicator}>
                    <ActivityIndicator animating size="small" color={theme.colors.primary} />
                  </View>
                ) : (
                  <Icon source="chevron-right" size={20} color={theme.colors.onSurfaceVariant} />
                )}
              </View>
            </Animated.View>
          </TouchableRipple>
        </GlassView>
        </Animated.View>
      </Swipeable>
    </View>
  );
});

const styles = StyleSheet.create({
  bleed: {
    ...fullBleed,
  },
  container: {
    borderRadius: 24,
  },
  /** Glass only. Two things collapse in flat mode:
   *  - marginBottom: the gap between floating cards IS the row separation in
   *    glass; in flat a ListSeparator draws the line, and a surviving margin
   *    would put that line inside a row's own margin (reads asymmetric).
   *  - marginHorizontal: a floating card is inset from the screen edge, but a
   *    flat row is FULL-BLEED — its press highlight has to run edge to edge
   *    like a native list row. Only the TEXT is inset (contentFlat below).
   *  Must stay in step with rightAction/rightActionGlass or the swipe action
   *  drifts out of alignment with the row. */
  /** GLASS AND FLAT MUST PUT TEXT ON THE SAME X.
   *
   *  Toggling the surface style used to slide every row's avatar and label
   *  sideways — glass text landed at 31pt (16 gutter + 4 card margin + 11 card
   *  padding) and flat at 20pt, so the whole list jumped 11pt. Changing the
   *  MATERIAL should not move the CONTENT; that sideways lurch is what made the
   *  switch feel broken rather than like a restyle.
   *
   *  Both now resolve to 24pt: glass = 16 gutter + 0 card margin + 8 card
   *  padding, flat = 0 (full-bleed) + 24 padding. The card simply spans the
   *  screen gutter instead of being inset a further 4pt inside it. The vertical
   *  rhythm still differs — spaced cards vs a dense hairline list — because
   *  that IS the difference between the two modes. */
  containerGlass: {
    marginBottom: 6,
    marginHorizontal: 0,
  },
  content: {
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  /** Flat rows are full-bleed, so the text inset moves from the container's
   *  margin to the content's own padding. 20 = the 16 list gutter + the 4
   *  card margin that glass mode used, so text lands where it always did. */
  contentFlat: {
    paddingHorizontal: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  /** Accessibility sizes: align to the top so a wrapped 3-line name doesn't
   *  drag the avatar and chevron to its vertical centre. */
  headerStacked: {
    alignItems: 'flex-start',
  },
  totalStacked: {
    fontWeight: '700',
    marginTop: 2,
  },
  meta: {
    flex: 1,
    minWidth: 0,
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
  },
  /** Mirrors containerGlass — see the note there. */
  rightActionGlass: {
    marginBottom: 6,
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
