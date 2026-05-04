import { BalanceSummary } from '@/components/BalanceSummary';
import { DebtsList } from '@/components/DebtsList';
import { ActivityTypeFilter, DateRange, FilterSortSheet, SortField, SortOrder } from '@/components/FilterSortSheet';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { SettlementCard } from '@/components/SettlementCard';
import { ExpenseCardSkeleton } from '@/components/SkeletonLoader';
import { SwipeableExpenseCard } from '@/components/SwipeableExpenseCard';
import { ROUTES } from '@/constants';
import { SCREEN_TITLES } from '@/navigation/screenTitles';
import { useGroups } from '@/context/GroupContext';
import { useTheme } from '@/context/ThemeContext';
import type { Expense, Group, Settlement } from '@/models';
import { syncRecurringBillsForGroupWithFallback } from '@/services/recurringBillService';
import { errorHaptic, lightHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { BlurView } from 'expo-blur';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, InteractionManager, Platform, StyleSheet, View } from 'react-native';
import { Icon, IconButton, Text, TouchableRipple } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface GroupDetailsScreenProps {
  group: Group;
  onAddExpense: (group: Group) => void;
  onSettle: (group: Group) => void;
  onOpenChat: (group: Group) => void;
  onCompactModeChange?: (isCompact: boolean) => void;
}

export const GroupDetailsScreen = ({ group, onAddExpense, onSettle, onOpenChat, onCompactModeChange }: GroupDetailsScreenProps) => {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { deleteExpense, deleteSettlement, loading } = useGroups();
  const { theme, isDark } = useTheme();
  const scrollY = useRef(new Animated.Value(0)).current;
  const compactStateRef = useRef(false);
  const lastScrollYRef = useRef(0);
  const scrollDirectionRef = useRef<'up' | 'down' | null>(null);
  const directionalTravelRef = useRef(0);
  // Discrete animated value: 0 = expanded, 1 = compact.
  // Driven by Animated.spring on threshold cross — NOT by scrollY interpolation,
  // so the bar never sits in a half-visible in-between state.
  const compactAnim = useRef(new Animated.Value(0)).current;
  // Stable ref so the scroll handler never captures a stale prop.
  const onCompactModeChangeRef = useRef(onCompactModeChange);
  onCompactModeChangeRef.current = onCompactModeChange;
  const [isCompact, setIsCompact] = useState(false);
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

  const compactEnterThreshold = Platform.OS === 'ios' ? 18 : 56;
  // Expand only when the user scrolls all the way back to the top.
  const compactExitThreshold = Platform.OS === 'ios' ? 6 : 20;
  const compactOnDownTravel = Platform.OS === 'ios' ? 12 : 22;
  const compactDockHeight = 56;
  const tabBarHeight = Platform.OS === 'ios'
    ? Math.max(78, 50 + insets.bottom)
    : Math.max(70, 56 + insets.bottom);
  const compactDockBottom = tabBarHeight + (Platform.OS === 'ios' ? 12 : 14);
  const expandedActionsBottom = compactDockBottom + compactDockHeight + 10;
  const contentBottomPadding = Platform.OS === 'android' ? expandedActionsBottom + 190 : tabBarHeight + 188;
  const expandedActionsAnchorBottom = Platform.OS === 'android' ? 8 : 0;

  // All bar animations are derived from compactAnim (0=expanded, 1=compact).
  // This means the bar jumps cleanly between states with spring physics
  // instead of continuously following the raw scroll position.
  const expandedOpacity = compactAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  const expandedTranslateY = compactAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 12],
    extrapolate: 'clamp',
  });

  const expandedScale = compactAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.97],
    extrapolate: 'clamp',
  });

  const compactDockOpacity = compactAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const compactDockTranslateY = compactAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [14, 0],
    extrapolate: 'clamp',
  });

  // Only notify parent on unmount to reset the accessory bar.
  // Compact-mode transitions are reported directly from the scroll handler
  // via onCompactModeChangeRef to avoid the useEffect render-chain.
  useEffect(() => {
    return () => {
      onCompactModeChangeRef.current?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
      headerTintColor: theme.colors.primary,
      headerRight: () => (
        <IconButton
          icon="information-outline"
          iconColor={theme.colors.primary}
          size={22}
          onPress={() => {
            lightHaptic();
            navigation.navigate(ROUTES.APP.GROUP_INFO, {
              groupId: group.groupId,
              initialTitle: SCREEN_TITLES.groupInfo,
              backTitle: group.name,
            });
          }}
          accessibilityLabel="Group info and admin"
          style={{ margin: 0 }}
        />
      ),
    });
  }, [navigation, theme.colors.primary, group?.groupId, group?.name]);

  // Defer the recurring bill sync until the navigation transition finishes.
  // This avoids heavy Firestore I/O on the JS thread during the slide-in animation.
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      syncRecurringBillsForGroupWithFallback(group.groupId).catch((error) => {
        console.warn('Recurring bill sync on group open failed:', error);
      });
    });
    return () => task.cancel();
  }, [group.groupId]);

  // Include archived members so removed/left users still resolve to their
  // real displayName in expense/settlement cards (instead of "Unknown").
  const memberMap = useMemo(
    () =>
      Object.fromEntries(
        [...(group.members ?? []), ...(group.archivedMembers ?? [])].map((m) => [
          m.userId,
          m.displayName,
        ]),
      ),
    [group.members, group.archivedMembers]
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
              const absoluteDelta = Math.abs(deltaY);
              lastScrollYRef.current = y;

              if (absoluteDelta < 0.5) {
                return;
              }

              const direction: 'up' | 'down' = deltaY > 0 ? 'down' : 'up';
              if (scrollDirectionRef.current !== direction) {
                scrollDirectionRef.current = direction;
                directionalTravelRef.current = 0;
              }
              directionalTravelRef.current += absoluteDelta;

              let shouldCompact = compactStateRef.current;
              if (y <= compactExitThreshold) {
                // Scrolled all the way back to top — restore expanded bar.
                shouldCompact = false;
                directionalTravelRef.current = 0;
              } else if (
                !compactStateRef.current &&
                direction === 'down' &&
                y > compactEnterThreshold &&
                directionalTravelRef.current >= compactOnDownTravel
              ) {
                shouldCompact = true;
                directionalTravelRef.current = 0;
              }
              // No mid-scroll upward expansion — bar stays compact until top.

              if (shouldCompact !== compactStateRef.current) {
                compactStateRef.current = shouldCompact;

                if (shouldCompact) {
                  // ── Collapsing: expanded → compact ──────────────────────────
                  // 1. Disable expanded bar touches immediately so nothing is
                  //    tappable while it fades out.
                  setIsCompact(true);
                  // 2. Animate the bar out first (fully completes on UI thread).
                  Animated.spring(compactAnim, {
                    toValue: 1,
                    useNativeDriver: true,
                    damping: 22,
                    mass: 0.65,
                    stiffness: 230,
                  }).start(({ finished }) => {
                    // 3. Only show the native accessory AFTER the expanded bar
                    //    is fully gone — no overlap possible.
                    if (finished) {
                      onCompactModeChangeRef.current?.(true);
                    }
                  });
                } else {
                  // ── Expanding: compact → expanded ────────────────────────────
                  // 1. Tell the native accessory to hide immediately so it starts
                  //    its own dismiss animation.
                  onCompactModeChangeRef.current?.(false);
                  // 2. Re-enable expanded bar touches right away.
                  setIsCompact(false);
                  // 3. Delay the fade-in by one animation frame so the native
                  //    accessory has begun disappearing before the expanded bar
                  //    becomes visible — eliminating the double-bar overlap.
                  Animated.sequence([
                    Animated.delay(60),
                    Animated.spring(compactAnim, {
                      toValue: 0,
                      useNativeDriver: true,
                      damping: 22,
                      mass: 0.65,
                      stiffness: 230,
                    }),
                  ]).start();
                }
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
                              expenseId: activity.data.expenseId,
                              expenseTitle: activity.data.title,
                              backTitle: group.name,
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

      <View style={[styles.floatingActions, Platform.OS === 'android' && styles.floatingActionsAndroid, { bottom: compactDockBottom }]}>
          {/* Expanded buttons - compact and appealing */}
          <Animated.View
            style={[
              styles.expandedContainer,
              {
                opacity: expandedOpacity,
                bottom: expandedActionsAnchorBottom,
                transform: [{ translateY: expandedTranslateY }, { scale: expandedScale }],
              },
            ]}
            pointerEvents={isCompact ? 'none' : 'auto'}
          >
            <View style={styles.actionGrid}>
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

            <View style={styles.actionGrid}>
              <TouchableRipple
                onPress={() => { lightHaptic(); navigation.navigate(ROUTES.APP.GROUP_STATS, { groupId: group.groupId, backTitle: group.name }); }}
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
                onPress={() => { lightHaptic(); navigation.navigate(ROUTES.APP.RECURRING_BILLS, { groupId: group.groupId, backTitle: group.name }); }}
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

          {Platform.OS === 'android' && (
            <Animated.View
              style={[
                styles.compactContainer,
                {
                  opacity: compactDockOpacity,
                  height: compactDockHeight,
                  transform: [{ translateY: compactDockTranslateY }],
                },
              ]}
              pointerEvents={isCompact ? 'auto' : 'none'}
            >
              <View style={[styles.androidDock, { backgroundColor: isDark ? 'rgba(18,22,30,0.96)' : 'rgba(252,252,255,0.98)', borderColor: isDark ? 'rgba(148,163,184,0.24)' : 'rgba(15,23,42,0.14)' }]}>
                <TouchableRipple onPress={() => onSettle(group)} style={[styles.androidDockButton, styles.androidPrimaryPill, { backgroundColor: '#10b981' }]} borderless>
                  <View style={styles.androidDockButtonInner}>
                    <Icon source="handshake" size={18} color="#fff" />
                    <Text variant="labelSmall" style={{ color: '#fff', fontWeight: '700' }}>Settle</Text>
                  </View>
                </TouchableRipple>
                <TouchableRipple onPress={() => navigation.navigate(ROUTES.APP.GROUP_STATS, { groupId: group.groupId, backTitle: group.name })} style={[styles.androidDockButton, styles.androidUtilityButton]} borderless>
                  <View style={styles.androidDockButtonInner}>
                    <Icon source="chart-pie" size={18} color={theme.colors.primary} />
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>Stats</Text>
                  </View>
                </TouchableRipple>
                <TouchableRipple onPress={() => onOpenChat(group)} style={[styles.androidDockButton, styles.androidUtilityButton]} borderless>
                  <View style={styles.androidDockButtonInner}>
                    <Icon source="chat" size={18} color={theme.colors.primary} />
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>Chat</Text>
                  </View>
                </TouchableRipple>
                <TouchableRipple onPress={() => navigation.navigate(ROUTES.APP.RECURRING_BILLS, { groupId: group.groupId, backTitle: group.name })} style={[styles.androidDockButton, styles.androidUtilityButton]} borderless>
                  <View style={styles.androidDockButtonInner}>
                    <Icon source="repeat" size={18} color={theme.colors.primary} />
                    <Text variant="labelSmall" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>Bills</Text>
                  </View>
                </TouchableRipple>
                <TouchableRipple onPress={() => onAddExpense(group)} style={[styles.androidDockButton, styles.androidPrimaryPill, { backgroundColor: theme.colors.primary }]} borderless>
                  <View style={styles.androidDockButtonInner}>
                    <Icon source="plus" size={18} color="#fff" />
                    <Text variant="labelSmall" style={{ color: '#fff', fontWeight: '700' }}>Add</Text>
                  </View>
                </TouchableRipple>
              </View>
            </Animated.View>
          )}
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
    left: 16,
    right: 16,
    zIndex: 25,
  },
  floatingActionsAndroid: {
    left: 14,
    right: 14,
  },
  expandedContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    gap: 8,
    paddingHorizontal: 6,
  },
  actionGrid: {
    flexDirection: 'row',
    gap: 12,
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
    borderRadius: 50,
    left: 0,
    right: 0,
    bottom: 15, //modify if needed based on actual tab bar height from bottom padding of scrollview
    justifyContent: 'center',
  },
  androidDock: {
    borderRadius: 50,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
    gap: 10,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
  },
  androidDockButton: {
    flex: 1,
    borderRadius: 50,
    overflow: 'hidden',
  },
  androidUtilityButton: {
    flex: 0.95,
  },
  androidPrimaryPill: {
    flex: 1.25,
  },
  androidDockButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 10,
    paddingHorizontal: 12,
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
