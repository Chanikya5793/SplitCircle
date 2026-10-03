/**
 * Recurring Bills Service
 *
 * Handles creation, management, and automatic expense generation for recurring bills.
 */

import { app, db } from '@/firebase';
import type { Expense } from '@/models';
import type { ParticipantShare } from '@/models/expense';
import type { BillAmountMode, BillRotation, LegacyBillFrequency, RecurrenceRule, RecurringBill } from '@/models/recurringBill';
import {
    findNextOccurrenceAt,
    getNextDueAt,
    normalizeRecurrenceRule,
} from '@/utils/recurrence';
import {
    collection,
    doc,
    getDocs,
    query,
    where,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';

const COLLECTION_NAME = 'recurringBills';
const functions = getFunctions(app);

type TriggerRecurringBillsResponse = {
    generatedCount?: number;
};

const triggerRecurringBillsForGroupCallable = httpsCallable<{ groupId: string }, TriggerRecurringBillsResponse>(
    functions,
    'triggerRecurringBillsForGroup',
);

const confirmRecurringBillOccurrenceCallable = httpsCallable<
    { groupId: string; billId: string; occurrenceAt: number; amount: number; expectedCurrency: string },
    { expense: Expense; duplicate: boolean }
>(functions, 'confirmRecurringBillOccurrence');

type RecurringBillMutationInput =
    | {
        action: 'create';
        billId: string;
        groupId: string;
        expectedCurrency: string;
        bill: RecurringBillUpsertInput;
    }
    | {
        action: 'update';
        billId: string;
        groupId: string;
        expectedCurrency: string;
        updates: Partial<Omit<RecurringBill, 'billId' | 'createdAt'>>;
    }
    | {
        action: 'skip';
        billId: string;
        groupId: string;
        expectedCurrency: string;
        occurrenceAt: number;
    }
    | { action: 'delete'; billId: string; groupId: string };

const mutateRecurringBillCallable = httpsCallable<
    RecurringBillMutationInput,
    { success: true; duplicate: boolean; billId: string }
>(functions, 'mutateRecurringBill');

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

const normalizeRotation = (value: unknown): BillRotation | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as { order?: unknown; index?: unknown };
    const order = Array.isArray(raw.order) ? raw.order.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
    if (order.length < 2) return undefined; // A rotation of one is just paidBy.
    const index = typeof raw.index === 'number' && Number.isFinite(raw.index) ? Math.max(0, Math.trunc(raw.index)) : 0;
    return { order, index: index % order.length };
};

const normalizeOccurrenceList = (value: unknown): number[] => {
    if (!Array.isArray(value)) return [];
    return value
        .filter((ts): ts is number => typeof ts === 'number' && Number.isFinite(ts))
        .sort((a, b) => a - b);
};

/** Payer for the bill's NEXT generated occurrence (rotation-aware). */
export const resolveRotationPayer = (bill: Pick<RecurringBill, 'paidBy' | 'rotation'>): string => {
    const rotation = bill.rotation;
    if (!rotation || rotation.order.length === 0) return bill.paidBy;
    return rotation.order[rotation.index % rotation.order.length];
};

/**
 * Scale the bill's stored participant shares to a different total (variable
 * bills confirm a real amount each occurrence). Proportional, rounded to 2dp,
 * remainder credited to the first participant so the sum is exact.
 */
export const scaleShares = (
    participants: ParticipantShare[],
    fromTotal: number,
    toTotal: number,
): ParticipantShare[] => {
    if (participants.length === 0) return [];
    if (!Number.isFinite(toTotal) || toTotal <= 0 || fromTotal === toTotal) return participants;
    const scaled = fromTotal > 0
        ? participants.map((p) => ({
            ...p,
            share: Math.round((p.share / fromTotal) * toTotal * 100) / 100,
        }))
        // Degenerate stored total (e.g. variable bill saved with 0): equal split.
        : participants.map((p) => ({
            ...p,
            share: Math.round((toTotal / participants.length) * 100) / 100,
        }));
    const sum = scaled.reduce((acc, p) => acc + p.share, 0);
    const drift = Math.round((toTotal - sum) * 100) / 100;
    if (drift !== 0) {
        scaled[0] = { ...scaled[0], share: Math.round((scaled[0].share + drift) * 100) / 100 };
    }
    return scaled;
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
        amountMode: (rawData.amountMode === 'variable' ? 'variable' : 'fixed') as BillAmountMode,
        requiresAccept: rawData.requiresAccept === true,
        rotation: normalizeRotation(rawData.rotation),
        skippedOccurrences: normalizeOccurrenceList(rawData.skippedOccurrences),
        pendingOccurrences: normalizeOccurrenceList(rawData.pendingOccurrences),
        reminderSentFor: getValidTimestamp(rawData.reminderSentFor) ?? undefined,
        createdAt,
        updatedAt,
    };
};

/**
 * Create a new recurring bill
 */
export const createRecurringBill = async (
    bill: Omit<RecurringBillUpsertInput, 'createdAt' | 'updatedAt' | 'lastGeneratedAt'>,
    expectedCurrency: string,
): Promise<string> => {
    const now = Date.now();
    const startAt = getValidTimestamp(bill.startAt) ?? now;
    const recurrenceRule = bill.recurrenceRule
        ? normalizeRecurrenceRule(bill.recurrenceRule, startAt)
        : toLegacyRule(bill, startAt);
    const nextDueAt = getValidTimestamp(bill.nextDueAt) ?? findNextOccurrenceAt(recurrenceRule, startAt, startAt - 1) ?? startAt;

    const billId = doc(collection(db, COLLECTION_NAME)).id;
    const payload = {
        ...bill,
        recurrenceRule,
        startAt,
        nextDueAt,
        isActive: bill.isActive ?? true,
    };
    const response = await mutateRecurringBillCallable({
        action: 'create',
        billId,
        groupId: bill.groupId,
        expectedCurrency: expectedCurrency.toUpperCase(),
        bill: payload,
    });
    return response.data.billId;
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
    groupId: string,
    updates: Partial<Omit<RecurringBill, 'billId' | 'createdAt'>>,
    expectedCurrency: string,
): Promise<void> => {
    await mutateRecurringBillCallable({
        action: 'update',
        billId,
        groupId,
        expectedCurrency: expectedCurrency.toUpperCase(),
        updates,
    });
};

/**
 * Delete a recurring bill
 */
export const deleteRecurringBill = async (billId: string, groupId: string): Promise<void> => {
    await mutateRecurringBillCallable({ action: 'delete', billId, groupId });
};

/**
 * Toggle recurring bill active status
 */
export const toggleRecurringBillStatus = async (
    bill: Pick<RecurringBill, 'billId' | 'groupId'>,
    isActive: boolean,
    expectedCurrency: string,
): Promise<void> => {
    await updateRecurringBill(bill.billId, bill.groupId, { isActive }, expectedCurrency);
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

/** Deterministic id shared by every generation path (dedupe key — sacred). */
export const recurringExpenseId = (billId: string, occurrenceAt: number): string =>
    `rec_${billId}_${occurrenceAt}`;

/**
 * Generate expense data from a recurring bill.
 * Uses a deterministic expenseId and occurrence-based timestamps so that
 * both the Cloud Function backend and the client fallback produce identical
 * objects — making arrayUnion deduplication and set-with-merge idempotent.
 * The title carries NO decoration — recurrence is metadata (`expense.
 * recurring`) and renderers draw their own badge (ai_layer/docs/26).
 */
export const generateExpenseFromBill = (
    bill: RecurringBill,
    occurrenceAt: number,
    overrides?: { amount?: number; paidBy?: string },
): Expense => {
    const amount = overrides?.amount ?? bill.amount;
    const paidBy = overrides?.paidBy ?? resolveRotationPayer(bill);
    const participants = overrides?.amount !== undefined
        ? scaleShares(bill.participants, bill.amount, overrides.amount)
        : bill.participants;
    return {
        expenseId: recurringExpenseId(bill.billId, occurrenceAt),
        groupId: bill.groupId,
        title: bill.title,
        category: bill.category,
        amount,
        paidBy,
        splitType: 'custom',
        participants,
        splitMetadata: {
            version: 1,
            method: 'exact',
            participantConfig: participants.map((participant) => ({
                userId: participant.userId,
                included: true,
                exactAmount: participant.share,
                computedAmount: participant.share,
            })),
        },
        settled: false,
        recurring: {
            billId: bill.billId,
            occurrenceAt,
        },
        createdAt: occurrenceAt,
        updatedAt: occurrenceAt,
    };
};

/**
 * Confirm a variable bill's due occurrence with the real amount (doc 26).
 * Writes the SAME deterministic expense object both server/client generation
 * paths would (`rec_<billId>_<occurrenceAt>`), clears the pending marker, and
 * advances the rotation turn. Client UX gates callers to payer/admin; data
 * safety comes from the deterministic id (double-confirm converges on one
 * expense via set-with-merge + arrayUnion).
 *
 * Runs inside a transaction that RE-READS the bill instead of trusting the
 * caller's (possibly stale) `bill` argument: two chat cards confirming two
 * different pending occurrences on the same bill at nearly the same time
 * would otherwise both compute the same rotation turn/payer and the second
 * write to land would silently clobber the first's pendingOccurrences/rotation
 * update. Firestore retries a transaction whose read is invalidated by a
 * concurrent commit, so the second confirm here correctly sees the first
 * one's result and advances from there instead of repeating it.
 */
export const confirmVariableOccurrence = async (
    bill: RecurringBill,
    occurrenceAt: number,
    amount: number,
    expectedCurrency: string,
): Promise<Expense> => {
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('A positive amount is required to confirm this bill.');
    }

    const response = await confirmRecurringBillOccurrenceCallable({
        groupId: bill.groupId,
        billId: bill.billId,
        occurrenceAt,
        amount,
        expectedCurrency: expectedCurrency.toUpperCase(),
    });
    return response.data.expense;
};

/**
 * Skip the bill's next occurrence ("we were all traveling in June"): records
 * it in skippedOccurrences and advances nextDueAt. The rotation turn is NOT
 * consumed. Works for pending variable occurrences too (pass their timestamp).
 *
 * Re-reads the bill inside a transaction for the same reason as
 * confirmVariableOccurrence above — skipping one occurrence while a chat card
 * confirms a different one on the same bill must not clobber either write.
 */
export const skipOccurrence = async (
    bill: RecurringBill,
    occurrenceAt: number,
    expectedCurrency: string,
): Promise<void> => {
    await mutateRecurringBillCallable({
        action: 'skip',
        billId: bill.billId,
        groupId: bill.groupId,
        expectedCurrency: expectedCurrency.toUpperCase(),
        occurrenceAt,
    });
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
 * Sync recurring bills through the server. If the callable is unavailable,
 * leave state untouched so a client cannot bypass the financial-write boundary.
 */
export const syncRecurringBillsForGroupWithFallback = async (
    groupId: string,
): Promise<number> => {
    if (callableFailed) {
        return 0;
    }
    try {
        return await syncRecurringBillsForGroup(groupId);
    } catch (error) {
        const code = (error as { code?: string })?.code ?? '';
        if (code === 'not-found' || code === 'functions/not-found') {
            if (!callableFailed) {
                console.warn('Recurring bill Cloud Function is not deployed. Sync is paused for this session.');
                callableFailed = true;
            }
        } else {
            console.warn('Recurring bill callable sync failed; leaving recurring state unchanged:', error);
        }
        return 0;
    }
};
