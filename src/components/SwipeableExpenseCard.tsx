import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
import type { Expense } from '@/models';
import { formatCurrency } from '@/utils/currency';
import { errorHaptic, lightHaptic } from '@/utils/haptics';
import React, { useRef } from 'react';
import { Animated as RNAnimated, StyleSheet, View } from 'react-native';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { IconButton, Text, TouchableRipple } from 'react-native-paper';
import Animated, { FadeInDown } from 'react-native-reanimated';

interface SwipeableExpenseCardProps {
  expense: Expense;
  currency: string;
  memberMap: Record<string, string>;
  onPress: () => void;
  onDelete?: (expense: Expense) => void;
  index?: number;
}

export const SwipeableExpenseCard = ({
  expense,
  currency,
  memberMap,
  onPress,
  onDelete,
  index = 0,
}: SwipeableExpenseCardProps) => {
  const { theme } = useTheme();
  const swipeableRef = useRef<Swipeable>(null);
  const payerName = memberMap[expense.paidBy] || 'Unknown';
  const isSettlement = expense.category === 'Settlement';

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
          onPress={() => {
            errorHaptic();
            swipeableRef.current?.close();
            onDelete?.(expense);
          }}
        >
          <View style={styles.deleteButtonPill}>
            <IconButton icon="delete" iconColor="#fff" size={24} style={{ margin: 0 }} />
            <Text style={styles.actionText}>Delete</Text>
          </View>
        </RectButton>
      </RNAnimated.View>
    );
  };

  return (
    <Animated.View entering={FadeInDown.delay(index * 50).springify()} style={{ marginBottom: 12, marginHorizontal: 4 }}>
      <Swipeable
        ref={swipeableRef}
        renderRightActions={onDelete ? renderRightActions : undefined}
        friction={2}
        rightThreshold={40}
        overshootRight={false}
        containerStyle={{ borderRadius: 24, overflow: 'hidden' }}
      >
        <GlassView style={styles.container}>
          <TouchableRipple onPress={handlePress} style={{ flex: 1 }}>
            <View style={styles.content}>
              <View style={styles.header}>
                <View style={styles.titleRow}>
                  <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>{expense.title}</Text>
                  <Text variant="bodySmall" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
                    {expense.category} · Paid by {payerName}
                  </Text>
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    {new Date(expense.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                <View style={styles.amountContainer}>
                  <Text variant="titleLarge" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
                    {formatCurrency(expense.amount, currency)}
                  </Text>
                  {isSettlement && <IconButton icon="check-circle" size={20} iconColor={theme.colors.primary} />}
                </View>
              </View>
            </View>
          </TouchableRipple>
        </GlassView>
      </Swipeable>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    // borderRadius handled by Swipeable containerStyle
    flex: 1,
  },
  content: {
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  titleRow: {
    flex: 1,
    gap: 4,
  },
  subtitle: {
    // color handled dynamically
  },
  amountContainer: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginLeft: 16,
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
    backgroundColor: '#ff6b6b', // Liquid Background 'debts' red
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
    color: '#fff',
    fontSize: 13,
    fontWeight: 'bold',
    marginRight: 8,
  },
});
