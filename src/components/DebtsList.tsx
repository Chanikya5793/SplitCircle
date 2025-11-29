import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import { formatCurrency } from '@/utils/currency';
import { StyleSheet, View } from 'react-native';
import { Avatar, Text } from 'react-native-paper';

interface DebtsListProps {
    group: Group;
}

interface Debt {
    from: string;
    to: string;
    amount: number;
}

export const DebtsList = ({ group }: DebtsListProps) => {
    const { theme } = useTheme();

    // Simple debt calculation (not fully optimized for minimum transactions, but sufficient for display)
    // This logic matches the "simplify debts" feature often found in splitwise apps
    const calculateDebts = (): Debt[] => {
        const balances = { ...group.members.reduce((acc, m) => ({ ...acc, [m.userId]: m.balance }), {} as Record<string, number>) };
        const debts: Debt[] = [];

        const debtors = Object.keys(balances).filter(id => balances[id] < -0.01);
        const creditors = Object.keys(balances).filter(id => balances[id] > 0.01);

        // Sort by magnitude to settle largest debts first
        debtors.sort((a, b) => balances[a] - balances[b]);
        creditors.sort((a, b) => balances[b] - balances[a]);

        let i = 0;
        let j = 0;

        while (i < debtors.length && j < creditors.length) {
            const debtor = debtors[i];
            const creditor = creditors[j];

            const amount = Math.min(Math.abs(balances[debtor]), balances[creditor]);

            if (amount > 0.01) {
                debts.push({ from: debtor, to: creditor, amount });
            }

            balances[debtor] += amount;
            balances[creditor] -= amount;

            if (Math.abs(balances[debtor]) < 0.01) i++;
            if (balances[creditor] < 0.01) j++;
        }

        return debts;
    };

    const debts = calculateDebts();
    const memberMap = Object.fromEntries(group.members.map(m => [m.userId, m]));

    if (debts.length === 0) {
        return null;
    }

    return (
        <GlassView style={styles.container}>
            <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
                Who owes whom
            </Text>
            <View style={styles.list}>
                {debts.map((debt, index) => {
                    const fromMember = memberMap[debt.from];
                    const toMember = memberMap[debt.to];

                    if (!fromMember || !toMember) return null;

                    return (
                        <View key={`${debt.from}-${debt.to}-${index}`} style={styles.row}>
                            <View style={styles.member}>
                                <Avatar.Text
                                    size={32}
                                    label={fromMember.displayName.slice(0, 2).toUpperCase()}
                                    style={{ backgroundColor: theme.colors.errorContainer }}
                                    color={theme.colors.onErrorContainer}
                                />
                                <Text style={[styles.name, { color: theme.colors.onSurface }]} numberOfLines={1}>
                                    {fromMember.displayName}
                                </Text>
                            </View>

                            <View style={styles.amountContainer}>
                                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>owes</Text>
                                <Text style={[styles.amount, { color: theme.colors.error }]}>
                                    {formatCurrency(debt.amount, group.currency)}
                                </Text>
                                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>to</Text>
                            </View>

                            <View style={styles.member}>
                                <Avatar.Text
                                    size={32}
                                    label={toMember.displayName.slice(0, 2).toUpperCase()}
                                    style={{ backgroundColor: theme.colors.primaryContainer }}
                                    color={theme.colors.onPrimaryContainer}
                                />
                                <Text style={[styles.name, { color: theme.colors.onSurface }]} numberOfLines={1}>
                                    {toMember.displayName}
                                </Text>
                            </View>
                        </View>
                    );
                })}
            </View>
        </GlassView>
    );
};

const styles = StyleSheet.create({
    container: {
        padding: 16,
        borderRadius: 16,
        gap: 16,
    },
    title: {
        fontWeight: '600',
        marginBottom: 4,
    },
    list: {
        gap: 16,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    member: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
    },
    name: {
        fontWeight: '500',
        flexShrink: 1,
    },
    amountContainer: {
        alignItems: 'center',
        paddingHorizontal: 8,
        width: 100,
    },
    amount: {
        fontWeight: 'bold',
        marginVertical: 2,
    },
});
