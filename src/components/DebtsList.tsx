import { GlassView } from '@/components/GlassView';
import { useTheme } from '@/context/ThemeContext';
import type { Group } from '@/models';
import { formatCurrency } from '@/utils/currency';
import { useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Avatar, IconButton, Modal, Portal, Text } from 'react-native-paper';

interface DebtsListProps {
    group: Group;
}

interface Debt {
    from: string;
    to: string;
    amount: number;
}

export const DebtsList = ({ group }: DebtsListProps) => {
    const { theme, isDark } = useTheme();
    const [selectedDebt, setSelectedDebt] = useState<Debt | null>(null);

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

    const getBreakdown = (debt: Debt) => {
        const transactions: {
            id: string;
            type: 'expense' | 'settlement';
            date: number;
            title: string;
            amount: number;
            direction: 'A_paid_for_B' | 'B_paid_for_A' | 'A_paid_B' | 'B_paid_A'; // A = debt.from, B = debt.to
        }[] = [];

        // Expenses
        group.expenses.forEach(expense => {
            const isPayerA = expense.paidBy === debt.from;
            const isPayerB = expense.paidBy === debt.to;

            if (!isPayerA && !isPayerB) return;

            if (isPayerA) {
                const bShare = expense.participants.find(p => p.userId === debt.to);
                if (bShare && bShare.share > 0) {
                    transactions.push({
                        id: expense.expenseId,
                        type: 'expense',
                        date: expense.createdAt,
                        title: expense.title,
                        amount: bShare.share,
                        direction: 'A_paid_for_B', // Reduces debt
                    });
                }
            }

            if (isPayerB) {
                const aShare = expense.participants.find(p => p.userId === debt.from);
                if (aShare && aShare.share > 0) {
                    transactions.push({
                        id: expense.expenseId,
                        type: 'expense',
                        date: expense.createdAt,
                        title: expense.title,
                        amount: aShare.share,
                        direction: 'B_paid_for_A', // Increases debt
                    });
                }
            }
        });

        // Settlements
        group.settlements.forEach(settlement => {
            if (settlement.fromUserId === debt.from && settlement.toUserId === debt.to) {
                transactions.push({
                    id: settlement.settlementId,
                    type: 'settlement',
                    date: settlement.createdAt,
                    title: 'Settlement',
                    amount: settlement.amount,
                    direction: 'A_paid_B', // Reduces debt
                });
            } else if (settlement.fromUserId === debt.to && settlement.toUserId === debt.from) {
                transactions.push({
                    id: settlement.settlementId,
                    type: 'settlement',
                    date: settlement.createdAt,
                    title: 'Settlement',
                    amount: settlement.amount,
                    direction: 'B_paid_A', // Increases debt
                });
            }
        });

        return transactions.sort((a, b) => b.date - a.date);
    };

    if (debts.length === 0) {
        return null;
    }

    return (
        <>
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
                            <TouchableOpacity
                                key={`${debt.from}-${debt.to}-${index}`}
                                style={styles.row}
                                onPress={() => setSelectedDebt(debt)}
                                activeOpacity={0.7}
                            >
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
                            </TouchableOpacity>
                        );
                    })}
                </View>
            </GlassView>

            <Portal>
                <Modal
                    visible={!!selectedDebt}
                    onDismiss={() => setSelectedDebt(null)}
                    contentContainerStyle={styles.modalContainer}
                >
                    {selectedDebt && (
                        <GlassView style={styles.modalContent}>
                            <View style={styles.modalHeader}>
                                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, flex: 1 }}>
                                    Breakdown
                                </Text>
                                <IconButton icon="close" size={20} onPress={() => setSelectedDebt(null)} />
                            </View>

                            <Text style={{ color: theme.colors.onSurfaceVariant, marginBottom: 16 }}>
                                Why {memberMap[selectedDebt.from]?.displayName} owes {memberMap[selectedDebt.to]?.displayName} {formatCurrency(selectedDebt.amount, group.currency)}
                            </Text>

                            <ScrollView style={{ maxHeight: 400 }}>
                                {getBreakdown(selectedDebt).map((item) => {
                                    const isReducing = item.direction === 'A_paid_for_B' || item.direction === 'A_paid_B';
                                    const color = isReducing ? theme.colors.primary : theme.colors.error;
                                    const sign = isReducing ? '-' : '+';

                                    return (
                                        <View key={item.id} style={[styles.transactionRow, { borderBottomColor: theme.colors.outlineVariant }]}>
                                            <View style={{ flex: 1 }}>
                                                <Text style={{ color: theme.colors.onSurface, fontWeight: '500' }}>{item.title}</Text>
                                                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                                                    {new Date(item.date).toLocaleDateString()} • {item.type === 'expense' ? 'Expense' : 'Settlement'}
                                                </Text>
                                                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                                                    {item.direction === 'B_paid_for_A' ? `${memberMap[selectedDebt.to]?.displayName} paid` :
                                                        item.direction === 'A_paid_for_B' ? `${memberMap[selectedDebt.from]?.displayName} paid` :
                                                            item.direction === 'A_paid_B' ? `${memberMap[selectedDebt.from]?.displayName} settled` :
                                                                `${memberMap[selectedDebt.to]?.displayName} settled`}
                                                </Text>
                                            </View>
                                            <Text style={{ color, fontWeight: 'bold' }}>
                                                {sign} {formatCurrency(item.amount, group.currency)}
                                            </Text>
                                        </View>
                                    );
                                })}
                            </ScrollView>
                        </GlassView>
                    )}
                </Modal>
            </Portal>
        </>
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
    modalContainer: {
        padding: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    modalContent: {
        width: '100%',
        maxWidth: 400,
        padding: 20,
        borderRadius: 24,
    },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
    },
    transactionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        borderBottomWidth: 0.5,
    },
});
