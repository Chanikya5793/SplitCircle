import { GlassView } from '@/components/GlassView';
import { clearOpenSwipeable, setOpenSwipeable } from '@/utils/swipeableRegistry';
import { ROUTES } from '@/constants';
import { useTheme } from '@/context/ThemeContext';
import type { Group, GroupMember } from '@/models';
import { useMoneyDisplay } from '@/hooks/useMoneyDisplay';
import { usePrivacyMask } from '@/hooks/usePrivacyMask';
import { minimizeDebts, type Debt } from '@/utils/debtMinimizer';
import { lightHaptic } from '@/utils/haptics';
import { needsDisplayName, resolveDisplayName, resolveInitials } from '@/utils/identity';
import { useMemo, useRef, useState } from 'react';
import { Animated as RNAnimated, Modal, Pressable, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { Avatar, IconButton, Text } from 'react-native-paper';
import { useNavigation } from '@react-navigation/native';

interface SwipeableDebtRowProps {
    debt: Debt;
    fromMember: GroupMember;
    toMember: GroupMember;
    groupId: string;
    currency: string;
    onOpenBreakdown: () => void;
    onSettle: () => void;
}

// Swipe-right on a debt row triggers the same "record payment" action as the
// inline handshake button. Mirrors the Swipeable pattern from
// SwipeableExpenseCard (RectButton pill + dragX interpolation) so the gesture
// feels consistent with the rest of the app. Tap still opens the breakdown.
const SwipeableDebtRow = ({
    debt,
    fromMember,
    toMember,
    groupId,
    currency,
    onOpenBreakdown,
    onSettle,
}: SwipeableDebtRowProps) => {
    const { theme } = useTheme();
    const fmtMoney = useMoneyDisplay(groupId);
    const { maskGroupText } = usePrivacyMask();
    const swipeableRef = useRef<Swipeable>(null);

    const fromName = maskGroupText(resolveDisplayName(fromMember), groupId, 'person');
    const toName = maskGroupText(resolveDisplayName(toMember), groupId, 'person');
    const fromIsPlaceholder = needsDisplayName(fromMember);
    const toIsPlaceholder = needsDisplayName(toMember);

    const renderLeftActions = (
        progress: RNAnimated.AnimatedInterpolation<number>,
        dragX: RNAnimated.AnimatedInterpolation<number>,
    ) => {
        const translateX = dragX.interpolate({
            inputRange: [0, 120],
            outputRange: [-120, 0],
            extrapolate: 'clamp',
        });

        const scale = progress.interpolate({
            inputRange: [0, 1],
            outputRange: [0.8, 1],
            extrapolate: 'clamp',
        });

        return (
            <RNAnimated.View style={[styles.leftAction, { transform: [{ translateX }, { scale }] }]}>
                <RectButton
                    style={styles.leftActionPressable}
                    onPress={() => {
                        lightHaptic();
                        swipeableRef.current?.close();
                        onSettle();
                    }}
                >
                    <View style={[styles.settleButtonPill, { backgroundColor: theme.colors.primary }]}>
                        <IconButton icon="handshake" iconColor="#fff" size={22} style={{ margin: 0 }} />
                        <Text style={styles.actionText}>Settle</Text>
                    </View>
                </RectButton>
            </RNAnimated.View>
        );
    };

    return (
        <Swipeable
            ref={swipeableRef}
            onSwipeableWillOpen={() => setOpenSwipeable(swipeableRef.current)}
            onSwipeableClose={() => clearOpenSwipeable(swipeableRef.current)}
            renderLeftActions={renderLeftActions}
            friction={2}
            leftThreshold={40}
            overshootLeft={false}
            containerStyle={styles.swipeContainer}
        >
            <TouchableOpacity
                style={styles.row}
                onPress={onOpenBreakdown}
                activeOpacity={0.7}
            >
                <View style={styles.member}>
                    <Avatar.Text
                        size={28}
                        label={resolveInitials(fromName)}
                        style={{ backgroundColor: theme.colors.errorContainer }}
                        color={theme.colors.onErrorContainer}
                    />
                    <Text
                        style={[
                            styles.name,
                            { color: fromIsPlaceholder ? theme.colors.onSurfaceVariant : theme.colors.onSurface },
                            fromIsPlaceholder && styles.placeholderName,
                        ]}
                        numberOfLines={1}
                    >
                        {fromName}
                    </Text>
                </View>

                <View style={styles.amountContainer}>
                    <Text style={[styles.amount, { color: theme.colors.error }]}>
                        {fmtMoney(debt.amount, currency)}
                    </Text>
                    <IconButton icon="arrow-right" size={16} iconColor={theme.colors.onSurfaceVariant} style={{ margin: 0 }} />
                </View>

                <View style={styles.member}>
                    <Avatar.Text
                        size={28}
                        label={resolveInitials(toName)}
                        style={{ backgroundColor: theme.colors.primaryContainer }}
                        color={theme.colors.onPrimaryContainer}
                    />
                    <Text
                        style={[
                            styles.name,
                            { color: toIsPlaceholder ? theme.colors.onSurfaceVariant : theme.colors.onSurface },
                            toIsPlaceholder && styles.placeholderName,
                        ]}
                        numberOfLines={1}
                    >
                        {toName}
                    </Text>
                </View>

                <IconButton
                    icon="handshake"
                    size={20}
                    iconColor={theme.colors.primary}
                    style={{ margin: 0, marginLeft: 8 }}
                    onPress={onSettle}
                />
            </TouchableOpacity>
        </Swipeable>
    );
};

interface DebtsListProps {
    group: Group;
}

export const DebtsList = ({ group }: DebtsListProps) => {
  const fmtMoney = useMoneyDisplay(group.groupId);
  const { maskGroupText } = usePrivacyMask();
    const { theme, isDark } = useTheme();
    const isFlat = theme?.surfaceStyle === 'flat';
    const navigation = useNavigation<any>();
    const [selectedDebt, setSelectedDebt] = useState<Debt | null>(null);
    const [isCollapsed, setIsCollapsed] = useState(false);

    // Use the optimized debt minimization algorithm. Include archived members
    // so removed/left users still appear in the "who owes whom" graph as long
    // as they have a non-zero balance against historical expenses.
    const debts = useMemo(() => {
        const allMembers = [...(group.members ?? []), ...(group.archivedMembers ?? [])];
        const balances = allMembers.reduce(
            (acc, m) => ({ ...acc, [m.userId]: m.balance }),
            {} as Record<string, number>
        );
        return minimizeDebts(balances);
    }, [group.members, group.archivedMembers]);

    const memberMap = Object.fromEntries(
        [...(group.members ?? []), ...(group.archivedMembers ?? [])].map((m) => [m.userId, m]),
    );


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
            <GlassView role="glass" style={styles.container}>
                <TouchableOpacity
                    onPress={() => setIsCollapsed(!isCollapsed)}
                    style={styles.headerRow}
                    activeOpacity={0.7}
                >
                    <Text variant="titleMedium" style={[styles.title, { color: theme.colors.onSurface }]}>
                        Who owes whom
                    </Text>
                    <IconButton
                        icon={isCollapsed ? 'chevron-down' : 'chevron-up'}
                        size={20}
                        iconColor={theme.colors.onSurfaceVariant}
                        style={{ margin: 0 }}
                    />
                </TouchableOpacity>

                {!isCollapsed && (
                    <View style={styles.list}>
                        {debts.map((debt, index) => {
                            const fromMember = memberMap[debt.from];
                            const toMember = memberMap[debt.to];

                            if (!fromMember || !toMember) return null;

                            return (
                                <SwipeableDebtRow
                                    key={`${debt.from}-${debt.to}-${index}`}
                                    debt={debt}
                                    fromMember={fromMember}
                                    toMember={toMember}
                                    groupId={group.groupId}
                                    currency={group.currency}
                                    onOpenBreakdown={() => setSelectedDebt(debt)}
                                    onSettle={() => {
                                        navigation.navigate(ROUTES.APP.SETTLEMENTS, {
                                            groupId: group.groupId,
                                            initialFromUserId: debt.from,
                                            initialToUserId: debt.to,
                                            initialAmount: debt.amount,
                                        });
                                    }}
                                />
                            );
                        })}
                    </View>
                )}
            </GlassView>

            {/* react-native-paper's own Modal wraps its content in a Surface with an
                animated `opacity` style — an ancestor with fractional opacity kills
                the native iOS 26 glass material (DESIGN.md's native-material kill
                list). RN core Modal's fade is a native UIKit transition, not a
                JS-tree opacity ancestor, so it doesn't have this problem. */}
            <Modal
                visible={!!selectedDebt}
                transparent
                statusBarTranslucent
                animationType="fade"
                onRequestClose={() => setSelectedDebt(null)}
            >
                <Pressable style={styles.modalBackdrop} onPress={() => setSelectedDebt(null)} accessibilityLabel="Close breakdown" />
                <View style={styles.modalContainer} pointerEvents="box-none">
                    {selectedDebt && (
                        <GlassView role="floating"
                            style={[
                                styles.modalContent,
                                {
                                    // Default GlassView is intentionally low-opacity for cards
                                    // floating over the LiquidBackground; for a focus modal that
                                    // needs to be readable, override with the theme surface color
                                    // at 96% so the blob colors don't bleed through into the
                                    // transaction text.
                                    backgroundColor: theme.dark
                                        ? 'rgba(28, 30, 36, 0.96)'
                                        : 'rgba(252, 252, 254, 0.96)',
                                },
                            ]}
                            intensity={70}
                        >
                            <View style={styles.modalHeader}>
                                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, flex: 1 }}>
                                    Breakdown
                                </Text>
                                <IconButton icon="close" size={20} onPress={() => setSelectedDebt(null)} />
                            </View>

                            <Text style={{ color: theme.colors.onSurfaceVariant, marginBottom: 16 }}>
                                Why {maskGroupText(resolveDisplayName(memberMap[selectedDebt.from]), group.groupId, 'person')} owes {maskGroupText(resolveDisplayName(memberMap[selectedDebt.to]), group.groupId, 'person')} {fmtMoney(selectedDebt.amount, group.currency)}
                            </Text>

                            <ScrollView style={{ maxHeight: 400 }}>
                                {getBreakdown(selectedDebt).map((item) => {
                                    const isReducing = item.direction === 'A_paid_for_B' || item.direction === 'A_paid_B';
                                    const color = isReducing ? theme.colors.primary : theme.colors.error;
                                    const sign = isReducing ? '-' : '+';

                                    return (
                                        <View
                                            key={item.id}
                                            style={[
                                                styles.transactionRow,
                                                // No dividers between list items in flat mode — the
                                                // existing paddingVertical rhythm already separates rows.
                                                { borderBottomColor: theme.colors.outlineVariant, borderBottomWidth: isFlat ? 0 : 0.5 },
                                            ]}
                                        >
                                            <View style={{ flex: 1 }}>
                                                <Text style={{ color: theme.colors.onSurface, fontWeight: '500' }}>{item.title}</Text>
                                                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                                                    {new Date(item.date).toLocaleDateString()} • {item.type === 'expense' ? 'Expense' : 'Settlement'}
                                                </Text>
                                                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                                                    {item.direction === 'B_paid_for_A' ? `${resolveDisplayName(memberMap[selectedDebt.to])} paid` :
                                                        item.direction === 'A_paid_for_B' ? `${resolveDisplayName(memberMap[selectedDebt.from])} paid` :
                                                            item.direction === 'A_paid_B' ? `${resolveDisplayName(memberMap[selectedDebt.from])} settled` :
                                                                `${resolveDisplayName(memberMap[selectedDebt.to])} settled`}
                                                </Text>
                                            </View>
                                            <Text style={{ color, fontWeight: 'bold' }}>
                                                {sign} {fmtMoney(item.amount, group.currency)}
                                            </Text>
                                        </View>
                                    );
                                })}
                            </ScrollView>
                        </GlassView>
                    )}
                </View>
            </Modal>
        </>
    );
};

const styles = StyleSheet.create({
    container: {
        padding: 14,
        borderRadius: 16,
        // Tightened 16 -> 10 (2026-08-07, compact density pass).
        gap: 10,
    },
    title: {
        fontWeight: '600',
        marginBottom: 4,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 4,
    },
    list: {
        // Tightened 10 -> 8.
        gap: 8,
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
    placeholderName: {
        fontStyle: 'italic',
    },
    amountContainer: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 4,
    },
    amount: {
        fontWeight: 'bold',
        marginVertical: 2,
    },
    modalBackdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.45)',
    },
    modalContainer: {
        flex: 1,
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
    swipeContainer: {
        borderRadius: 12,
        overflow: 'hidden',
    },
    leftAction: {
        width: 120,
        justifyContent: 'center',
        alignItems: 'center',
    },
    leftActionPressable: {
        flex: 1,
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    settleButtonPill: {
        width: 104,
        height: 44,
        borderRadius: 100,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.15,
        shadowRadius: 4,
        elevation: 3,
    },
    actionText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: 'bold',
        marginRight: 8,
    },
});
