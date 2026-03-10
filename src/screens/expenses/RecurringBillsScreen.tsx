import { FloatingLabelInput } from '@/components/FloatingLabelInput';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { Group } from '@/models';
import { BillFrequency, MonthlyPattern, RecurrenceRule, RecurringBill } from '@/models/recurringBill';
import {
    createRecurringBill,
    deleteRecurringBill,
    getRecurringBillsForGroup,
    syncRecurringBillsForGroupWithFallback,
    toggleRecurringBillStatus,
    updateRecurringBill,
} from '@/services/recurringBillService';
import { formatCurrency } from '@/utils/currency';
import { errorHaptic, lightHaptic, successHaptic } from '@/utils/haptics';
import { findNextOccurrenceAt, getRecurrenceSummary, normalizeRecurrenceRule } from '@/utils/recurrence';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Button, IconButton, Modal, Portal, Switch, Text } from 'react-native-paper';

const BILL_CATEGORIES = ['Utilities', 'Rent', 'Subscriptions', 'Food', 'Transport', 'Health', 'Entertainment', 'Shopping', 'Travel', 'General', 'Other'];


type FrequencyPreset =
    | 'daily' | 'every-other-day' | 'weekdays' | 'weekends'
    | 'weekly' | 'biweekly' | 'every-3-weeks'
    | 'twice-a-month' | 'monthly' | 'every-2-months' | 'quarterly' | 'every-4-months' | 'semi-annually'
    | 'yearly' | 'every-2-years'
    | 'custom';

const FREQUENCY_PRESETS: { key: FrequencyPreset; label: string }[] = [
    { key: 'daily', label: 'Daily' },
    { key: 'every-other-day', label: 'Every Other Day' },
    { key: 'weekdays', label: 'Weekdays' },
    { key: 'weekends', label: 'Weekends' },
    { key: 'weekly', label: 'Weekly' },
    { key: 'biweekly', label: 'Every 2 Weeks' },
    { key: 'every-3-weeks', label: 'Every 3 Weeks' },
    { key: 'twice-a-month', label: 'Twice a Month' },
    { key: 'monthly', label: 'Monthly' },
    { key: 'every-2-months', label: 'Every 2 Months' },
    { key: 'quarterly', label: 'Quarterly' },
    { key: 'every-4-months', label: 'Every 4 Months' },
    { key: 'semi-annually', label: 'Every 6 Months' },
    { key: 'yearly', label: 'Yearly' },
    { key: 'every-2-years', label: 'Every 2 Years' },
    { key: 'custom', label: 'Custom' },
];

interface PresetConfig {
    frequency: BillFrequency;
    interval: number;
    weekdays?: number[];
    monthlyPattern?: MonthlyPattern;
    daysOfMonth?: string;
    defaultMonthsOfYear?: number[];
}

const PRESET_DESCRIPTIONS: Partial<Record<FrequencyPreset, string>> = {
    'every-2-months': 'Runs once every 2 months from the bill start date (same day pattern).',
    quarterly: 'Runs every 3 months. Great for quarterly subscriptions, taxes, or maintenance.',
    'every-4-months': 'Runs once every 4 months from the bill start date.',
    'semi-annually': 'Runs every 6 months (twice per year).',
    yearly: 'Runs once every year on the selected month/day pattern.',
    'every-2-years': 'Runs once every 2 years on the selected month/day pattern.',
    custom: 'Build your own cadence: choose interval, unit, pattern, weekdays, and months.',
};

const presetToConfig = (preset: FrequencyPreset): PresetConfig => {
    const currentMonth = new Date().getMonth() + 1;

    switch (preset) {
        case 'daily':           return { frequency: 'daily', interval: 1 };
        case 'every-other-day': return { frequency: 'daily', interval: 2 };
        case 'weekdays':        return { frequency: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] };
        case 'weekends':        return { frequency: 'weekly', interval: 1, weekdays: [0, 6] };
        case 'weekly':          return { frequency: 'weekly', interval: 1 };
        case 'biweekly':        return { frequency: 'weekly', interval: 2 };
        case 'every-3-weeks':   return { frequency: 'weekly', interval: 3 };
        case 'twice-a-month':   return { frequency: 'monthly', interval: 1, monthlyPattern: 'dayOfMonth', daysOfMonth: '1,15' };
        case 'monthly':         return { frequency: 'monthly', interval: 1 };
        case 'every-2-months':  return { frequency: 'monthly', interval: 2 };
        case 'quarterly':       return { frequency: 'monthly', interval: 3 };
        case 'every-4-months':  return { frequency: 'monthly', interval: 4 };
        case 'semi-annually':   return { frequency: 'monthly', interval: 6 };
        case 'yearly':          return { frequency: 'yearly', interval: 1, defaultMonthsOfYear: [currentMonth] };
        case 'every-2-years':   return { frequency: 'yearly', interval: 2, defaultMonthsOfYear: [currentMonth] };
        case 'custom':          return { frequency: 'monthly', interval: 1 };
    }
};

const inferPreset = (freq: BillFrequency, interval: number, weekdays?: number[], daysOfMonth?: number[]): FrequencyPreset => {
    if (freq === 'daily' && interval === 1) return 'daily';
    if (freq === 'daily' && interval === 2) return 'every-other-day';
    if (freq === 'weekly' && interval === 1) {
        if (weekdays && weekdays.length === 5 && [1, 2, 3, 4, 5].every((d) => weekdays.includes(d))) return 'weekdays';
        if (weekdays && weekdays.length === 2 && weekdays.includes(0) && weekdays.includes(6)) return 'weekends';
        return 'weekly';
    }
    if (freq === 'weekly' && interval === 2) return 'biweekly';
    if (freq === 'weekly' && interval === 3) return 'every-3-weeks';
    if (freq === 'monthly' && interval === 1) {
        if (daysOfMonth && daysOfMonth.length === 2 && daysOfMonth.includes(1) && daysOfMonth.includes(15)) return 'twice-a-month';
        return 'monthly';
    }
    if (freq === 'monthly' && interval === 2) return 'every-2-months';
    if (freq === 'monthly' && interval === 3) return 'quarterly';
    if (freq === 'monthly' && interval === 4) return 'every-4-months';
    if (freq === 'monthly' && interval === 6) return 'semi-annually';
    if (freq === 'yearly' && interval === 1) return 'yearly';
    if (freq === 'yearly' && interval === 2) return 'every-2-years';
    return 'custom';
};

const getPresetDescription = (preset: FrequencyPreset): string | null => {
    return PRESET_DESCRIPTIONS[preset] ?? null;
};

interface RecurringBillsScreenProps {
    group: Group;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const parseDayList = (input: string, fallback: number): number[] => {
    const values = input
        .split(',')
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((value) => Number.isFinite(value) && value >= 1 && value <= 31);
    const deduplicated = Array.from(new Set(values));
    return deduplicated.length ? deduplicated : [fallback];
};

const toggleInList = (list: number[], value: number): number[] => {
    if (list.includes(value)) {
        return list.filter((item) => item !== value);
    }
    return [...list, value].sort((a, b) => a - b);
};

export const RecurringBillsScreen = ({ group }: RecurringBillsScreenProps) => {
    const { theme } = useTheme();
    const { user } = useAuth();
    const [bills, setBills] = useState<RecurringBill[]>([]);
    const [loading, setLoading] = useState(true);
    const [modalVisible, setModalVisible] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [editingBillId, setEditingBillId] = useState<string | null>(null);
    const [editingStartAt, setEditingStartAt] = useState<number | null>(null);

    // Form state
    const [title, setTitle] = useState('');
    const [amount, setAmount] = useState('');
    const [category, setCategory] = useState('Utilities');
    const [paidBy, setPaidBy] = useState<string>('');
    const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([]);

    const [frequency, setFrequency] = useState<BillFrequency>('monthly');
    const [intervalInput, setIntervalInput] = useState('1');
    const [selectedPreset, setSelectedPreset] = useState<FrequencyPreset>('monthly');
    const [monthlyPattern, setMonthlyPattern] = useState<MonthlyPattern>('dayOfMonth');
    const [dayOfMonthInput, setDayOfMonthInput] = useState(String(new Date().getDate()));
    const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>([new Date().getDay()]);
    const [selectedWeeksOfMonth, setSelectedWeeksOfMonth] = useState<number[]>([
        Math.floor((new Date().getDate() - 1) / 7) + 1,
    ]);
    const [selectedMonthsOfYear, setSelectedMonthsOfYear] = useState<number[]>(ALL_MONTHS);

    const isCustomPreset = selectedPreset === 'custom';
    const isWeeklyPreset = frequency === 'weekly';
    const isMonthlyOrYearlyPreset = frequency === 'monthly' || frequency === 'yearly';
    const isFixedWeekPreset = selectedPreset === 'weekdays' || selectedPreset === 'weekends';
    const isTwiceAMonthPreset = selectedPreset === 'twice-a-month';
    const canEditWeeklyDays = isWeeklyPreset && (isCustomPreset || !isFixedWeekPreset);
    const canEditMonthlyPattern = isMonthlyOrYearlyPreset && (isCustomPreset || !isTwiceAMonthPreset);
    const canEditDayOfMonth = isMonthlyOrYearlyPreset && monthlyPattern === 'dayOfMonth' && (isCustomPreset || !isTwiceAMonthPreset);
    const canEditWeeksOfMonth = isMonthlyOrYearlyPreset && monthlyPattern === 'weekdaysOfMonth' && (isCustomPreset || !isTwiceAMonthPreset);
    const canEditMonthsOfYear = frequency === 'yearly' && isCustomPreset;

    const memberMap = useMemo(
        () => Object.fromEntries(group.members.map((member) => [member.userId, member.displayName])),
        [group.members],
    );

    useEffect(() => {
        const initialPayer = group.members.find((member) => member.userId === user?.userId)?.userId
            ?? group.members[0]?.userId
            ?? '';
        if (!paidBy) setPaidBy(initialPayer);
        if (selectedParticipantIds.length === 0) {
            setSelectedParticipantIds(group.members.map((member) => member.userId));
        }
    }, [group.members, paidBy, selectedParticipantIds.length, user?.userId]);

    useEffect(() => {
        loadBills();
    }, [group.groupId]);

    const resetForm = () => {
        setEditingBillId(null);
        setEditingStartAt(null);
        setTitle('');
        setAmount('');
        setCategory('Utilities');
        setFrequency('monthly');
        setIntervalInput('1');
        setSelectedPreset('monthly');
        setMonthlyPattern('dayOfMonth');
        setDayOfMonthInput(String(new Date().getDate()));
        setSelectedWeekdays([new Date().getDay()]);
        setSelectedWeeksOfMonth([Math.floor((new Date().getDate() - 1) / 7) + 1]);
        setSelectedMonthsOfYear(ALL_MONTHS);
        setSelectedParticipantIds(group.members.map((member) => member.userId));
        const currentUserInGroup = group.members.find((member) => member.userId === user?.userId)?.userId;
        setPaidBy(currentUserInGroup ?? group.members[0]?.userId ?? '');
    };

    const loadBills = async () => {
        try {
            setLoading(true);
            await syncRecurringBillsForGroupWithFallback(group.groupId);
            const data = await getRecurringBillsForGroup(group.groupId);
            setBills(data);
        } catch (error) {
            console.error('Error loading recurring bills:', error);
            Alert.alert('Error', 'Failed to load recurring bills');
        } finally {
            setLoading(false);
        }
    };

    const buildRecurrenceRule = (startAt: number): RecurrenceRule => {
        const interval = Math.max(1, Number.parseInt(intervalInput, 10) || 1);

        const baseRule: Partial<RecurrenceRule> = {
            frequency,
            interval,
            timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
        };

        if (frequency === 'daily') {
            // For weekdays/weekends presets, use weekly with specific days
            if (selectedPreset === 'weekdays' || selectedPreset === 'weekends') {
                const config = presetToConfig(selectedPreset);
                return normalizeRecurrenceRule({
                    frequency: 'weekly',
                    interval: 1,
                    weekdays: config.weekdays,
                    timezoneOffsetMinutes: baseRule.timezoneOffsetMinutes,
                }, startAt);
            }
            return normalizeRecurrenceRule(baseRule, startAt);
        }

        if (frequency === 'weekly') {
            baseRule.weekdays = selectedWeekdays.length ? selectedWeekdays : [new Date().getDay()];
            return normalizeRecurrenceRule(baseRule, startAt);
        }

        baseRule.monthlyPattern = monthlyPattern;

        if (monthlyPattern === 'dayOfMonth') {
            baseRule.daysOfMonth = parseDayList(dayOfMonthInput, new Date().getDate());
        } else {
            baseRule.weekdays = selectedWeekdays.length ? selectedWeekdays : [new Date().getDay()];
            baseRule.weeksOfMonth = selectedWeeksOfMonth.length
                ? selectedWeeksOfMonth
                : [Math.floor((new Date().getDate() - 1) / 7) + 1];
        }

        if (frequency === 'yearly') {
            baseRule.monthsOfYear = selectedMonthsOfYear.length
                ? selectedMonthsOfYear
                : [new Date().getMonth() + 1];
        } else if (selectedMonthsOfYear.length !== ALL_MONTHS.length) {
            baseRule.monthsOfYear = selectedMonthsOfYear;
        }

        return normalizeRecurrenceRule(baseRule, startAt);
    };

    const buildParticipantShares = (billAmount: number) => {
        const members = group.members.filter((member) => selectedParticipantIds.includes(member.userId));
        if (!members.length) return [];

        const baseShare = Math.floor((billAmount / members.length) * 100) / 100;
        const shares = members.map((member) => ({ userId: member.userId, share: baseShare }));
        const distributed = shares.reduce((sum, participant) => sum + participant.share, 0);
        const remainder = Math.round((billAmount - distributed) * 100) / 100;

        if (remainder !== 0) {
            shares[shares.length - 1].share = Math.round((shares[shares.length - 1].share + remainder) * 100) / 100;
        }

        return shares;
    };

    const handleCreate = async () => {
        if (!title.trim() || !amount.trim() || !paidBy) {
            Alert.alert('Missing Fields', 'Please fill in title, amount, and paid-by.');
            return;
        }

        const billAmount = Number.parseFloat(amount);
        if (!Number.isFinite(billAmount) || billAmount <= 0) {
            Alert.alert('Invalid Amount', 'Please enter a valid amount.');
            return;
        }

        if (!selectedParticipantIds.length) {
            Alert.alert('Participants Required', 'Select at least one participant.');
            return;
        }

        try {
            setIsSubmitting(true);
            const now = Date.now();
            const startAt = editingStartAt ?? now;
            const recurrenceRule = buildRecurrenceRule(startAt);
            const participants = buildParticipantShares(billAmount);
            const nextDueAt = findNextOccurrenceAt(recurrenceRule, startAt, now - 1) ?? startAt;

            if (editingBillId) {
                const existingBill = bills.find((bill) => bill.billId === editingBillId);
                await updateRecurringBill(editingBillId, {
                    title: title.trim(),
                    amount: billAmount,
                    category: category.trim() || 'Other',
                    paidBy,
                    participants,
                    recurrenceRule,
                    startAt,
                    nextDueAt,
                    frequency: frequency as any,
                    dayOfWeek: selectedWeekdays[0],
                    dayOfMonth: parseDayList(dayOfMonthInput, new Date().getDate())[0],
                    isActive: existingBill?.isActive,
                });
            } else {
                await createRecurringBill({
                    groupId: group.groupId,
                    title: title.trim(),
                    amount: billAmount,
                    category: category.trim() || 'Other',
                    paidBy,
                    participants,
                    recurrenceRule,
                    startAt,
                    isActive: true,
                    nextDueAt: now, // generate immediately for newly created bills // should be updated to correct "nextDueAt" in sync step if required
                    frequency: frequency as any,
                    dayOfWeek: selectedWeekdays[0],
                    dayOfMonth: parseDayList(dayOfMonthInput, new Date().getDate())[0],
                });
            }

            await syncRecurringBillsForGroupWithFallback(group.groupId);
            await loadBills();
            successHaptic();
            setModalVisible(false);
            resetForm();
        } catch (error) {
            console.error('Error saving recurring bill:', error);
            Alert.alert('Error', 'Failed to save recurring bill');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleEdit = (bill: RecurringBill) => {
        const normalizedRule = normalizeRecurrenceRule(bill.recurrenceRule, bill.startAt);
        setEditingBillId(bill.billId);
        setEditingStartAt(bill.startAt);
        setTitle(bill.title);
        setAmount(String(bill.amount));
        setCategory(bill.category);
        setPaidBy(bill.paidBy);
        setSelectedParticipantIds(bill.participants.map((participant) => participant.userId));
        setFrequency(normalizedRule.frequency);
        setIntervalInput(String(normalizedRule.interval ?? 1));
        setSelectedPreset(inferPreset(normalizedRule.frequency, normalizedRule.interval ?? 1, normalizedRule.weekdays, normalizedRule.daysOfMonth));
        setMonthlyPattern(normalizedRule.monthlyPattern ?? 'dayOfMonth');
        setDayOfMonthInput((normalizedRule.daysOfMonth ?? [new Date(bill.startAt).getDate()]).join(','));
        setSelectedWeekdays(normalizedRule.weekdays?.length ? normalizedRule.weekdays : [new Date(bill.startAt).getDay()]);
        setSelectedWeeksOfMonth(
            normalizedRule.weeksOfMonth?.length
                ? normalizedRule.weeksOfMonth
                : [Math.floor((new Date(bill.startAt).getDate() - 1) / 7) + 1],
        );
        setSelectedMonthsOfYear(
            normalizedRule.monthsOfYear?.length
                ? normalizedRule.monthsOfYear
                : ALL_MONTHS,
        );
        setModalVisible(true);
    };

    const handleToggle = async (bill: RecurringBill) => {
        try {
            lightHaptic();
            await toggleRecurringBillStatus(bill.billId, !bill.isActive);
            setBills((prev) => prev.map((entry) => (
                entry.billId === bill.billId
                    ? { ...entry, isActive: !entry.isActive }
                    : entry
            )));
        } catch (error) {
            console.error('Error toggling bill:', error);
            Alert.alert('Error', 'Failed to update bill status');
            await loadBills();
        }
    };

    const handleDelete = (bill: RecurringBill) => {
        Alert.alert('Delete Bill', 'Are you sure you want to delete this recurring bill?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                    try {
                        await deleteRecurringBill(bill.billId);
                        errorHaptic();
                        setBills((prev) => prev.filter((entry) => entry.billId !== bill.billId));
                    } catch (error) {
                        console.error('Error deleting bill:', error);
                        Alert.alert('Error', 'Failed to delete recurring bill');
                    }
                },
            },
        ]);
    };

    const openCreateModal = () => {
        resetForm();
        setModalVisible(true);
    };

    return (
        <LiquidBackground>
            <ScrollView contentContainerStyle={styles.container}>
                <GlassView style={styles.headerCard}>
                    <Text variant="headlineSmall" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
                        Recurring Bills
                    </Text>
                    <Text style={{ color: theme.colors.onSurfaceVariant }}>
                        Automate and schedule shared expenses with advanced rules.
                    </Text>
                </GlassView>

                {bills.length === 0 && !loading ? (
                    <GlassView style={styles.emptyCard}>
                        <Text style={{ textAlign: 'center', color: theme.colors.onSurfaceVariant }}>
                            No recurring bills yet.
                        </Text>
                    </GlassView>
                ) : (
                    bills.map((bill) => (
                        <GlassView key={bill.billId} style={styles.billCard}>
                            <View style={styles.billRow}>
                                <View style={{ flex: 1 }}>
                                    <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
                                        {bill.title}
                                    </Text>
                                    <Text style={{ color: theme.colors.onSurfaceVariant }}>
                                        {formatCurrency(bill.amount, group.currency)} • {getRecurrenceSummary(bill.recurrenceRule)}
                                    </Text>
                                    <Text style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                                        Paid by {memberMap[bill.paidBy] ?? 'Unknown'} • {bill.participants.length} participant{bill.participants.length === 1 ? '' : 's'}
                                    </Text>
                                    <Text style={{ color: theme.colors.onSurfaceVariant }}>
                                        Next run: {new Date(bill.nextDueAt).toLocaleString()}
                                    </Text>
                                </View>
                                <Switch
                                    value={bill.isActive}
                                    onValueChange={() => handleToggle(bill)}
                                    color={theme.colors.primary}
                                />
                                <IconButton
                                    icon="pencil-outline"
                                    iconColor={theme.colors.primary}
                                    onPress={() => handleEdit(bill)}
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

                <Button mode="contained" onPress={openCreateModal} style={{ marginTop: 20 }} icon="plus">
                    Add Recurring Bill
                </Button>
            </ScrollView>

            <Portal>
                <Modal
                    visible={modalVisible}
                    onDismiss={() => {
                        setModalVisible(false);
                        resetForm();
                    }}
                    contentContainerStyle={styles.modal}
                >
                    <GlassView style={styles.modalCard}>
                        <ScrollView contentContainerStyle={styles.modalContent} showsVerticalScrollIndicator={false}>
                            <Text variant="headlineSmall" style={{ marginBottom: 16, color: theme.colors.onSurface }}>
                                {editingBillId ? 'Edit Recurring Bill' : 'New Recurring Bill'}
                            </Text>

                            <FloatingLabelInput label="Title" value={title} onChangeText={setTitle} />
                            <FloatingLabelInput label="Amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />

                            <Text style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>Category</Text>
                            <View style={styles.wrapRow}>
                                {BILL_CATEGORIES.map((cat) => (
                                    <TouchableOpacity
                                        key={cat}
                                        onPress={() => setCategory(cat)}
                                        style={[styles.chip, category === cat && { backgroundColor: theme.colors.primary }]}
                                    >
                                        <Text style={{ color: category === cat ? theme.colors.onPrimary : theme.colors.onSurface }}>
                                            {cat}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>

                            <Text style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>Repeat</Text>
                            <View style={styles.wrapRow}>
                                {FREQUENCY_PRESETS.map(({ key, label }) => (
                                    <TouchableOpacity
                                        key={key}
                                        onPress={() => {
                                            setSelectedPreset(key);
                                            if (key !== 'custom') {
                                                const config = presetToConfig(key);
                                                setFrequency(config.frequency);
                                                setIntervalInput(String(config.interval));
                                                if (config.weekdays) {
                                                    setSelectedWeekdays(config.weekdays);
                                                }
                                                if (config.monthlyPattern) {
                                                    setMonthlyPattern(config.monthlyPattern);
                                                }
                                                if (config.daysOfMonth) {
                                                    setDayOfMonthInput(config.daysOfMonth);
                                                }
                                                setSelectedMonthsOfYear(config.defaultMonthsOfYear ?? ALL_MONTHS);
                                            }
                                        }}
                                        style={[styles.chip, selectedPreset === key && { backgroundColor: theme.colors.primary }]}
                                    >
                                        <Text style={{ color: selectedPreset === key ? theme.colors.onPrimary : theme.colors.onSurface }}>
                                            {label}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>

                            {getPresetDescription(selectedPreset) && (
                                <Text style={[styles.helperText, { color: theme.colors.onSurfaceVariant }]}>
                                    {getPresetDescription(selectedPreset)}
                                </Text>
                            )}

                            {!isCustomPreset && (
                                <Text style={[styles.helperText, { color: theme.colors.onSurfaceVariant }]}>
                                    Quick preset mode: only relevant options are shown. Switch to Custom for full control.
                                </Text>
                            )}

                            {selectedPreset === 'custom' && (
                                <>
                                    <Text style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>Repeat Every</Text>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                                        <FloatingLabelInput
                                            label="Interval (N)"
                                            value={intervalInput}
                                            onChangeText={setIntervalInput}
                                            keyboardType="number-pad"
                                            containerStyle={{ flex: 1 }}
                                        />
                                        <View style={[styles.wrapRow, { flex: 3 }]}>
                                            {(['daily', 'weekly', 'monthly', 'yearly'] as const).map((value) => (
                                                <TouchableOpacity
                                                    key={value}
                                                    onPress={() => setFrequency(value)}
                                                    style={[styles.chip, frequency === value && { backgroundColor: theme.colors.primary }]}
                                                >
                                                    <Text style={{ color: frequency === value ? theme.colors.onPrimary : theme.colors.onSurface }}>
                                                        {value === 'daily' ? (intervalInput === '1' ? 'Day' : 'Days')
                                                            : value === 'weekly' ? (intervalInput === '1' ? 'Week' : 'Weeks')
                                                            : value === 'monthly' ? (intervalInput === '1' ? 'Month' : 'Months')
                                                            : (intervalInput === '1' ? 'Year' : 'Years')}
                                                    </Text>
                                                </TouchableOpacity>
                                            ))}
                                        </View>
                                    </View>
                                    <Text style={[styles.helperText, { color: theme.colors.onSurfaceVariant }]}>
                                        Example: N=2 + Months means every 2 months. N=1 + Years means yearly.
                                    </Text>
                                </>
                            )}

                            {canEditMonthlyPattern && (
                                <>
                                    <Text style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>Monthly Pattern</Text>
                                    <View style={styles.wrapRow}>
                                        {(['dayOfMonth', 'weekdaysOfMonth'] as const).map((value) => (
                                            <TouchableOpacity
                                                key={value}
                                                onPress={() => setMonthlyPattern(value)}
                                                style={[styles.chip, monthlyPattern === value && { backgroundColor: theme.colors.primary }]}
                                            >
                                                <Text style={{ color: monthlyPattern === value ? theme.colors.onPrimary : theme.colors.onSurface }}>
                                                    {value === 'dayOfMonth' ? 'By Day Number' : 'By Week + Weekday'}
                                                </Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                </>
                            )}

                            {canEditDayOfMonth && (
                                <FloatingLabelInput
                                    label="Days of month (e.g. 1,15,28)"
                                    value={dayOfMonthInput}
                                    onChangeText={setDayOfMonthInput}
                                    keyboardType="numbers-and-punctuation"
                                />
                            )}

                            {(canEditWeeklyDays || (canEditWeeksOfMonth && monthlyPattern === 'weekdaysOfMonth')) && (
                                <>
                                    <Text style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>Weekdays</Text>
                                    <View style={styles.wrapRow}>
                                        {WEEKDAY_LABELS.map((label, day) => (
                                            <TouchableOpacity
                                                key={label}
                                                onPress={() => setSelectedWeekdays((prev) => toggleInList(prev, day))}
                                                style={[
                                                    styles.chip,
                                                    selectedWeekdays.includes(day) && { backgroundColor: theme.colors.primary },
                                                ]}
                                            >
                                                <Text style={{ color: selectedWeekdays.includes(day) ? theme.colors.onPrimary : theme.colors.onSurface }}>
                                                    {label}
                                                </Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                </>
                            )}

                            {canEditWeeksOfMonth && (
                                <>
                                    <Text style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>Weeks in Month</Text>
                                    <View style={styles.wrapRow}>
                                        {[1, 2, 3, 4, 5].map((week) => (
                                            <TouchableOpacity
                                                key={week}
                                                onPress={() => setSelectedWeeksOfMonth((prev) => toggleInList(prev, week))}
                                                style={[
                                                    styles.chip,
                                                    selectedWeeksOfMonth.includes(week) && { backgroundColor: theme.colors.primary },
                                                ]}
                                            >
                                                <Text style={{ color: selectedWeeksOfMonth.includes(week) ? theme.colors.onPrimary : theme.colors.onSurface }}>
                                                    Week {week}
                                                </Text>
                                            </TouchableOpacity>
                                        ))}
                                    </View>
                                </>
                            )}

                            {canEditMonthsOfYear && (
                                <>
                                    <Text style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>Months in Year</Text>
                                    <Text style={[styles.helperText, { color: theme.colors.onSurfaceVariant }]}>
                                        Optional filter. Keep all months selected for default behavior.
                                    </Text>
                                    <View style={styles.wrapRow}>
                                        {MONTH_LABELS.map((label, index) => {
                                            const month = index + 1;
                                            const selected = selectedMonthsOfYear.includes(month);
                                            return (
                                                <TouchableOpacity
                                                    key={label}
                                                    onPress={() => setSelectedMonthsOfYear((prev) => toggleInList(prev, month))}
                                                    style={[styles.chip, selected && { backgroundColor: theme.colors.primary }]}
                                                >
                                                    <Text style={{ color: selected ? theme.colors.onPrimary : theme.colors.onSurface }}>
                                                        {label}
                                                    </Text>
                                                </TouchableOpacity>
                                            );
                                        })}
                                    </View>
                                </>
                            )}

                            <Text style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>Paid By</Text>
                            <View style={styles.wrapRow}>
                                {group.members.map((member) => (
                                    <TouchableOpacity
                                        key={member.userId}
                                        onPress={() => setPaidBy(member.userId)}
                                        style={[styles.chip, paidBy === member.userId && { backgroundColor: theme.colors.primary }]}
                                    >
                                        <Text style={{ color: paidBy === member.userId ? theme.colors.onPrimary : theme.colors.onSurface }}>
                                            {member.displayName}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>

                            <Text style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>Participants</Text>
                            <View style={styles.wrapRow}>
                                {group.members.map((member) => {
                                    const selected = selectedParticipantIds.includes(member.userId);
                                    return (
                                        <TouchableOpacity
                                            key={member.userId}
                                            onPress={() => setSelectedParticipantIds((prev) => (
                                                prev.includes(member.userId)
                                                    ? prev.filter((id) => id !== member.userId)
                                                    : [...prev, member.userId]
                                            ))}
                                            style={[styles.chip, selected && { backgroundColor: theme.colors.primary }]}
                                        >
                                            <Text style={{ color: selected ? theme.colors.onPrimary : theme.colors.onSurface }}>
                                                {member.displayName}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>

                            <Button
                                mode="contained"
                                onPress={handleCreate}
                                loading={isSubmitting}
                                style={{ marginTop: 14 }}
                            >
                                {editingBillId ? 'Save Changes' : 'Create Bill'}
                            </Button>

                            <Button
                                mode="text"
                                onPress={() => {
                                    setModalVisible(false);
                                    resetForm();
                                }}
                                style={{ marginTop: 8 }}
                            >
                                Cancel
                            </Button>
                        </ScrollView>
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
        margin: 14,
        maxHeight: '90%',
    },
    modalCard: {
        borderRadius: 24,
        overflow: 'hidden',
    },
    modalContent: {
        padding: 20,
        paddingBottom: 24,
    },
    sectionLabel: {
        marginTop: 12,
        marginBottom: 8,
        fontWeight: '600',
    },
    helperText: {
        marginTop: 6,
        marginBottom: 4,
        lineHeight: 18,
    },
    wrapRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    chip: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 18,
        backgroundColor: 'rgba(0,0,0,0.08)',
    },
});
