import { colors } from '@/constants';
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
  backgroundGradientFrom: '#1E2923',
  backgroundGradientFromOpacity: 0,
  backgroundGradientTo: '#08130D',
  backgroundGradientToOpacity: 0.5,
  color: (opacity = 1) => `rgba(26, 255, 146, ${opacity})`,
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
      legendFontColor: '#7F7F7F',
      legendFontSize: 15,
    }));
  }, [group]);

  if (!group) {
    return (
      <View style={styles.center}>
        <Text>Group not found</Text>
      </View>
    );
  }

  const totalExpenses = group.expenses.reduce((sum, e) => sum + e.amount, 0);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text variant="headlineMedium" style={styles.title}>
        Spending by Category
      </Text>
      <Text variant="titleMedium" style={styles.subtitle}>
        Total: {formatCurrency(totalExpenses, group.currency)}
      </Text>

      {categoryData.length > 0 ? (
        <PieChart
          data={categoryData}
          width={screenWidth - 32}
          height={220}
          chartConfig={CHART_CONFIG}
          accessor={'amount'}
          backgroundColor={'transparent'}
          paddingLeft={'15'}
          center={[10, 0]}
          absolute
        />
      ) : (
        <Text style={styles.empty}>No expenses yet.</Text>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: colors.background,
    flexGrow: 1,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    marginBottom: 24,
    textAlign: 'center',
    color: colors.muted,
  },
  empty: {
    textAlign: 'center',
    marginTop: 40,
    color: colors.muted,
  },
});
