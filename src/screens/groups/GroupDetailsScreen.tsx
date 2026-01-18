import { BalanceSummary } from '@/components/BalanceSummary';
import { DebtsList } from '@/components/DebtsList';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ExpenseCardSkeleton } from '@/components/SkeletonLoader';
import { SwipeableExpenseCard } from '@/components/SwipeableExpenseCard';
import { SettlementCard } from '@/components/SettlementCard';
import { FilterSortSheet, SortField, SortOrder, ActivityTypeFilter, DateRange } from '@/components/FilterSortSheet';
import { ROUTES } from '@/constants';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Expense, Group, Settlement } from '@/models';
import { errorHaptic, lightHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, StyleSheet, View } from 'react-native';
import {
  withSequence,
  withTiming
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import { Text, TouchableRipple, Button, IconButton } from 'react-native-paper';

interface GroupDetailsScreenProps {
  group: Group;
  onAddExpense: (group: Group) => void;
  onSettle: (group: Group) => void;
  onOpenChat: (group: Group) => void;
}

export const GroupDetailsScreen = ({ group, onAddExpense, onSettle, onOpenChat }: GroupDetailsScreenProps) => {
  const navigation = useNavigation<any>();
  const { deleteExpense, deleteSettlement, loading } = useGroups();
  const { theme, isDark } = useTheme();
  const scrollY = useRef(new Animated.Value(0)).current;
  const [isCompact, setIsCompact] = useState(false);
  const [showFilterSheet, setShowFilterSheet] = useState(false);
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [activityType, setActivityType] = useState<ActivityTypeFilter>('all');
  const [dateRange, setDateRange] = useState<DateRange>('all');

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

  const handleDeleteSettlement = (settlement: Settlement) => {
    Alert.alert(
      'Delete Settlement',
      `Are you sure you want to delete this settlement?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteSettlement(group.groupId, settlement.settlementId);
              errorHaptic();
            } catch (error) {
              console.error('Failed to delete settlement:', error);
              Alert.alert('Error', 'Failed to delete settlement');
            }
          },
        },
      ]
    );
  };

  const handleEditSettlement = (settlement: Settlement) => {
    // Navigate to settlements screen in edit mode
    navigation.navigate(ROUTES.APP.SETTLEMENTS, {
      groupId: group.groupId,
      settlementId: settlement.settlementId
    });
  };

  // Helper functions for sorting
  const getSortKey = (expense: Expense): number | string => {
    switch (sortField) {
      case 'date':
        return expense.createdAt;
      case 'amount':
        return expense.amount;
      case 'title':
        return expense.title.toLowerCase();
      default:
        return expense.createdAt;
    }
  };

  const getSettlementSortKey = (settlement: Settlement): number | string => {
    switch (sortField) {
      case 'date':
        return settlement.createdAt;
      case 'amount':
        return settlement.amount;
      case 'title':
        return 'settlement'; // Group all settlements together when sorting by title
      default:
        return settlement.createdAt;
    }
  };

  const handleCategoryToggle = (category: string) => {
    if (category === 'all') {
      setSelectedCategories([]);
    } else {
      setSelectedCategories(prev =>
        prev.includes(category)
          ? prev.filter(c => c !== category)
          : [...prev, category]
      );
    }
  };

  // Check date range helper
  const checkDateRange = (dateString: string | number) => {
    if (dateRange === 'all') return true;

    const timestamp = typeof dateString === 'string' ? new Date(dateString).getTime() : dateString;
    const date = new Date(timestamp);
    const now = new Date();

    // Clear time part for accurate date comparison
    date.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    const startOf3MonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1);

    switch (dateRange) {
      case 'this-month':
        return date >= startOfMonth;
      case 'last-month':
        return date >= startOfLastMonth && date <= endOfLastMonth;
      case 'last-3-months':
        return date >= startOf3MonthsAgo;
      default:
        return true;
    }
  };

  // Combined activity list (expenses + settlements) with filtering
  type ActivityItem =
    | { type: 'expense'; data: Expense; sortKey: number | string }
    | { type: 'settlement'; data: Settlement; sortKey: number | string };

  const sortedActivities = useMemo(() => {
    // Filter expenses by category
    const filteredExpenses = selectedCategories.length === 0
      ? group.expenses
      : group.expenses.filter(exp => selectedCategories.includes(exp.category.toLowerCase()));

    // Filter by date range
    const dateFilteredExpenses = filteredExpenses.filter(exp => checkDateRange(exp.createdAt));
    const dateFilteredSettlements = group.settlements.filter(set => checkDateRange(set.createdAt));

    // Build activity list based on activity type filter
    let activities: ActivityItem[] = [];
    if (activityType === 'all' || activityType === 'expenses') {
      activities = [
        ...activities,
        ...dateFilteredExpenses.map(exp => ({
          type: 'expense' as const,
          data: exp,
          sortKey: getSortKey(exp),
        })),
      ];
    }
    if (activityType === 'all' || activityType === 'settlements') {
      activities = [
        ...activities,
        ...dateFilteredSettlements.map(set => ({
          type: 'settlement' as const,
          data: set,
          sortKey: getSettlementSortKey(set),
        })),
      ];
    }

    // Sort activities
    return activities.sort((a, b) => {
      if (typeof a.sortKey === 'number' && typeof b.sortKey === 'number') {
        return sortOrder === 'desc' ? b.sortKey - a.sortKey : a.sortKey - b.sortKey;
      }
      if (typeof a.sortKey === 'string' && typeof b.sortKey === 'string') {
        return sortOrder === 'desc' ? b.sortKey.localeCompare(a.sortKey) : a.sortKey.localeCompare(b.sortKey);
      }
      return 0;
    });
  }, [group.expenses, group.settlements, sortField, sortOrder, selectedCategories, activityType, dateRange]);

  const handleClearFilters = () => {
    setSelectedCategories([]);
    setActivityType('all');
    setDateRange('all');
    lightHaptic();
  };

  const activeFilters = selectedCategories.length + (activityType !== 'all' ? 1 : 0) + (dateRange !== 'all' ? 1 : 0);


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
        <View style={{ height: 40 }} />
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

        <View style={styles.sectionHeader}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurfaceVariant, fontWeight: '600', paddingHorizontal: 4, flex: 1 }}>
            Recent activity
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {activeFilters > 0 && (
              <TouchableRipple
                onPress={handleClearFilters}
                style={[styles.filterButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }]}
              >
                <View style={[styles.filterButtonContent, { paddingHorizontal: 12 }]}>
                  <IconButton icon="close" size={16} iconColor={theme.colors.onSurfaceVariant} style={{ margin: 0 }} />
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, fontWeight: '600' }}>
                    Clear
                  </Text>
                </View>
              </TouchableRipple>
            )}
            <TouchableRipple
              onPress={() => setShowFilterSheet(true)}
              style={[styles.filterButton, { backgroundColor: activeFilters > 0 ? theme.colors.primaryContainer : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)') }]}
            >
              <View style={styles.filterButtonContent}>
                <IconButton icon="filter-variant" size={16} iconColor={activeFilters > 0 ? theme.colors.primary : theme.colors.onSurfaceVariant} style={{ margin: 0 }} />
                <Text variant="labelMedium" style={{ color: activeFilters > 0 ? theme.colors.primary : theme.colors.onSurfaceVariant, fontWeight: '600' }}>
                  Filters
                </Text>
                {activeFilters > 0 && (
                  <View style={[styles.filterBadge, { backgroundColor: theme.colors.primary }]}>
                    <Text variant="labelSmall" style={{ color: '#fff', fontSize: 10, fontWeight: 'bold' }}>
                      {activeFilters}
                    </Text>
                  </View>
                )}
              </View>
            </TouchableRipple>
          </View>
        </View>

        {loading ? (
          <View>
            <ExpenseCardSkeleton />
            <ExpenseCardSkeleton />
          </View>
        ) : sortedActivities.length === 0 ? (
          <GlassView style={styles.emptyCard}>
            <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>No activity yet.</Text>
          </GlassView>
        ) : (
          sortedActivities.map((activity, index) => {
            if (activity.type === 'expense') {
              return (
                <SwipeableExpenseCard
                  key={`expense-${activity.data.expenseId}`}
                  expense={activity.data}
                  currency={group.currency}
                  memberMap={memberMap}
                  index={index}
                  onPress={() => {
                    lightHaptic();
                    navigation.navigate(ROUTES.APP.EXPENSE_DETAILS, {
                      groupId: group.groupId,
                      expenseId: activity.data.expenseId
                    });
                  }}
                  onDelete={handleDeleteExpense}
                />
              );
            } else {
              return (
                <SettlementCard
                  key={`settlement-${activity.data.settlementId}`}
                  settlement={activity.data}
                  currency={group.currency}
                  memberMap={memberMap}
                  index={index}
                  onPress={() => handleEditSettlement(activity.data)}
                  onDelete={handleDeleteSettlement}
                />
              );
            }
          })
        )}

      </Animated.ScrollView>

      <View style={[styles.floatingActions, { height: isCompact ? 56 : 80 }]}>
        {/* Expanded buttons - compact and appealing */}
        <Animated.View style={[styles.expandedContainer, { opacity: labelOpacity }]} pointerEvents={isCompact ? 'none' : 'auto'}>
          <View style={styles.actionGrid}>
            {/* Primary row */}
            <TouchableRipple
              onPress={() => { lightHaptic(); onSettle(group); }}
              style={styles.compactButton}
              borderless
            >
              <View style={[styles.compactButtonInner, { backgroundColor: '#10b981' }]}>
                <IconButton icon="handshake" size={20} iconColor="#fff" style={{ margin: 0 }} />
                <Text variant="labelLarge" style={{ color: '#fff', fontWeight: '600' }}>Settle Up</Text>
              </View>
            </TouchableRipple>

            <TouchableRipple
              onPress={() => { lightHaptic(); onAddExpense(group); }}
              style={styles.compactButton}
              borderless
            >
              <View style={[styles.compactButtonInner, { backgroundColor: theme.colors.primary }]}>
                <IconButton icon="plus" size={20} iconColor="#fff" style={{ margin: 0 }} />
                <Text variant="labelLarge" style={{ color: '#fff', fontWeight: '600' }}>Add Expense</Text>
              </View>
            </TouchableRipple>
          </View>

          {/* Secondary row */}
          <View style={styles.actionGrid}>
            <TouchableRipple
              onPress={() => { lightHaptic(); navigation.navigate(ROUTES.APP.GROUP_STATS, { groupId: group.groupId }); }}
              style={styles.compactButtonSmall}
              borderless
            >
              <View style={{ flex: 1 }}>
                <BlurView intensity={20} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
                <View style={[styles.compactButtonSmallInner, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.4)' }]}>
                  <IconButton icon="chart-pie" size={18} iconColor={theme.colors.primary} style={{ margin: 0 }} />
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>Stats</Text>
                </View>
              </View>
            </TouchableRipple>

            <TouchableRipple
              onPress={() => { lightHaptic(); onOpenChat(group); }}
              style={styles.compactButtonSmall}
              borderless
            >
              <View style={{ flex: 1 }}>
                <BlurView intensity={20} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
                <View style={[styles.compactButtonSmallInner, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.4)' }]}>
                  <IconButton icon="chat" size={18} iconColor={theme.colors.primary} style={{ margin: 0 }} />
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>Chat</Text>
                </View>
              </View>
            </TouchableRipple>

            <TouchableRipple
              onPress={() => { lightHaptic(); navigation.navigate(ROUTES.APP.RECURRING_BILLS, { groupId: group.groupId }); }}
              style={styles.compactButtonSmall}
              borderless
            >
              <View style={{ flex: 1 }}>
                <BlurView intensity={20} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
                <View style={[styles.compactButtonSmallInner, { backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.4)' }]}>
                  <IconButton icon="repeat" size={18} iconColor={theme.colors.primary} style={{ margin: 0 }} />
                  <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>Bills</Text>
                </View>
              </View>
            </TouchableRipple>
          </View>

        </Animated.View>

        {/* Compact icon buttons - visible when scrolled */}
        <Animated.View style={[styles.compactContainer, { opacity: iconButtonOpacity }]} pointerEvents={isCompact ? 'auto' : 'none'}>
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
          <IconButton
            icon="repeat"
            mode="outlined"
            onPress={() => navigation.navigate(ROUTES.APP.RECURRING_BILLS, { groupId: group.groupId })}
            size={24}
            style={[styles.iconButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.5)', borderColor: theme.colors.outline }]}
          />
          <IconButton
            icon="plus"
            mode="contained"
            onPress={() => onAddExpense(group)}
            size={24}
            style={styles.iconButton}
          />
        </Animated.View>
      </View>

      <FilterSortSheet
        visible={showFilterSheet}
        onClose={() => setShowFilterSheet(false)}
        sortField={sortField}
        sortOrder={sortOrder}
        selectedCategories={selectedCategories}
        activityType={activityType}
        dateRange={dateRange}
        onSortFieldChange={setSortField}
        onSortOrderChange={setSortOrder}
        onCategoryToggle={handleCategoryToggle}
        onActivityTypeChange={setActivityType}
        onDateRangeChange={setDateRange}
      />
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 8,
    paddingBottom: 180,
    gap: 8,
  },
  headerCard: {
    padding: 10,
    borderRadius: 16,
  },
  header: {
    marginBottom: 6,
    alignItems: 'center',
  },
  subtitle: {
    marginTop: 4,
  },
  section: {
    marginTop: 4,
    marginBottom: 4,
    marginLeft: 8,
    fontWeight: 'bold',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    marginBottom: 4,
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
    gap: 8,
    paddingHorizontal: 4,
  },
  actionGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  compactButton: {
    flex: 1,
    borderRadius: 50,
    overflow: 'hidden',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 3,
  },
  compactButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    gap: 4,
  },
  compactButtonSmall: {
    flex: 1,
    borderRadius: 50,
    overflow: 'hidden',
  },
  compactButtonSmallInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    paddingHorizontal: 6,
    gap: 2,
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
  filterButton: {
    borderRadius: 50,
    overflow: 'hidden',
  },
  filterButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
    gap: 4,
  },
  filterBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
});

