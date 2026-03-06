import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useTheme } from '@/context/ThemeContext';
import { useGroups } from '@/context/GroupContext';
import { Group } from '@/models';
import { RecurringBill } from '@/models/recurringBill';
import {
    createRecurringBill,
    deleteRecurringBill,
    getRecurringBillsForGroup,
    toggleRecurringBillStatus
} from '@/services/recurringBillService';
import { formatCurrency } from '@/utils/currency';
import { lightHaptic, successHaptic, errorHaptic } from '@/utils/haptics';
import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View, TouchableOpacity } from 'react-native';
import { Button, IconButton, Text, Switch, Modal, Portal } from 'react-native-paper';
import { FloatingLabelInput } from '@/components/FloatingLabelInput';

interface RecurringBillsScreenProps {
    group: Group;
}

export const RecurringBillsScreen = ({ group }: RecurringBillsScreenProps) => {
    const { theme, isDark } = useTheme();
    const [bills, setBills] = useState<RecurringBill[]>([]);
    const [loading, setLoading] = useState(true);
    const [modalVisible, setModalVisible] = useState(false);

    // Form State
    const [title, setTitle] = useState('');
    const [amount, setAmount] = useState('');
    const [frequency, setFrequency] = useState<'weekly' | 'biweekly' | 'monthly'>('monthly');
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        loadBills();
    }, [group.groupId]);

    const loadBills = async () => {
        try {
            setLoading(true);
            const data = await getRecurringBillsForGroup(group.groupId);
            setBills(data);
        } catch (error) {
            console.error('Error loading bills:', error);
            Alert.alert('Error', 'Failed to load recurring bills');
        } finally {
            setLoading(false);
        }
    };

    const handleCreate = async () => {
        if (!title || !amount) {
            Alert.alert('Missing Fields', 'Please fill in all fields');
            return;
        }

        try {
            setIsSubmitting(true);
            const currentUser = group.members[0]; // Simplified for now, should be actual auth user

            await createRecurringBill({
                groupId: group.groupId,
                title,
                amount: parseFloat(amount),
                category: 'Utilities', // Default for now
                paidBy: currentUser.userId,
                participants: group.members.map(m => ({
                    userId: m.userId,
                    share: parseFloat(amount) / group.members.length
                })),
                frequency,
                dayOfWeek: new Date().getDay(),
                isActive: true,
                nextDueAt: Date.now(), // Due immediately upon creation
            });

            successHaptic();
            setModalVisible(false);
            setTitle('');
            setAmount('');
            loadBills();
        } catch (error) {
            console.error('Error creating bill:', error);
            Alert.alert('Error', 'Failed to create recurring bill');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleToggle = async (bill: RecurringBill) => {
        try {
            lightHaptic();
            await toggleRecurringBillStatus(bill.billId, !bill.isActive);
            // Optimistic update
            setBills(prev => prev.map(b =>
                b.billId === bill.billId ? { ...b, isActive: !b.isActive } : b
            ));
        } catch (error) {
            console.error('Error toggling bill:', error);
            Alert.alert('Error', 'Failed to update bill status');
            loadBills(); // Revert on failure
        }
    };

    const handleDelete = (bill: RecurringBill) => {
        Alert.alert('Delete Bill', 'Are you sure?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                    try {
                        await deleteRecurringBill(bill.billId);
                        errorHaptic();
                        setBills(prev => prev.filter(b => b.billId !== bill.billId));
                    } catch (error) {
                        console.error('Error deleting bill:', error);
                    }
                }
            }
        ]);
    };

    return (
        <LiquidBackground>
            <ScrollView contentContainerStyle={styles.container}>
                <GlassView style={styles.headerCard}>
                    <Text variant="headlineSmall" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
                        Recurring Bills
                    </Text>
                    <Text style={{ color: theme.colors.onSurfaceVariant }}>
                        Automate your regular group expenses
                    </Text>
                </GlassView>

                {bills.length === 0 && !loading ? (
                    <GlassView style={styles.emptyCard}>
                        <Text style={{ textAlign: 'center', color: theme.colors.onSurfaceVariant }}>
                            No recurring bills yet.
                        </Text>
                    </GlassView>
                ) : (
                    bills.map(bill => (
                        <GlassView key={bill.billId} style={styles.billCard}>
                            <View style={styles.billRow}>
                                <View style={{ flex: 1 }}>
                                    <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
                                        {bill.title}
                                    </Text>
                                    <Text style={{ color: theme.colors.onSurfaceVariant }}>
                                        {formatCurrency(bill.amount, group.currency)} • {bill.frequency}
                                    </Text>
                                </View>
                                <Switch
                                    value={bill.isActive}
                                    onValueChange={() => handleToggle(bill)}
                                    color={theme.colors.primary}
                                />
                                <IconButton
                                    icon="delete-outline"
                                    iconColor={theme.colors.error}
                                    onPress={() => handleDelete(bill)}
                                />
                            </View>
                        </GlassView>
                    ))
                )}

                <Button
                    mode="contained"
                    onPress={() => setModalVisible(true)}
                    style={{ marginTop: 20 }}
                    icon="plus"
                >
                    Add Recurring Bill
                </Button>
            </ScrollView>

            <Portal>
                <Modal visible={modalVisible} onDismiss={() => setModalVisible(false)} contentContainerStyle={styles.modal}>
                    <GlassView style={{ padding: 24, borderRadius: 24 }}>
                        <Text variant="headlineSmall" style={{ marginBottom: 20, color: theme.colors.onSurface }}>
                            New Recurring Bill
                        </Text>

                        <FloatingLabelInput label="Title" value={title} onChangeText={setTitle} />
                        <FloatingLabelInput label="Amount" value={amount} onChangeText={setAmount} keyboardType="numeric" />

                        <View style={{ flexDirection: 'row', gap: 10, marginVertical: 10 }}>
                            {(['weekly', 'biweekly', 'monthly'] as const).map(f => (
                                <TouchableOpacity
                                    key={f}
                                    onPress={() => setFrequency(f)}
                                    style={[
                                        styles.chip,
                                        frequency === f && { backgroundColor: theme.colors.primary }
                                    ]}
                                >
                                    <Text style={{
                                        color: frequency === f ? theme.colors.onPrimary : theme.colors.onSurface
                                    }}>
                                        {f.charAt(0).toUpperCase() + f.slice(1)}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>

                        <Button
                            mode="contained"
                            onPress={handleCreate}
                            loading={isSubmitting}
                            style={{ marginTop: 10 }}
                        >
                            Create Bill
                        </Button>
                    </GlassView>
                </Modal>
            </Portal>
        </LiquidBackground>
    );
};

const styles = StyleSheet.create({
    container: {
        padding: 16,
        paddingBottom: 100,
    },
    headerCard: {
        padding: 20,
        borderRadius: 24,
        marginBottom: 20,
    },
    billCard: {
        padding: 16,
        borderRadius: 20,
        marginBottom: 10,
    },
    emptyCard: {
        padding: 30,
        borderRadius: 20,
        alignItems: 'center',
    },
    billRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    modal: {
        padding: 20,
    },
    chip: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 20,
        backgroundColor: 'rgba(0,0,0,0.05)',
    },
});
