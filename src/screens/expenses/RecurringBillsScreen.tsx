import { FloatingLabelInput } from '@/components/FloatingLabelInput';
import { clearOpenSwipeable, setOpenSwipeable } from '@/utils/swipeableRegistry';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { GuardedScreen } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { Group } from '@/models';
import { BillAmountMode, BillFrequency, MonthlyPattern, RecurrenceRule, RecurringBill } from '@/models/recurringBill';
import {
    createRecurringBill,
    deleteRecurringBill,
    getRecurringBillsForGroup,
    resolveRotationPayer,
    skipOccurrence,
    syncRecurringBillsForGroupWithFallback,
    toggleRecurringBillStatus,
    updateRecurringBill,
} from '@/services/recurringBillService';
import { formatCurrency } from '@/utils/currency';
import { errorHaptic, lightHaptic, successHaptic } from '@/utils/haptics';
import { findNextOccurrenceAt, getRecurrenceSummary, normalizeRecurrenceRule } from '@/utils/recurrence';
import { resolveDisplayName } from '@/utils/identity';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    Animated,
    Easing,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    TouchableOpacity,
    useWindowDimensions,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { appAlert } from '@/utils/appAlert';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { Button, Icon, IconButton, Switch, Text } from 'react-native-paper';
import { ALL_EXPENSE_CATEGORIES } from '@/utils/categoryMatch';

// Same canonical set as everywhere else (utils/categoryMatch.ts), ordered
// bill-first for this screen's picker.
const BILL_FIRST = ['Utilities', 'Rent', 'Subscriptions'] as const;
const BILL_CATEGORIES = [
    ...BILL_FIRST,
    ...ALL_EXPENSE_CATEGORIES.filter((c) => !(BILL_FIRST as readonly string[]).includes(c)),
];


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

const SwipeableBillCard = ({
    editColor,
    onEdit,
    onDelete,
    children,
}: {
    editColor: string;
    onEdit: () => void;
    onDelete: () => void;
    children: React.ReactNode;
}) => {
    const swipeableRef = useRef<Swipeable>(null);

    const renderRightActions = () => (
        <View style={styles.rowActions}>
            <RectButton
                style={[styles.rowActionButton, { backgroundColor: editColor }]}
                onPress={() => {
                    lightHaptic();
                    swipeableRef.current?.close();
                    onEdit();
                }}
                accessibilityLabel="Edit recurring bill"
            >
                <IconButton icon="pencil" iconColor="#fff" size={22} style={{ margin: 0 }} />
                <Text style={styles.rowActionText}>Edit</Text>
            </RectButton>
            <RectButton
                style={[styles.rowActionButton, { backgroundColor: '#FF3B30' }]}
                onPress={() => {
                    errorHaptic();
                    swipeableRef.current?.close();
                    onDelete();
                }}
                accessibilityLabel="Delete recurring bill"
            >
                <IconButton icon="trash-can-outline" iconColor="#fff" size={22} style={{ margin: 0 }} />
                <Text style={styles.rowActionText}>Delete</Text>
            </RectButton>
        </View>
    );

    return (
        <Swipeable
            ref={swipeableRef}
            onSwipeableWillOpen={() => setOpenSwipeable(swipeableRef.current)}
            onSwipeableClose={() => clearOpenSwipeable(swipeableRef.current)}
            renderRightActions={renderRightActions}
            friction={2}
            rightThreshold={40}
            overshootRight={false}
            containerStyle={styles.swipeableContainer}
        >
            {children}
        </Swipeable>
    );
};

export const RecurringBillsScreen = ({ group }: RecurringBillsScreenProps) => {
    const { theme, isDark } = useTheme();
    const { user } = useAuth();
    const insets = useSafeAreaInsets();
    const { height: screenHeight } = useWindowDimensions();
    const [bills, setBills] = useState<RecurringBill[]>([]);
    const [loading, setLoading] = useState(true);
    const [modalVisible, setModalVisible] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [editingBillId, setEditingBillId] = useState<string | null>(null);
    const [editingStartAt, setEditingStartAt] = useState<number | null>(null);

    // Sheet entrance: slide UP from below while the Modal fades the scrim in
    // (app-wide "Sheet DNA" — see DisplayCurrencySheet). Native driver only.
    const slide = useRef(new Animated.Value(0)).current;
    const [sheetHeight, setSheetHeight] = useState(screenHeight * 0.9);
    useEffect(() => {
        if (modalVisible) {
            slide.setValue(0);
            Animated.timing(slide, {
                toValue: 1,
                duration: 300,
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
            }).start();
        }
    }, [modalVisible, slide]);
    const sheetTranslateY = slide.interpolate({
        inputRange: [0, 1],
        outputRange: [sheetHeight + 80, 0],
    });

    // Form state
    const [title, setTitle] = useState('');
    const [amount, setAmount] = useState('');
    const [category, setCategory] = useState('Utilities');
    const [paidBy, setPaidBy] = useState<string>('');
    const [selectedParticipantIds, setSelectedParticipantIds] = useState<string[]>([]);

    // ── v2 (ai_layer/docs/26): fixed/variable + payer rotation ──
    const [amountMode, setAmountMode] = useState<BillAmountMode>('fixed');
    const [rotationEnabled, setRotationEnabled] = useState(false);
    const [rotationOrder, setRotationOrder] = useState<string[]>([]);

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
        () => Object.fromEntries(group.members.map((member) => [member.userId, resolveDisplayName(member, 'Unknown')])),
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
        setAmountMode('fixed');
        setRotationEnabled(false);
        setRotationOrder([]);
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
            appAlert('Error', 'Failed to load recurring bills');
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
            appAlert('Missing Fields', 'Please fill in title, amount, and paid-by.');
            return;
        }

        const billAmount = Number.parseFloat(amount);
        if (!Number.isFinite(billAmount) || billAmount <= 0) {
            appAlert('Invalid Amount', 'Please enter a valid amount.');
            return;
        }

        if (!selectedParticipantIds.length) {
            appAlert('Participants Required', 'Select at least one participant.');
            return;
        }

        try {
            setIsSubmitting(true);
            const now = Date.now();
            const startAt = editingStartAt ?? now;
            const recurrenceRule = buildRecurrenceRule(startAt);
            const participants = buildParticipantShares(billAmount);
            const nextDueAt = findNextOccurrenceAt(recurrenceRule, startAt, now - 1) ?? startAt;

            const hasRotation = rotationEnabled && rotationOrder.length >= 2;

            if (editingBillId) {
                const existingBill = bills.find((bill) => bill.billId === editingBillId);
                // Keep the rotation turn when the order is unchanged; a reorder
                // restarts the cycle from the first person.
                const sameOrder =
                    hasRotation &&
                    existingBill?.rotation &&
                    existingBill.rotation.order.join(',') === rotationOrder.join(',');
                await updateRecurringBill(editingBillId, {
                    title: title.trim(),
                    amount: billAmount,
                    category: category.trim() || 'Other',
                    paidBy,
                    participants,
                    recurrenceRule,
                    startAt,
                    nextDueAt,
                    amountMode,
                    // Hidden-ledger bills (1:1 requests, doc 26) are ALWAYS
                    // accept-gated: consent per occurrence, no silent accrual.
                    requiresAccept: group.hidden === true,
                    rotation: hasRotation
                        ? { order: rotationOrder, index: sameOrder ? existingBill!.rotation!.index : 0 }
                        : (null as unknown as undefined), // Firestore: null clears the field
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
                    amountMode,
                    requiresAccept: group.hidden === true,
                    ...(hasRotation ? { rotation: { order: rotationOrder, index: 0 } } : {}),
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
            appAlert('Error', 'Failed to save recurring bill');
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
        setAmountMode(bill.amountMode ?? 'fixed');
        setRotationEnabled(Boolean(bill.rotation));
        setRotationOrder(bill.rotation?.order ?? []);
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
            appAlert('Error', 'Failed to update bill status');
            await loadBills();
        }
    };

    // Skip-this-occurrence (doc 26): no expense, rotation turn NOT consumed.
    const handleSkipNext = (bill: RecurringBill) => {
        appAlert(
            'Skip Next Occurrence',
            `Skip "${bill.title}" due ${new Date(bill.nextDueAt).toLocaleDateString()}? No expense will be created and the payer turn won't advance.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Skip',
                    onPress: async () => {
                        try {
                            await skipOccurrence(bill, bill.nextDueAt);
                            lightHaptic();
                            await loadBills();
                        } catch (error) {
                            console.error('Error skipping occurrence:', error);
                            appAlert('Error', 'Failed to skip the next occurrence');
                        }
                    },
                },
            ],
        );
    };

    const handleDelete = (bill: RecurringBill) => {
        appAlert('Delete Bill', 'Are you sure you want to delete this recurring bill?', [
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
                        appAlert('Error', 'Failed to delete recurring bill');
                    }
                },
            },
        ]);
    };

    const openCreateModal = () => {
        resetForm();
        setModalVisible(true);
    };

    const closeModal = () => {
        setModalVisible(false);
        resetForm();
    };

    // Glass action pill for the card's dedicated action row — icon over label,
    // spaced so operations breathe instead of crowding the card edge.
    const CardAction = ({
        icon,
        label,
        color,
        onPress,
        accessibilityLabel,
    }: {
        icon: string;
        label: string;
        color: string;
        onPress: () => void;
        accessibilityLabel?: string;
    }) => (
        <TouchableOpacity
            onPress={onPress}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? label}
            style={[
                styles.cardAction,
                { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' },
            ]}
        >
            <Icon source={icon} size={20} color={color} />
            <Text style={[styles.cardActionLabel, { color }]}>{label}</Text>
        </TouchableOpacity>
    );

    return (
        <LiquidBackground>
            <GuardedScreen target="expenses" entityId={group.groupId} label="Bills hidden">
                <ScrollView
                    contentContainerStyle={[styles.container, { paddingTop: insets.top + 60 }]}
                    showsVerticalScrollIndicator={false}
                >
                    <GlassView style={styles.headerCard}>
                        <Text variant="headlineSmall" style={{ fontWeight: '700', color: theme.colors.onSurface }}>
                            Recurring Bills
                        </Text>
                        <Text style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                            Automate and schedule shared expenses with advanced rules.
                        </Text>
                    </GlassView>

                    {bills.length === 0 && !loading ? (
                        <GlassView style={styles.emptyCard}>
                            <Icon source="calendar-clock" size={40} color={theme.colors.onSurfaceVariant} />
                            <Text style={{ textAlign: 'center', color: theme.colors.onSurface, fontWeight: '600', marginTop: 10 }}>
                                No recurring bills yet
                            </Text>
                            <Text style={{ textAlign: 'center', color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                                Add one to automate a shared expense on a schedule.
                            </Text>
                        </GlassView>
                    ) : (
                        bills.map((bill) => (
                            <SwipeableBillCard
                                key={bill.billId}
                                editColor={theme.colors.primary}
                                onEdit={() => handleEdit(bill)}
                                onDelete={() => handleDelete(bill)}
                            >
                                <GlassView style={styles.billCard}>
                                    {/* Header: title + amount on the left, active toggle on the right */}
                                    <View style={styles.billHeader}>
                                        <View style={{ flex: 1, paddingRight: 12 }}>
                                            <Text variant="titleMedium" style={{ fontWeight: '700', color: theme.colors.onSurface }}>
                                                {bill.title}
                                            </Text>
                                            <Text style={{ color: theme.colors.onSurface, marginTop: 2, fontWeight: '600' }}>
                                                {bill.amountMode === 'variable'
                                                    ? `Variable (≈${formatCurrency(bill.amount, group.currency)})`
                                                    : formatCurrency(bill.amount, group.currency)}
                                                <Text style={{ color: theme.colors.onSurfaceVariant, fontWeight: '400' }}>
                                                    {'  •  '}{getRecurrenceSummary(bill.recurrenceRule)}
                                                </Text>
                                            </Text>
                                        </View>
                                        <Switch
                                            value={bill.isActive}
                                            onValueChange={() => handleToggle(bill)}
                                            color={theme.colors.primary}
                                        />
                                    </View>

                                    {/* Meta lines */}
                                    <View style={styles.billMeta}>
                                        <Text style={{ color: theme.colors.onSurfaceVariant }}>
                                            {bill.rotation
                                                ? `Rotates · next turn: ${memberMap[resolveRotationPayer(bill)] ?? 'Unknown'}`
                                                : `Paid by ${memberMap[bill.paidBy] ?? 'Unknown'}`} • {bill.participants.length} participant{bill.participants.length === 1 ? '' : 's'}
                                        </Text>
                                        <Text style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                                            Next run: {new Date(bill.nextDueAt).toLocaleString()}
                                        </Text>
                                        {(bill.pendingOccurrences?.length ?? 0) > 0 && (
                                            <Text style={{ color: theme.colors.primary, marginTop: 4 }}>
                                                {bill.pendingOccurrences!.length} occurrence{bill.pendingOccurrences!.length === 1 ? '' : 's'} waiting for an amount — confirm from the group chat
                                            </Text>
                                        )}
                                    </View>

                                    {/* Dedicated, spaced action row — brought out of the cramped edge */}
                                    <View style={[styles.cardActionRow, { borderTopColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)' }]}>
                                        <CardAction
                                            icon="skip-next-outline"
                                            label="Skip"
                                            color={theme.colors.onSurfaceVariant}
                                            onPress={() => handleSkipNext(bill)}
                                            accessibilityLabel="Skip next occurrence"
                                        />
                                        <CardAction
                                            icon="pencil-outline"
                                            label="Edit"
                                            color={theme.colors.primary}
                                            onPress={() => handleEdit(bill)}
                                            accessibilityLabel="Edit recurring bill"
                                        />
                                        <CardAction
                                            icon="delete-outline"
                                            label="Delete"
                                            color={theme.colors.error}
                                            onPress={() => handleDelete(bill)}
                                            accessibilityLabel="Delete recurring bill"
                                        />
                                    </View>
                                </GlassView>
                            </SwipeableBillCard>
                        ))
                    )}

                    <Button mode="contained" onPress={openCreateModal} style={styles.addButton} icon="plus">
                        Add Recurring Bill
                    </Button>
                </ScrollView>
            </GuardedScreen>

            {/* Create / edit form — app "Sheet DNA": fade scrim + slide-up glass sheet */}
            <Modal
                visible={modalVisible}
                transparent
                statusBarTranslucent
                animationType="fade"
                onRequestClose={closeModal}
            >
                <KeyboardAvoidingView
                    style={styles.sheetOverlay}
                    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                    pointerEvents="box-none"
                >
                    <Pressable style={styles.sheetBackdrop} onPress={closeModal} accessibilityLabel="Dismiss form" />
                    <Animated.View
                        onLayout={(e) => setSheetHeight(e.nativeEvent.layout.height)}
                        style={{ transform: [{ translateY: sheetTranslateY }] }}
                    >
                        <GlassView role="floating" style={styles.sheet} intensity={80}>
                            <View style={[styles.grabber, { backgroundColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)' }]} />
                            <Text variant="titleLarge" style={{ fontWeight: '700', color: theme.colors.onSurface, textAlign: 'center', marginBottom: 12 }}>
                                {editingBillId ? 'Edit Recurring Bill' : 'New Recurring Bill'}
                            </Text>
                            <ScrollView
                                style={{ maxHeight: screenHeight * 0.62 }}
                                contentContainerStyle={styles.sheetContent}
                                showsVerticalScrollIndicator={false}
                                keyboardShouldPersistTaps="handled"
                            >

                            <FloatingLabelInput label="Title" value={title} onChangeText={setTitle} />
                            <FloatingLabelInput
                                label={amountMode === 'variable' ? 'Typical amount' : 'Amount'}
                                value={amount}
                                onChangeText={setAmount}
                                keyboardType="decimal-pad"
                            />

                            <Text style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant }]}>Amount Type</Text>
                            <View style={styles.wrapRow}>
                                {(['fixed', 'variable'] as const).map((mode) => (
                                    <TouchableOpacity
                                        key={mode}
                                        onPress={() => setAmountMode(mode)}
                                        style={[styles.chip, amountMode === mode && { backgroundColor: theme.colors.primary }]}
                                    >
                                        <Text style={{ color: amountMode === mode ? theme.colors.onPrimary : theme.colors.onSurface }}>
                                            {mode === 'fixed' ? 'Fixed' : 'Variable'}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                            {amountMode === 'variable' && (
                                <Text style={[styles.helperText, { color: theme.colors.onSurfaceVariant }]}>
                                    Variable bills wait for the real amount each time: a card appears in the group chat and the payer (or an admin) enters it. Shares split in the same proportions as the typical amount.
                                </Text>
                            )}

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
                                            {resolveDisplayName(member)}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>

                            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
                                <Text style={[styles.sectionLabel, { color: theme.colors.onSurfaceVariant, marginTop: 0, marginBottom: 0 }]}>
                                    Rotate Payer
                                </Text>
                                <Switch
                                    value={rotationEnabled}
                                    onValueChange={(value) => {
                                        lightHaptic();
                                        setRotationEnabled(value);
                                        if (value && rotationOrder.length === 0) {
                                            setRotationOrder(paidBy ? [paidBy] : []);
                                        }
                                    }}
                                    color={theme.colors.primary}
                                />
                            </View>
                            {rotationEnabled && (
                                <>
                                    <Text style={[styles.helperText, { color: theme.colors.onSurfaceVariant }]}>
                                        Tap members in turn order — each generated occurrence moves to the next person. Skipped occurrences don't consume a turn.
                                    </Text>
                                    <View style={styles.wrapRow}>
                                        {group.members.map((member) => {
                                            const position = rotationOrder.indexOf(member.userId);
                                            const selected = position >= 0;
                                            return (
                                                <TouchableOpacity
                                                    key={member.userId}
                                                    onPress={() => {
                                                        lightHaptic();
                                                        setRotationOrder((prev) => (
                                                            prev.includes(member.userId)
                                                                ? prev.filter((id) => id !== member.userId)
                                                                : [...prev, member.userId]
                                                        ));
                                                    }}
                                                    style={[styles.chip, selected && { backgroundColor: theme.colors.primary }]}
                                                >
                                                    <Text style={{ color: selected ? theme.colors.onPrimary : theme.colors.onSurface }}>
                                                        {selected ? `${position + 1}. ` : ''}{resolveDisplayName(member)}
                                                    </Text>
                                                </TouchableOpacity>
                                            );
                                        })}
                                    </View>
                                    {rotationOrder.length < 2 && (
                                        <Text style={[styles.helperText, { color: theme.colors.error }]}>
                                            Pick at least two members for a rotation.
                                        </Text>
                                    )}
                                </>
                            )}

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
                                                {resolveDisplayName(member)}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>

                            </ScrollView>

                            {/* Docked footer — actions live here, not buried at the bottom of the scroll */}
                            <View style={[styles.sheetFooter, { borderTopColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)', paddingBottom: insets.bottom + 10 }]}>
                                <Button
                                    mode="text"
                                    onPress={closeModal}
                                    style={styles.footerCancel}
                                    textColor={theme.colors.onSurface}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    mode="contained"
                                    onPress={handleCreate}
                                    loading={isSubmitting}
                                    style={styles.footerSubmit}
                                    contentStyle={{ height: 46 }}
                                >
                                    {editingBillId ? 'Save Changes' : 'Create Bill'}
                                </Button>
                            </View>
                        </GlassView>
                    </Animated.View>
                </KeyboardAvoidingView>
            </Modal>
        </LiquidBackground>
    );
};

const styles = StyleSheet.create({
    container: {
        padding: 16,
        paddingBottom: 120,
    },
    headerCard: {
        padding: 20,
        borderRadius: 24,
        marginBottom: 16,
    },
    billCard: {
        padding: 16,
        borderRadius: 22,
    },
    swipeableContainer: {
        borderRadius: 22,
        overflow: 'hidden',
        marginBottom: 12,
    },
    rowActions: {
        flexDirection: 'row',
    },
    rowActionButton: {
        justifyContent: 'center',
        alignItems: 'center',
        width: 84,
    },
    rowActionText: {
        color: '#fff',
        fontSize: 12,
        fontWeight: '600',
        marginTop: -4,
    },
    emptyCard: {
        padding: 32,
        borderRadius: 22,
        alignItems: 'center',
        marginBottom: 12,
    },
    billHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
    },
    billMeta: {
        marginTop: 8,
    },
    cardActionRow: {
        flexDirection: 'row',
        gap: 10,
        marginTop: 14,
        paddingTop: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    cardAction: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 10,
        borderRadius: 14,
    },
    cardActionLabel: {
        fontSize: 13,
        fontWeight: '600',
    },
    addButton: {
        marginTop: 8,
        borderRadius: 16,
    },
    // ── Sheet DNA ──
    sheetOverlay: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    sheetBackdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.5)',
    },
    sheet: {
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        paddingTop: 10,
    },
    grabber: {
        alignSelf: 'center',
        width: 40,
        height: 5,
        borderRadius: 3,
        marginBottom: 12,
    },
    sheetContent: {
        paddingHorizontal: 20,
        paddingBottom: 16,
    },
    sheetFooter: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 20,
        paddingTop: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
    },
    footerCancel: {
        borderRadius: 16,
    },
    footerSubmit: {
        flex: 1,
        borderRadius: 16,
    },
    sectionLabel: {
        marginTop: 16,
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
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'rgba(128,128,128,0.35)',
        // Theme-neutral system fill — reads on both light and dark glass, unlike
        // the old rgba(0,0,0,0.08) that vanished in dark mode.
        backgroundColor: 'rgba(120,120,128,0.16)',
    },
});
