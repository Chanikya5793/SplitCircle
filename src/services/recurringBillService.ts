/**
 * Recurring Bills Service
 *
 * Handles creation, management, and automatic expense generation for recurring bills.
 */

import { app, db } from '@/firebase';
import type { Expense } from '@/models';
import type { ParticipantShare } from '@/models/expense';
import type { LegacyBillFrequency, RecurrenceRule, RecurringBill } from '@/models/recurringBill';
import {
    findNextOccurrenceAt,
    getNextDueAt,
    normalizeRecurrenceRule,
} from '@/utils/recurrence';
import {
    addDoc,
    arrayUnion,
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    query,
    updateDoc,
    where,
    writeBatch,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';

const COLLECTION_NAME = 'recurringBills';
const MAX_GENERATION_CATCH_UP = 48;
const functions = getFunctions(app);

type TriggerRecurringBillsResponse = {
    generatedCount?: number;
};

const triggerRecurringBillsForGroupCallable = httpsCallable<{ groupId: string }, TriggerRecurringBillsResponse>(
    functions,
    'triggerRecurringBillsForGroup',
);

type RecurringBillUpsertInput = Partial<Omit<RecurringBill, 'billId' | 'createdAt' | 'updatedAt' | 'lastGeneratedAt'>> & {
    groupId: string;
    title: string;
    amount: number;
    category: string;
    paidBy: string;
    participants: ParticipantShare[];
    createdAt?: number;
    updatedAt?: number;
    lastGeneratedAt?: number;
    recurrenceRule?: Partial<RecurrenceRule>;
    frequency?: LegacyBillFrequency;
    dayOfMonth?: number;
    dayOfWeek?: number;
};

const getValidTimestamp = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'object' && value !== null) {
        const maybeTimestamp = value as { toMillis?: () => number; seconds?: number };
        if (typeof maybeTimestamp.toMillis === 'function') {
            return maybeTimestamp.toMillis();
        }
        if (typeof maybeTimestamp.seconds === 'number') {
            return maybeTimestamp.seconds * 1000;
        }
    }
    return null;
};

const toLegacyRule = (data: RecurringBillUpsertInput, startAt: number): RecurrenceRule => {
    const dayOfWeek = typeof data.dayOfWeek === 'number' ? data.dayOfWeek : new Date(startAt).getDay();
    const dayOfMonth = typeof data.dayOfMonth === 'number' ? data.dayOfMonth : new Date(startAt).getDate();

    switch (data.frequency) {
        case 'biweekly':
            return normalizeRecurrenceRule(
                {
                    frequency: 'weekly',
                    interval: 2,
                    weekdays: [dayOfWeek],
                    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
                },
                startAt,
            );
        case 'weekly':
            return normalizeRecurrenceRule(
                {
                    frequency: 'weekly',
                    interval: 1,
                    weekdays: [dayOfWeek],
                    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
                },
                startAt,
            );
        case 'monthly':
        default:
            return normalizeRecurrenceRule(
                {
                    frequency: 'monthly',
                    interval: 1,
                    monthlyPattern: 'dayOfMonth',
                    daysOfMonth: [dayOfMonth],
                    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
                },
                startAt,
            );
    }
};

const normalizeRecurringBill = (billId: string, rawData: Record<string, unknown>): RecurringBill => {
    const data = rawData as RecurringBillUpsertInput;
    const now = Date.now();

    const createdAt = getValidTimestamp(data.createdAt) ?? now;
    const updatedAt = getValidTimestamp(data.updatedAt) ?? now;
    const startAt = getValidTimestamp(data.startAt) ?? getValidTimestamp(data.nextDueAt) ?? createdAt;
    const recurrenceRule = data.recurrenceRule
        ? normalizeRecurrenceRule(data.recurrenceRule, startAt)
        : toLegacyRule(data, startAt);

    const nextDueAtRaw = getValidTimestamp(data.nextDueAt);
    const nextDueAt = nextDueAtRaw ?? findNextOccurrenceAt(recurrenceRule, startAt, startAt - 1) ?? startAt;

    return {
        billId,
        groupId: data.groupId,
        title: data.title,
        amount: data.amount,
        category: data.category,
        paidBy: data.paidBy,
        participants: data.participants ?? [],
        recurrenceRule,
        startAt,
        endAt: getValidTimestamp(data.endAt) ?? undefined,
        frequency: data.frequency,
        dayOfMonth: typeof data.dayOfMonth === 'number' ? data.dayOfMonth : undefined,
        dayOfWeek: typeof data.dayOfWeek === 'number' ? data.dayOfWeek : undefined,
        isActive: data.isActive ?? true,
        lastGeneratedAt: getValidTimestamp(data.lastGeneratedAt) ?? undefined,
        nextDueAt,
        createdAt,
        updatedAt,
    };
};

/**
 * Create a new recurring bill
 */
export const createRecurringBill = async (
    bill: Omit<RecurringBillUpsertInput, 'createdAt' | 'updatedAt' | 'lastGeneratedAt'>
): Promise<string> => {
    const now = Date.now();
    const startAt = getValidTimestamp(bill.startAt) ?? now;
    const recurrenceRule = bill.recurrenceRule
        ? normalizeRecurrenceRule(bill.recurrenceRule, startAt)
        : toLegacyRule(bill, startAt);
    const nextDueAt = getValidTimestamp(bill.nextDueAt) ?? findNextOccurrenceAt(recurrenceRule, startAt, startAt - 1) ?? startAt;

    const docRef = await addDoc(collection(db, COLLECTION_NAME), {
        ...bill,
        recurrenceRule,
        startAt,
        nextDueAt,
        isActive: bill.isActive ?? true,
        createdAt: now,
        updatedAt: now,
    });
    return docRef.id;
};

/**
 * Get all recurring bills for a group
 */
export const getRecurringBillsForGroup = async (groupId: string): Promise<RecurringBill[]> => {
    const q = query(collection(db, COLLECTION_NAME), where('groupId', '==', groupId));
    const snapshot = await getDocs(q);
    return snapshot.docs
        .map((docSnapshot) => normalizeRecurringBill(docSnapshot.id, docSnapshot.data()))
        .sort((a, b) => a.nextDueAt - b.nextDueAt);
};

/**
 * Update a recurring bill
 */
export const updateRecurringBill = async (
    billId: string,
    updates: Partial<Omit<RecurringBill, 'billId' | 'createdAt'>>
): Promise<void> => {
    const docRef = doc(db, COLLECTION_NAME, billId);
    const payload: Record<string, unknown> = {
        ...updates,
        updatedAt: Date.now(),
    };

    const shouldNormalizeRule = Boolean(
        updates.recurrenceRule ||
        updates.frequency ||
        typeof updates.dayOfWeek === 'number' ||
        typeof updates.dayOfMonth === 'number' ||
        typeof updates.startAt === 'number',
    );

    if (shouldNormalizeRule) {
        const snapshot = await getDoc(docRef);
        if (snapshot.exists()) {
            const mergedRaw = {
                ...snapshot.data(),
                ...updates,
            } as Record<string, unknown>;
            const normalized = normalizeRecurringBill(billId, mergedRaw);
            payload.recurrenceRule = normalized.recurrenceRule;
            payload.startAt = normalized.startAt;
            if (typeof updates.nextDueAt !== 'number') {
                payload.nextDueAt = normalized.nextDueAt;
            }
        }
    }

    await updateDoc(docRef, payload);
};

/**
 * Delete a recurring bill
 */
export const deleteRecurringBill = async (billId: string): Promise<void> => {
    const docRef = doc(db, COLLECTION_NAME, billId);
    await deleteDoc(docRef);
};

/**
 * Toggle recurring bill active status
 */
export const toggleRecurringBillStatus = async (billId: string, isActive: boolean): Promise<void> => {
    await updateRecurringBill(billId, { isActive });
};

/**
 * Calculate the next due date based on frequency
 */
export const calculateNextDueDate = (bill: RecurringBill, fromDate: Date = new Date()): number => {
    const next = getNextDueAt(bill.recurrenceRule, bill.startAt, fromDate.getTime());
    return next ?? bill.nextDueAt;
};

/**
 * Check if a bill is due (should generate an expense)
 */
export const isBillDue = (bill: RecurringBill, now: Date = new Date()): boolean => {
    if (!bill.isActive) return false;
    if (bill.endAt && now.getTime() > bill.endAt) return false;
    return now.getTime() >= bill.nextDueAt;
};

/**
 * Generate expense data from a recurring bill.
 * Uses a deterministic expenseId and occurrence-based timestamps so that
 * both the Cloud Function backend and the client fallback produce identical
 * objects — making arrayUnion deduplication and set-with-merge idempotent.
 */
export const generateExpenseFromBill = (bill: RecurringBill, occurrenceAt: number): Expense => {
    return {
        expenseId: `rec_${bill.billId}_${occurrenceAt}`,
        groupId: bill.groupId,
        title: `${bill.title} (Recurring)`,
        category: bill.category,
        amount: bill.amount,
        paidBy: bill.paidBy,
        splitType: 'custom',
        participants: bill.participants,
        settled: false,
        notes: `Auto-generated from recurring bill (${new Date(occurrenceAt).toISOString().slice(0, 10)})`,
        recurring: {
            billId: bill.billId,
            occurrenceAt,
        },
        createdAt: occurrenceAt,
        updatedAt: occurrenceAt,
    };
};

/**
 * Trigger backend recurring-bill sync for a single group.
 * This keeps expenses up to date immediately when users open the app.
 */
export const syncRecurringBillsForGroup = async (groupId: string): Promise<number> => {
    const result = await triggerRecurringBillsForGroupCallable({ groupId });
    const generatedCount = result.data?.generatedCount;
    return typeof generatedCount === 'number' && Number.isFinite(generatedCount)
        ? generatedCount
        : 0;
};

let callableFailed = false;

/**
 * Sync recurring bills, falling back to client-side generation when Cloud Functions
 * is unavailable (e.g., local/dev without deployed callable).
 */
export const syncRecurringBillsForGroupWithFallback = async (
    groupId: string,
): Promise<number> => {
    if (callableFailed) {
        return processDueBills(groupId);
    }
    try {
        return await syncRecurringBillsForGroup(groupId);
    } catch (error) {
        const code = (error as { code?: string })?.code ?? '';
        if (code === 'not-found' || code === 'functions/not-found') {
            if (!callableFailed) {
                console.warn('Recurring bill Cloud Function not deployed. Using local fallback for this session.');
                callableFailed = true;
            }
        } else {
            console.warn('Recurring bill callable sync failed, using local fallback:', error);
        }
        return processDueBills(groupId);
    }
};

/**
 * Process all due recurring bills for a group.
 * Writes directly to Firestore in atomic batches — matching the Cloud Function
 * backend's write pattern so that both paths produce identical, idempotent results.
 */
export const processDueBills = async (
    groupId: string,
): Promise<number> => {
    const bills = await getRecurringBillsForGroup(groupId);
    const now = Date.now();
    let generatedCount = 0;

    for (const bill of bills) {
        if (!bill.isActive) continue;

        let currentDueAt = bill.nextDueAt;
        let generatedForBill = 0;
        let shouldDeactivate = false;
        let lastGeneratedAt = bill.lastGeneratedAt;
        const expensesToAdd: Expense[] = [];

        while (
            currentDueAt <= now &&
            generatedForBill < MAX_GENERATION_CATCH_UP &&
            (!bill.endAt || currentDueAt <= bill.endAt)
        ) {
            expensesToAdd.push(generateExpenseFromBill(bill, currentDueAt));
            lastGeneratedAt = currentDueAt;
            generatedForBill++;

            const nextDueAt = getNextDueAt(bill.recurrenceRule, bill.startAt, currentDueAt);
            if (!nextDueAt || nextDueAt <= currentDueAt) {
                shouldDeactivate = true;
                break;
            }
            currentDueAt = nextDueAt;
        }

        if (generatedForBill > 0) {
            const batch = writeBatch(db);
            const groupRef = doc(db, 'groups', groupId);

            batch.update(groupRef, {
                expenses: arrayUnion(...expensesToAdd),
                updatedAt: Date.now(),
            });

            for (const expense of expensesToAdd) {
                const topLevelRef = doc(db, 'expenses', expense.expenseId);
                batch.set(topLevelRef, expense, { merge: true });
            }

            const billRef = doc(db, COLLECTION_NAME, bill.billId);
            batch.update(billRef, {
                recurrenceRule: bill.recurrenceRule,
                startAt: bill.startAt,
                nextDueAt: currentDueAt,
                isActive: shouldDeactivate ? false : bill.isActive,
                lastGeneratedAt: lastGeneratedAt ?? null,
                updatedAt: Date.now(),
            });

            await batch.commit();
            generatedCount += generatedForBill;
        }
    }

    return generatedCount;
};
