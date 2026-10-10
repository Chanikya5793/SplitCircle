import { GlassView } from '@/components/GlassView';
import { fullBleed, ListSeparator } from '@/components/ui';
import { useTheme } from '@/context/ThemeContext';
import type { Expense } from '@/models';
import { useMoneyDisplay } from '@/hooks/useMoneyDisplay';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import { usePressFeedback } from '@/hooks/usePressFeedback';
import { getExpenseSplitLabel } from '@/utils/expenseSplit';
import { errorHaptic, lightHaptic } from '@/utils/haptics';
import { clearOpenSwipeable, setOpenSwipeable } from '@/utils/swipeableRegistry';
import React, { useRef } from 'react';
import { Animated as RNAnimated, StyleSheet, View } from 'react-native';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { Icon, Text, TouchableRipple } from 'react-native-paper';
import Animated, { FadeInDown } from 'react-native-reanimated';

// Category to Icon mapping
const getCategoryIcon = (category: string): string => {
  const iconMap: Record<string, string> = {
    'General': 'tag',
    'Food': 'food',
    'Transport': 'car',
    'Utilities': 'flash',
    'Entertainment': 'movie',
    'Shopping': 'cart',
    'Travel': 'airplane',
    'Health': 'medical-bag',
    'Settlement': 'handshake',
  };
  return iconMap[category] || 'tag';
};

interface SwipeableExpenseCardProps {
  expense: Expense;
  currency: string;
  memberMap: Record<string, string>;
  onPress: () => void;
  /** Long-press: quick-actions menu (view, delete). */
  onLongPress?: () => void;
  onDelete?: (expense: Expense) => void;
  index?: number;
  groupId?: string;
}

export const SwipeableExpenseCard = ({
  expense,
  currency,
  memberMap,
  onPress,
  onLongPress,
  onDelete,
  index = 0,
  groupId,
}: SwipeableExpenseCardProps) => {
  const fmtMoney = useMoneyDisplay(groupId);
  const { maskGroupText, maskGroupDate } = usePrivacyMask();
  const { theme } = useTheme();
  const isFlat = theme?.surfaceStyle === 'flat';
  const swipeableRef = useRef<Swipeable>(null);
  const { pressScaleStyle, pressHighlightStyle, touchableProps } = usePressFeedback();
  const payerName = maskGroupText(memberMap[expense.paidBy] || 'Unknown', groupId, 'person');
  const isSettlement = expense.category === 'Settlement';
  const splitLabel = getExpenseSplitLabel(expense);

  const handlePress = () => {
    lightHaptic();
    onPress();
  };

  const renderRightActions = (
    progress: RNAnimated.AnimatedInterpolation<number>,
    dragX: RNAnimated.AnimatedInterpolation<number>
  ) => {
    const translateX = dragX.interpolate({
      inputRange: [-120, 0],
      outputRange: [0, 120],
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
          style={styles.rightActionPressable}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${maskGroupText(expense.title, groupId, 'title')}`}
          onPress={() => {
            errorHaptic();
            swipeableRef.current?.close();
            onDelete?.(expense);
          }}
        >
          <View style={[styles.deleteButtonPill, { backgroundColor: theme.colors.danger }]}>
            <Icon source="delete" color={theme.colors.onDanger} size={24} />
            <Text style={[styles.actionText, { color: theme.colors.onDanger }]}>Delete</Text>
          </View>
        </RectButton>
      </RNAnimated.View>
    );
  };

  // Flat mode draws its own bottom hairline instead of relying on a gap: this
  // list is a .map(), not a FlatList, so there is no ItemSeparatorComponent to
  // hang a ListSeparator off. Glass mode keeps the gap and no line — the cards
  // separate themselves.
  //
  // The line is a SIBLING ELEMENT, not a borderBottom on this wrapper: a border
  // covers its whole box, so it can only be full-bleed, and a full-bleed
  // hairline reads as a crack across the screen. ListSeparator insets both ends
  // and self-gates on surface style.
  return (
    <View style={isFlat ? styles.bleed : styles.glassGap}>
      <Swipeable
        ref={swipeableRef}
        renderRightActions={onDelete ? renderRightActions : undefined}
        friction={2}
        rightThreshold={40}
        overshootRight={false}
        onSwipeableWillOpen={() => {
        lightHaptic();
        setOpenSwipeable(swipeableRef.current);
      }}
      onSwipeableClose={() => clearOpenSwipeable(swipeableRef.current)}
        // Flat rows are square, full-width list rows — the 16pt rounded clip
        // is what made the press highlight read as a "squircle" floating
        // inside the row instead of filling it.
        containerStyle={isFlat ? undefined : { borderRadius: 16, overflow: 'hidden' }}
      >
        <Animated.View style={pressScaleStyle}>
        <GlassView style={styles.container}>
          <TouchableRipple
            onPress={handlePress}
            onLongPress={onLongPress}
            style={{ flex: 1 }}
            accessibilityRole="button"
            accessibilityLabel={`${maskGroupText(expense.title, groupId, 'title')}, ${fmtMoney(expense.amount, currency)}, paid by ${payerName}`}
            accessibilityHint="Opens expense details"
            accessibilityActions={onDelete ? [{ name: 'delete', label: 'Delete expense' }] : undefined}
            onAccessibilityAction={({ nativeEvent: { actionName } }) => {
              if (actionName === 'delete') onDelete?.(expense);
            }}
            {...touchableProps}
          >
            <Animated.View style={[styles.content, isFlat && styles.contentFlat, pressHighlightStyle]}>
              <View style={styles.header}>
                <View style={styles.titleRow}>
                  <View style={[styles.iconContainer, { backgroundColor: theme.colors.primaryContainer }]}>
                    <Icon
                      source={getCategoryIcon(expense.category)}
                      size={18}
                      color={theme.colors.primary}
                    />
                  </View>
                  <View style={styles.copy}>
                    <Text variant="titleMedium" numberOfLines={2} style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>{maskGroupText(expense.title, groupId, 'title')}</Text>
                    <Text variant="bodySmall" numberOfLines={2} style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
                      {isSettlement
                        ? `Paid by ${payerName} · ${maskGroupText(expense.category, groupId, 'category')}`
                        : `Paid by ${payerName} · ${maskGroupText(expense.category, groupId, 'category')} · ${maskGroupText(splitLabel, groupId, 'note')}`}
                    </Text>
                  </View>
                </View>
                <View style={styles.amountContainer}>
                  <Text variant="titleMedium" numberOfLines={1} style={{ fontWeight: 'bold', color: theme.colors.onSurface, fontVariant: ['tabular-nums'] }}>
                    {fmtMoney(expense.amount, currency)}
                  </Text>
                  <Text variant="bodySmall" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
                    {maskGroupDate(expense.createdAt, groupId, (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}
                  </Text>
                </View>
              </View>
            </Animated.View>
          </TouchableRipple>
        </GlassView>
        </Animated.View>
      </Swipeable>
      <ListSeparator />
    </View>
  );
};

const styles = StyleSheet.create({
  /** Flat rows cancel the screen gutter so the highlight and the row's
   *  hairline reach both edges. The text stays inset via the row's own
   *  padding. See components/ui/layout. */
  bleed: {
    ...fullBleed,
  },
  glassGap: {
    marginBottom: 4,
  },
  container: {
    // borderRadius handled by Swipeable containerStyle
    flex: 1,
  },
  /** See SwipeableGroupCard.containerGlass — same x in both surface styles. */
  content: {
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  /** Flat: full-bleed, text inset by the row's own padding. */
  contentFlat: {
    paddingHorizontal: 24,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  titleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  iconContainer: {
    width: 34,
    height: 34,
    borderRadius: 17,
    justifyContent: 'center',
    alignItems: 'center',
  },
  subtitle: {
    // color handled dynamically
  },
  amountContainer: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginLeft: 12,
    gap: 2,
  },
  rightAction: {
    width: 120,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rightActionPressable: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteButtonPill: {
    width: 100,
    height: 56, // Horizontal pill shape
    borderRadius: 100,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  actionText: {
    fontSize: 13,
    fontWeight: 'bold',
    marginRight: 8,
  },
});
