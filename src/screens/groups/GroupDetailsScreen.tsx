import { BalanceSummary } from '@/components/BalanceSummary';
import { ExpenseCard } from '@/components/ExpenseCard';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { ROUTES } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import { useNavigation } from '@react-navigation/native';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Animated, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-paper';

interface GroupDetailsScreenProps {
  group: Group;
  onAddExpense: (group: Group) => void;
  onSettle: (group: Group) => void;
  onOpenChat: (group: Group) => void;
}

export const GroupDetailsScreen = ({ group, onAddExpense, onSettle, onOpenChat }: GroupDetailsScreenProps) => {
  const navigation = useNavigation<any>();
  const { theme, isDark } = useTheme();
  const scrollY = useRef(new Animated.Value(0)).current;

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

  return (
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={[styles.stickyHeaderGlass, { backgroundColor: isDark ? 'rgba(30, 30, 30, 0.8)' : 'rgba(255, 255, 255, 0.8)' }]}>
          <Text variant="titleMedium" style={[styles.stickyHeaderTitle, { color: theme.colors.onSurface }]}>{group.name}</Text>
        </GlassView>
      </Animated.View>

      <ScrollView
        contentContainerStyle={styles.container}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: false }
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

        <Text variant="titleMedium" style={[styles.section, { color: theme.colors.onSurface }]}>
          Recent expenses
        </Text>
        {group.expenses.length === 0 ? (
          <GlassView style={styles.emptyCard}>
            <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>No expenses yet.</Text>
          </GlassView>
        ) : (
          group.expenses.map((expense) => (
            <ExpenseCard
              key={expense.expenseId}
              expense={expense}
              currency={group.currency}
              memberMap={memberMap}
              onPress={() => navigation.navigate(ROUTES.APP.EXPENSE_DETAILS, { groupId: group.groupId, expenseId: expense.expenseId })}
            />
          ))
        )}

        <View style={styles.actions}>
          <Button mode="contained" onPress={() => onAddExpense(group)} style={{ flex: 1 }}>
            Add expense
          </Button>
          <Button mode="outlined" onPress={() => onSettle(group)} style={{ flex: 1, borderColor: theme.colors.outline }}>
            Settle up
          </Button>
        </View>
        <View style={styles.secondaryActions}>
          <Button
            mode="outlined"
            icon="chart-pie"
            onPress={() => navigation.navigate(ROUTES.APP.GROUP_STATS, { groupId: group.groupId })}
            style={[styles.secondaryButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.5)', borderColor: theme.colors.outline }]}
          >
            Stats
          </Button>
          <Button
            mode="outlined"
            icon="chat"
            onPress={() => onOpenChat(group)}
            style={[styles.secondaryButton, { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.5)', borderColor: theme.colors.outline }]}
          >
            Chat
          </Button>
        </View>
      </ScrollView>
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
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    gap: 12,
  },
  secondaryActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  secondaryButton: {
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
