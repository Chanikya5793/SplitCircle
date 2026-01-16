import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { SpendingChart } from '@/components/SpendingChart';
import { useTheme } from '@/context/ThemeContext';
import { Group } from '@/models';
import { formatCurrency } from '@/utils/currency';
import { useMemo } from 'react';
import { Dimensions, ScrollView, StyleSheet, View } from 'react-native';
import { PieChart } from 'react-native-chart-kit';
import { Text } from 'react-native-paper';

interface GroupStatsScreenProps {
  group: Group;
}

const screenWidth = Dimensions.get('window').width;

const CHART_CONFIG = {
  backgroundGradientFrom: '#ffffff',
  backgroundGradientFromOpacity: 0,
  backgroundGradientTo: '#ffffff',
  backgroundGradientToOpacity: 0,
  color: (opacity = 1) => `rgba(103, 80, 164, ${opacity})`,
  strokeWidth: 2,
  barPercentage: 0.5,
  useShadowColorFromDataset: false,
};

const PALETTE = [
  '#FF6384',
  '#36A2EB',
  '#FFCE56',
  '#4BC0C0',
  '#9966FF',
  '#FF9F40',
  '#C9CBCF',
  '#E7E9ED',
];

export const GroupStatsScreen = ({ group }: GroupStatsScreenProps) => {
  const { theme, isDark } = useTheme();

  const categoryData = useMemo(() => {
    if (!group) return [];
    const totals: Record<string, number> = {};
    group.expenses.forEach((expense) => {
      totals[expense.category] = (totals[expense.category] || 0) + expense.amount;
    });

    return Object.entries(totals).map(([name, amount], index) => ({
      name,
      amount,
      color: PALETTE[index % PALETTE.length],
      legendFontColor: isDark ? '#E0E0E0' : '#7F7F7F',
      legendFontSize: 15,
    }));
  }, [group, isDark]);

  if (!group) {
    return (
      <View style={styles.center}>
        <Text style={{ color: theme.colors.onSurface }}>Group not found</Text>
      </View>
    );
  }

  const totalExpenses = group.expenses.reduce((sum, e) => sum + e.amount, 0);

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={styles.container}>
        {/* Spending Trend Chart */}
        <SpendingChart expenses={group.expenses} currency={group.currency} showPieChart={false} />

        <GlassView style={styles.card}>
          <Text variant="headlineMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
            Spending by Category
          </Text>
          <Text variant="titleMedium" style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
            Total: {formatCurrency(totalExpenses, group.currency)}
          </Text>

          {categoryData.length > 0 ? (
            <PieChart
              data={categoryData}
              width={screenWidth - 64} // Adjusted for padding
              height={220}
              chartConfig={CHART_CONFIG}
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
