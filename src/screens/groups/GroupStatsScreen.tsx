import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { GuardedScreen } from '@/components/ui';
import { SpendingChart } from '@/components/SpendingChart';
import { useTheme } from '@/context/ThemeContext';
import { Group } from '@/models';
import { useMoneyDisplay } from '@/hooks/useMoneyDisplay';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { PieChart } from 'react-native-chart-kit';
import { Text } from 'react-native-paper';

interface GroupStatsScreenProps {
  group: Group;
}

export const GroupStatsScreen = ({ group }: GroupStatsScreenProps) => {
  const fmtMoney = useMoneyDisplay(group?.groupId);
  const { theme } = useTheme();
  const { width: screenWidth } = useWindowDimensions();

  // Chart colors follow the theme (slot 0 is the user's accent).
  const chartConfig = useMemo(
    () => ({
      backgroundGradientFrom: theme.colors.surface,
      backgroundGradientFromOpacity: 0,
      backgroundGradientTo: theme.colors.surface,
      backgroundGradientToOpacity: 0,
      color: (opacity = 1) => theme.colors.primary + Math.round(opacity * 255).toString(16).padStart(2, '0'),
      strokeWidth: 2,
      barPercentage: 0.5,
      useShadowColorFromDataset: false,
    }),
    [theme],
  );

  const categoryData = useMemo(() => {
    if (!group) return [];
    const totals: Record<string, number> = {};
    group.expenses.forEach((expense) => {
      // Settlement pseudo-expenses aren't spending — keep them out of the pie.
      if (expense.category === 'Settlement') return;
      totals[expense.category] = (totals[expense.category] || 0) + expense.amount;
    });

    return Object.entries(totals).map(([name, amount], index) => ({
      name,
      amount,
      color: theme.colors.chart[index % theme.colors.chart.length],
      legendFontColor: theme.colors.muted,
      legendFontSize: 15,
    }));
  }, [group, theme]);

  if (!group) {
    return (
      <View style={styles.center}>
        <Text style={{ color: theme.colors.onSurface }}>Group not found</Text>
      </View>
    );
  }

  const totalExpenses = group.expenses
    .filter((e) => e.category !== 'Settlement')
    .reduce((sum, e) => sum + e.amount, 0);

  return (
    <LiquidBackground>
      <GuardedScreen target="expenses" entityId={group.groupId} label="Stats hidden">
      <ScrollView contentContainerStyle={styles.container}>
        {/* Spending Trend Chart */}
        <SpendingChart expenses={group.expenses} currency={group.currency} showPieChart={false} />

        <GlassView style={styles.card}>
          <Text variant="headlineMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
            Spending by Category
          </Text>
          <Text variant="titleMedium" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
            Total: {fmtMoney(totalExpenses, group.currency)}
          </Text>

          {categoryData.length > 0 ? (
            <PieChart
              data={categoryData}
              width={screenWidth - 64} // Adjusted for padding
              height={220}
              chartConfig={chartConfig}
              accessor={'amount'}
              backgroundColor={'transparent'}
              paddingLeft={'15'}
              center={[10, 0]}
              absolute
            />
          ) : (
            <Text style={[styles.empty, { color: theme.colors.onSurfaceVariant }]}>No expenses yet.</Text>
          )}
        </GlassView>
      </ScrollView>
    </GuardedScreen>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingBottom: 180,
    flexGrow: 1,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    padding: 24,
    borderRadius: 24,
    alignItems: 'center',
  },
  title: {
    marginBottom: 8,
    textAlign: 'center',
    fontWeight: 'bold',
  },
  subtitle: {
    marginBottom: 24,
    textAlign: 'center',
  },
  empty: {
    textAlign: 'center',
    marginTop: 40,
  },
});
