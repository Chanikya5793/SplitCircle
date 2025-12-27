import { BalanceSummary } from '@/components/BalanceSummary';
import { DebtsList } from '@/components/DebtsList';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ExpenseCardSkeleton } from '@/components/SkeletonLoader';
import { SwipeableExpenseCard } from '@/components/SwipeableExpenseCard';
import { ROUTES } from '@/constants';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Expense, Group } from '@/models';
import { errorHaptic, lightHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, StyleSheet, View } from 'react-native';
import { Button, IconButton, Text } from 'react-native-paper';

interface GroupDetailsScreenProps {
  group: Group;
  onAddExpense: (group: Group) => void;
  onSettle: (group: Group) => void;
  onOpenChat: (group: Group) => void;
}

export const GroupDetailsScreen = ({ group, onAddExpense, onSettle, onOpenChat }: GroupDetailsScreenProps) => {
  const navigation = useNavigation<any>();
  const { deleteExpense, loading } = useGroups();
  const { theme, isDark } = useTheme();
  const scrollY = useRef(new Animated.Value(0)).current;
  const [isCompact, setIsCompact] = useState(false);

  const labelOpacity = scrollY.interpolate({
    inputRange: [0, 50],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  const iconButtonOpacity = scrollY.interpolate({
    inputRange: [50, 100],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
      headerTintColor: theme.colors.primary,
    });
  }, [navigation, theme.colors.primary]);

  const memberMap = useMemo(
    () => Object.fromEntries(group.members.map((m) => [m.userId, m.displayName])),
    [group.members]
  );

  const headerOpacity = scrollY.interpolate({
    inputRange: [40, 80],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const handleDeleteExpense = (expense: Expense) => {
    Alert.alert(
      'Delete Expense',
      `Are you sure you want to delete "${expense.title}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteExpense(group.groupId, expense.expenseId);
              errorHaptic();
            } catch (error) {
              console.error('Failed to delete expense:', error);
              Alert.alert('Error', 'Failed to delete expense');
            }
          },
        },
      ]
    );
  };

  return (
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]}>{group.name}</Text>
        </GlassView>
      </Animated.View>

      <Animated.ScrollView
        contentContainerStyle={styles.container}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { 
            useNativeDriver: true,
            listener: (event: any) => {
              const y = event.nativeEvent.contentOffset.y;
              setIsCompact(y > 50);
            }
          }
        )}
        scrollEventThrottle={16}
      >
        <View style={{ height: 70 }} />
        <GlassView style={styles.headerCard}>
          <View style={styles.header}>
            <Text variant="headlineMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>{group.name}</Text>
            <Text variant="bodyMedium" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
              Invite code: <Text style={{ fontWeight: 'bold', color: theme.colors.primary }}>{group.inviteCode}</Text>
            </Text>
          </View>

          <BalanceSummary group={group} />
        </GlassView>

        <DebtsList group={group} />

        <Text variant="titleMedium" style={[styles.section, { color: theme.colors.onSurface }]}>
          Recent expenses
        </Text>
        {loading ? (
          <View>
            <ExpenseCardSkeleton />
            <ExpenseCardSkeleton />
          </View>
        ) : group.expenses.length === 0 ? (
          <GlassView style={styles.emptyCard}>
            <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>No expenses yet.</Text>
          </GlassView>
        ) : (
          group.expenses.map((expense) => (
            <SwipeableExpenseCard
              key={expense.expenseId}
              expense={expense}
              currency={group.currency}
              memberMap={memberMap}
              onPress={() => {
                lightHaptic();
                navigation.navigate(ROUTES.APP.EXPENSE_DETAILS, { groupId: group.groupId, expenseId: expense.expenseId });
              }}
              onDelete={handleDeleteExpense}
            />
          ))
        )}

      </Animated.ScrollView>

      <View style={[styles.floatingActions, { height: isCompact ? 56 : 120 }]}>
        {/* Expanded buttons with labels - visible when not scrolled */}
        <Animated.View style={[styles.expandedContainer, { opacity: labelOpacity }]} pointerEvents={isCompact ? 'none' : 'auto'}>
          <View style={styles.buttonRow}>
            <Button mode="contained" onPress={() => onAddExpense(group)} style={styles.expandedButton} icon="plus">
              Add expense
            </Button>
            <Button mode="outlined" onPress={() => onSettle(group)} style={[styles.expandedButton, { borderColor: theme.colors.outline }]} icon="handshake">
              Settle up
            </Button>
          </View>
          <View style={styles.buttonRow}>
            <Button
              mode="outlined"
              icon="chart-pie"
              onPress={() => navigation.navigate(ROUTES.APP.GROUP_STATS, { groupId: group.groupId })}
              style={[styles.expandedButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.5)', borderColor: theme.colors.outline }]}
            >
              Stats
            </Button>
            <Button
              mode="outlined"
              icon="chat"
              onPress={() => onOpenChat(group)}
              style={[styles.expandedButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.5)', borderColor: theme.colors.outline }]}
            >
              Chat
            </Button>
          </View>
        </Animated.View>

        {/* Compact icon buttons - visible when scrolled */}
        <Animated.View style={[styles.compactContainer, { opacity: iconButtonOpacity }]} pointerEvents={isCompact ? 'auto' : 'none'}>
          <IconButton
            icon="plus"
            mode="contained"
            onPress={() => onAddExpense(group)}
            size={24}
            style={styles.iconButton}
          />
          <IconButton
            icon="handshake"
            mode="outlined"
            onPress={() => onSettle(group)}
            size={24}
            style={[styles.iconButton, { borderColor: theme.colors.outline }]}
          />
          <IconButton
            icon="chart-pie"
            mode="outlined"
            onPress={() => navigation.navigate(ROUTES.APP.GROUP_STATS, { groupId: group.groupId })}
            size={24}
            style={[styles.iconButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.5)', borderColor: theme.colors.outline }]}
          />
          <IconButton
            icon="chat"
            mode="outlined"
            onPress={() => onOpenChat(group)}
            size={24}
            style={[styles.iconButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.5)', borderColor: theme.colors.outline }]}
          />
        </Animated.View>
      </View>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 180,
    gap: 16,
  },
  headerCard: {
    padding: 16,
    borderRadius: 24,
  },
  header: {
    marginBottom: 12,
    alignItems: 'center',
  },
  subtitle: {
    marginTop: 4,
  },
  section: {
    marginTop: 8,
    marginBottom: 4,
    marginLeft: 8,
    fontWeight: 'bold',
  },
  emptyCard: {
    padding: 24,
    borderRadius: 16,
    alignItems: 'center',
  },
  empty: {
    // color handled dynamically
  },
  floatingActions: {
    position: 'absolute',
    bottom: 90,
    left: 16,
    right: 16,
  },
  expandedContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  expandedButton: {
    flex: 1,
  },
  compactContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'space-around',
    gap: 16,
  },
  iconButton: {
    flex: 1,
  },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickyHeaderGlass: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
  },
});
