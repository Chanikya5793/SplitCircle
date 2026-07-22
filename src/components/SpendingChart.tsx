import { usePrivacyGuard } from '@/context/PrivacyGuardContext';
import { useTheme } from '@/context/ThemeContext';
import type { Expense } from '@/models';
import React, { useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { LineChart, PieChart } from 'react-native-chart-kit';
import { Text } from 'react-native-paper';
import { GlassView } from './GlassView';

interface SpendingChartProps {
    expenses: Expense[];
    currency: string;
    /**
     * Display-currency multiplier (default 1). Keeps chart magnitudes in the
     * same unit as the converted totals rendered next to the chart.
     */
    rate?: number;
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

// Aggregate expenses by category — palette + legend color come from theme tokens
const aggregateByCategory = (
    expenses: Expense[],
    palette: string[],
    legendColor: string,
): { name: string; amount: number; color: string }[] => {
    const categoryMap = new Map<string, number>();

    expenses.forEach((expense) => {
        if (expense.category !== 'Settlement') {
            categoryMap.set(expense.category, (categoryMap.get(expense.category) || 0) + expense.amount);
        }
    });

    return Array.from(categoryMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, amount], index) => ({
            name,
            amount,
            color: palette[index % palette.length],
            legendFontColor: legendColor,
            legendFontSize: 12,
        }));
};

export const SpendingChart = ({ expenses, currency, rate = 1, showPieChart = true }: SpendingChartProps) => {
    const { theme, isDark } = useTheme();
    const { isShielded: chartsIsShielded, action: chartAction } = usePrivacyGuard();
    const chartsShielded = chartsIsShielded('charts');
    const { width: screenWidth } = useWindowDimensions();

    const lineData = useMemo(() => {
        const weekly = aggregateByWeek(expenses);
        return rate === 1
            ? weekly
            : { labels: weekly.labels, data: weekly.data.map((v) => v * rate) };
    }, [expenses, rate]);
    const pieData = useMemo(() => {
        const byCategory = aggregateByCategory(expenses, theme.colors.chart, theme.colors.muted);
        return rate === 1
            ? byCategory
            : byCategory.map((entry) => ({ ...entry, amount: entry.amount * rate }));
    }, [expenses, theme, rate]);

    const chartConfig = {
        backgroundColor: 'transparent',
        backgroundGradientFrom: theme.colors.surface,
        backgroundGradientTo: theme.colors.surface,
        decimalPlaces: 0,
        color: (opacity = 1) =>
            theme.colors.primary + Math.round(opacity * 255).toString(16).padStart(2, '0'),
        labelColor: (opacity = 1) =>
            isDark ? `rgba(255, 255, 255, ${opacity})` : `rgba(0, 0, 0, ${opacity})`,
        style: {
            borderRadius: 16,
        },
        propsForDots: {
            r: '5',
            strokeWidth: '2',
            stroke: theme.colors.primary,
        },
    };

    // Privacy guard: charts target hides the whole visualization. This must
    // run before the empty-data check below, not inside it — the real charts
    // (populated with actual spending data) are rendered further down with no
    // guard of their own, so checking only inside the empty-data branch left
    // the shield doing nothing for anyone with real data to hide.
    if (chartsShielded) {
        return chartAction === 'vanish' ? null : (
            <GlassView style={styles.container}>
                <Text style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>Hidden</Text>
            </GlassView>
        );
    }

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
