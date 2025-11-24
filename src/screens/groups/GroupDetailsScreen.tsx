import { BalanceSummary } from '@/components/BalanceSummary';
import { ExpenseCard } from '@/components/ExpenseCard';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { colors, ROUTES } from '@/constants';
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
  const scrollY = useRef(new Animated.Value(0)).current;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: '',
      headerTransparent: true,
      headerTintColor: colors.primary, // Ensure back button is visible/colored
    });
  }, [navigation]);

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
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={styles.stickyHeaderTitle}>{group.name}</Text>
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
            <Text variant="headlineMedium" style={{ fontWeight: 'bold' }}>{group.name}</Text>
            <Text variant="bodyMedium" style={styles.subtitle}>
              Invite code: <Text style={{ fontWeight: 'bold', color: '#6750A4' }}>{group.inviteCode}</Text>
            </Text>
          </View>

          <BalanceSummary group={group} />
        </GlassView>

        <Text variant="titleMedium" style={styles.section}>
          Recent expenses
        </Text>
        {group.expenses.length === 0 ? (
          <GlassView style={styles.emptyCard}>
            <Text style={styles.empty}>No expenses yet.</Text>
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
          <Button mode="outlined" onPress={() => onSettle(group)} style={{ flex: 1 }}>
            Settle up
          </Button>
        </View>
        <View style={styles.secondaryActions}>
          <Button 
            mode="outlined" 
            icon="chart-pie" 
            onPress={() => navigation.navigate(ROUTES.APP.GROUP_STATS, { groupId: group.groupId })}
            style={styles.secondaryButton}
          >
            Stats
          </Button>
          <Button 
            mode="outlined" 
            icon="chat" 
            onPress={() => onOpenChat(group)} 
            style={styles.secondaryButton}
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
    color: colors.muted,
    marginTop: 4,
  },
  section: {
    marginTop: 8,
    marginBottom: 4,
    marginLeft: 8,
    fontWeight: 'bold',
    color: '#333',
  },
  emptyCard: {
    padding: 24,
    borderRadius: 16,
    alignItems: 'center',
  },
  empty: {
    color: colors.muted,
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
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingTop: 50, // Adjust for status bar/header area
    paddingHorizontal: 16,
    paddingBottom: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickyHeaderGlass: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
  },
  stickyHeaderTitle: {
    fontWeight: 'bold',
    color: '#333',
  },
});
