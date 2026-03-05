import { BalanceSummary } from '@/components/BalanceSummary';
import { DebtsList } from '@/components/DebtsList';
import { ActivityTypeFilter, DateRange, FilterSortSheet, SortField, SortOrder } from '@/components/FilterSortSheet';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { SettlementCard } from '@/components/SettlementCard';
import { ExpenseCardSkeleton } from '@/components/SkeletonLoader';
import { SwipeableExpenseCard } from '@/components/SwipeableExpenseCard';
import { ROUTES } from '@/constants';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Expense, Group, Settlement } from '@/models';
import { errorHaptic, lightHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Platform, StyleSheet, View } from 'react-native';
import { Icon, IconButton, Text, TouchableRipple } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface GroupDetailsScreenProps {
  group: Group;
  onAddExpense: (group: Group) => void;
  onSettle: (group: Group) => void;
  onOpenChat: (group: Group) => void;
  compactAnim?: Animated.Value;
}

export const GroupDetailsScreen = ({ group, onAddExpense, onSettle, onOpenChat, compactAnim: compactAnimProp }: GroupDetailsScreenProps) => {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { deleteExpense, deleteSettlement, loading } = useGroups();
  const { theme, isDark } = useTheme();
  const scrollY = useRef(new Animated.Value(0)).current;
  const compactStateRef = useRef(false);
  const lastScrollYRef = useRef(0);
  const scrollDirectionRef = useRef<'up' | 'down' | null>(null);
  const directionalTravelRef = useRef(0);
  const compactAnimRef = useRef(compactAnimProp);
  compactAnimRef.current = compactAnimProp;
  const [showFilterSheet, setShowFilterSheet] = useState(false);
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [activityType, setActivityType] = useState<ActivityTypeFilter>('all');
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [collapsedYears, setCollapsedYears] = useState<Set<number>>(new Set());
  const [collapsedMonths, setCollapsedMonths] = useState<Set<string>>(new Set());

  const toggleYear = (year: number) => {
    setCollapsedYears(prev => {
      const newSet = new Set(prev);
      if (newSet.has(year)) {
        newSet.delete(year);
      } else {
        newSet.add(year);
      }
      return newSet;
    });
    lightHaptic();
  };

  const toggleMonth = (monthKey: string) => {
    setCollapsedMonths(prev => {
      const newSet = new Set(prev);
      if (newSet.has(monthKey)) {
        newSet.delete(monthKey);
      } else {
        newSet.add(monthKey);
      }
      return newSet;
    });
    lightHaptic();
  };

  const tabBarHeight = Platform.OS === 'ios'
    ? Math.max(78, 50 + insets.bottom)
    : Math.max(70, 56 + insets.bottom);
  const contentBottomPadding = tabBarHeight + 180;

  // Reset compactAnim to expanded when unmounting.
  useEffect(() => {
    return () => {
      compactAnimRef.current?.setValue(0);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    inputRange: [90, 130],
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

  // Group activities by year, then by month
  type MonthSection = {
    monthKey: string;
    monthLabel: string;
    items: ActivityItem[];
  };

  type YearSection = {
    year: number;
    yearLabel: string;
    months: MonthSection[];
    totalItems: number;
  };

  const yearGroupedActivities = useMemo(() => {
    const yearMap: Record<number, Record<string, ActivityItem[]>> = {};

    sortedActivities.forEach(activity => {
      const timestamp = activity.type === 'expense' ? activity.data.createdAt : activity.data.createdAt;
      const date = new Date(timestamp);
      const year = date.getFullYear();
      const monthKey = `${year}-${String(date.getMonth() + 1).padStart(2, '0')}`;

      if (!yearMap[year]) {
        yearMap[year] = {};
      }
      if (!yearMap[year][monthKey]) {
        yearMap[year][monthKey] = [];
      }
      yearMap[year][monthKey].push(activity);
    });

    const now = new Date();

    // Convert to array structure
    const years: YearSection[] = Object.entries(yearMap).map(([yearStr, months]) => {
      const year = Number(yearStr);
      const yearLabel = year === now.getFullYear() ? 'This Year' : String(year);

      const monthSections: MonthSection[] = Object.entries(months).map(([monthKey, items]) => {
        const [yr, mo] = monthKey.split('-').map(Number);
        const date = new Date(yr, mo - 1);

        let monthLabel: string;
        if (date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()) {
          monthLabel = 'This Month';
        } else if (
          (date.getMonth() === now.getMonth() - 1 && date.getFullYear() === now.getFullYear()) ||
          (now.getMonth() === 0 && date.getMonth() === 11 && date.getFullYear() === now.getFullYear() - 1)
        ) {
          monthLabel = 'Last Month';
        } else {
          monthLabel = date.toLocaleDateString('en-US', { month: 'long' });
        }

        return { monthKey, monthLabel, items };
      });

      // Sort months within year
      monthSections.sort((a, b) => {
        const comparison = b.monthKey.localeCompare(a.monthKey);
        return sortOrder === 'desc' ? comparison : -comparison;
      });

      const totalItems = monthSections.reduce((sum, m) => sum + m.items.length, 0);

      return { year, yearLabel, months: monthSections, totalItems };
    });

    // Sort years
    years.sort((a, b) => sortOrder === 'desc' ? b.year - a.year : a.year - b.year);

    return years;
  }, [sortedActivities, sortOrder]);

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
        contentContainerStyle={[styles.container, { paddingBottom: contentBottomPadding }]}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          {
            useNativeDriver: true,
            listener: (event: any) => {
              const y = event.nativeEvent.contentOffset.y;
              const prevY = lastScrollYRef.current;
              const deltaY = y - prevY;
              const absDelta = Math.abs(deltaY);
              lastScrollYRef.current = y;

              if (absDelta < 0.5) return;

              const dir: 'up' | 'down' = deltaY > 0 ? 'down' : 'up';
              if (scrollDirectionRef.current !== dir) {
                scrollDirectionRef.current = dir;
                directionalTravelRef.current = 0;
              }
              directionalTravelRef.current += absDelta;

              let shouldCompact = compactStateRef.current;
              if (y <= 6) {
                shouldCompact = false;
                directionalTravelRef.current = 0;
              } else if (
                !compactStateRef.current &&
                dir === 'down' &&
                y > 18 &&
                directionalTravelRef.current >= 12
              ) {
                shouldCompact = true;
                directionalTravelRef.current = 0;
              }

              if (shouldCompact !== compactStateRef.current) {
                compactStateRef.current = shouldCompact;
                Animated.spring(compactAnimRef.current!, {
                  toValue: shouldCompact ? 1 : 0,
                  useNativeDriver: true,
                  damping: 28,
                  mass: 0.4,
                  stiffness: 380,
                }).start();
              }
            }
          }
        )}
        scrollEventThrottle={16}
      >
        <View style={{ height: 110 }} />
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
          yearGroupedActivities.map((yearSection, yearIndex) => (
            <View key={yearSection.year}>
              {/* Collapsed Year Header (only show when year IS collapsed) */}
              {collapsedYears.has(yearSection.year) && (
                <TouchableRipple onPress={() => toggleYear(yearSection.year)} style={styles.yearHeaderCompact} borderless>
                  <View style={styles.collapsibleHeader}>
                    <Icon source="chevron-right" size={16} color={theme.colors.onSurface} />
                    <Text variant="labelMedium" style={{ color: theme.colors.onSurface, fontWeight: 'bold' }}>
                      {yearSection.yearLabel}
                    </Text>
                    <Text variant="labelSmall" style={{ color: theme.colors.outline }}>
                      · {yearSection.totalItems} item{yearSection.totalItems !== 1 ? 's' : ''}
                    </Text>
                  </View>
                </TouchableRipple>
              )}

              {/* Months (hidden if year is collapsed) */}
              {!collapsedYears.has(yearSection.year) && yearSection.months.map((monthSection, monthIndex) => (
                <View key={monthSection.monthKey}>
                  {/* Combined Header Row: Month on LEFT, Year on RIGHT */}
                  <View style={styles.combinedHeaderRow}>
                    {/* Month (Left side) */}
                    <TouchableRipple onPress={() => toggleMonth(monthSection.monthKey)} style={styles.monthHeaderCompact} borderless>
                      <View style={styles.collapsibleHeader}>
                        <IconButton
                          icon={collapsedMonths.has(monthSection.monthKey) ? 'chevron-right' : 'chevron-down'}
                          size={16}
                          iconColor={theme.colors.onSurfaceVariant}
                          style={{ margin: 0 }}
                        />
                        <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, fontWeight: '600' }}>
                          {monthSection.monthLabel}
                        </Text>
                        <Text variant="labelSmall" style={{ color: theme.colors.outline }}>
                          · {monthSection.items.length}
                        </Text>
                      </View>
                    </TouchableRipple>

                    {/* Year (Right side) - only show on first month of each year or if multiple years */}
                    {(monthIndex === 0 && (yearGroupedActivities.length > 1 || yearSection.yearLabel !== 'This Year')) && (
                      <TouchableRipple onPress={() => toggleYear(yearSection.year)} style={styles.yearHeaderCompact} borderless>
                        <View style={styles.collapsibleHeader}>
                          <Text variant="labelSmall" style={{ color: theme.colors.outline }}>
                            {yearSection.yearLabel} · {yearSection.totalItems}
                          </Text>
                          <IconButton
                            icon={collapsedYears.has(yearSection.year) ? 'chevron-right' : 'chevron-down'}
                            size={16}
                            iconColor={theme.colors.onSurfaceVariant}
                            style={{ margin: 0 }}
                          />
                        </View>
                      </TouchableRipple>
                    )}
                  </View>

                  {/* Items (hidden if month is collapsed) */}
                  {!collapsedMonths.has(monthSection.monthKey) && monthSection.items.map((activity, index) => {
                    if (activity.type === 'expense') {
                      return (
                        <SwipeableExpenseCard
                          key={`expense-${activity.data.expenseId}`}
                          expense={activity.data}
                          currency={group.currency}
                          memberMap={memberMap}
                          index={yearIndex * 100 + monthIndex * 10 + index}
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
                          index={yearIndex * 100 + monthIndex * 10 + index}
                          onPress={() => handleEditSettlement(activity.data)}
                          onDelete={handleDeleteSettlement}
                        />
                      );
                    }
                  })}
                </View>
              ))}
            </View>
          ))
        )}

      </Animated.ScrollView>

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
  monthHeader: {
    paddingHorizontal: 4,
    paddingTop: 4,
    paddingBottom: 2,
    borderRadius: 50,
  },
  yearHeader: {
    paddingHorizontal: 4,
    paddingTop: 12,
    paddingBottom: 4,
    borderRadius: 50,
  },
  combinedHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 2,
    paddingBottom: 2,
    paddingHorizontal: 4,
  },
  monthHeaderCompact: {
    borderRadius: 50,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  yearHeaderCompact: {
    borderRadius: 50,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  collapsibleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
});
