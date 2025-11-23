import { BalanceSummary } from '@/components/BalanceSummary';
import { ExpenseCard } from '@/components/ExpenseCard';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { colors, ROUTES } from '@/constants';
import type { Group } from '@/models';
import { useNavigation } from '@react-navigation/native';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-paper';

interface GroupDetailsScreenProps {
  group: Group;
  onAddExpense: (group: Group) => void;
  onSettle: (group: Group) => void;
  onOpenChat: (group: Group) => void;
}

export const GroupDetailsScreen = ({ group, onAddExpense, onSettle, onOpenChat }: GroupDetailsScreenProps) => {
  const navigation = useNavigation<any>();
  const memberMap = useMemo(
    () => Object.fromEntries(group.members.map((m) => [m.userId, m.displayName])),
    [group.members]
  );

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={styles.container}>
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
});
