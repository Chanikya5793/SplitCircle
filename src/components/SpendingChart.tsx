import { useTheme } from '@/context/ThemeContext';
import type { Expense } from '@/models';
import React, { useMemo } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import { LineChart, PieChart } from 'react-native-chart-kit';
import { Text } from 'react-native-paper';
import { GlassView } from './GlassView';

const screenWidth = Dimensions.get('window').width;

interface SpendingChartProps {
    expenses: Expense[];
    currency: string;
    showPieChart?: boolean;
}

// Aggregate expenses by week
const aggregateByWeek = (expenses: Expense[]): { labels: string[]; data: number[] } => {
    const weekMap = new Map<string, number>();

    // Sort by date
    const sorted = [...expenses].sort((a, b) => a.createdAt - b.createdAt);

    sorted.forEach((expense) => {
        const date = new Date(expense.createdAt);
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        const weekKey = `${weekStart.getMonth() + 1}/${weekStart.getDate()}`;

        weekMap.set(weekKey, (weekMap.get(weekKey) || 0) + expense.amount);
    });

    // Take last 6 weeks max
    const entries = Array.from(weekMap.entries()).slice(-6);

    return {
        labels: entries.map(([label]) => label),
        data: entries.map(([, amount]) => amount),
    };
};

// Aggregate expenses by category
const aggregateByCategory = (expenses: Expense[]): { name: string; amount: number; color: string }[] => {
    const categoryMap = new Map<string, number>();

    expenses.forEach((expense) => {
        if (expense.category !== 'Settlement') {
            categoryMap.set(expense.category, (categoryMap.get(expense.category) || 0) + expense.amount);
        }
    });

    const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#C9CBCF', '#7BC225'];

    return Array.from(categoryMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, amount], index) => ({
            name,
            amount,
            color: colors[index % colors.length],
            legendFontColor: '#7F7F7F',
            legendFontSize: 12,
        }));
};

export const SpendingChart = ({ expenses, currency, showPieChart = true }: SpendingChartProps) => {
    const { theme, isDark } = useTheme();

    const lineData = useMemo(() => aggregateByWeek(expenses), [expenses]);
    const pieData = useMemo(() => aggregateByCategory(expenses), [expenses]);

    const chartConfig = {
        backgroundColor: 'transparent',
        backgroundGradientFrom: isDark ? '#1E1E1E' : '#ffffff',
        backgroundGradientTo: isDark ? '#1E1E1E' : '#ffffff',
        decimalPlaces: 0,
        color: (opacity = 1) => isDark ? `rgba(167, 139, 250, ${opacity})` : `rgba(99, 102, 241, ${opacity})`,
        labelColor: (opacity = 1) => isDark ? `rgba(255, 255, 255, ${opacity})` : `rgba(0, 0, 0, ${opacity})`,
        style: {
            borderRadius: 16,
        },
        propsForDots: {
            r: '5',
            strokeWidth: '2',
            stroke: theme.colors.primary,
        },
    };

    if (expenses.length === 0 || lineData.data.length === 0) {
        return (
            <GlassView style={styles.container}>
                <Text style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                    No spending data yet
                </Text>
            </GlassView>
        );
    }

    return (
        <View style={styles.wrapper}>
            <GlassView style={styles.container}>
                <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
                    Spending Trend
                </Text>
                <LineChart
                    data={{
                        labels: lineData.labels,
                        datasets: [{ data: lineData.data.length > 0 ? lineData.data : [0] }],
                    }}
                    width={screenWidth - 64}
                    height={180}
                    chartConfig={chartConfig}
                    bezier
                    style={styles.chart}
                    withInnerLines={false}
                    withOuterLines={false}
                />
            </GlassView>

            {showPieChart && pieData.length > 0 && (
                <GlassView style={styles.container}>
                    <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
                        By Category
                    </Text>
                    <PieChart
                        data={pieData}
                        width={screenWidth - 64}
                        height={180}
                        chartConfig={chartConfig}
                        accessor="amount"
                        backgroundColor="transparent"
                        paddingLeft="15"
                        absolute
                    />
                </GlassView>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    wrapper: {
        gap: 16,
    },
    container: {
        padding: 16,
        borderRadius: 16,
    },
    title: {
        fontWeight: '600',
        marginBottom: 12,
    },
    chart: {
        marginVertical: 8,
        borderRadius: 16,
    },
});
