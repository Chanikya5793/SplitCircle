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
/** Variable bills: due occurrences kept awaiting an amount. Oldest drop off. */
const MAX_PENDING_OCCURRENCES = 6;
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
 */
export const confirmVariableOccurrence = async (
    bill: RecurringBill,
    occurrenceAt: number,
    amount: number,
): Promise<Expense> => {
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('A positive amount is required to confirm this bill.');
    }
    const paidBy = resolveRotationPayer(bill);
    const expense = generateExpenseFromBill(bill, occurrenceAt, { amount, paidBy });

    const batch = writeBatch(db);
    const groupRef = doc(db, 'groups', bill.groupId);
    batch.update(groupRef, {
        expenses: arrayUnion(expense),
        updatedAt: Date.now(),
    });
    batch.set(doc(db, 'expenses', expense.expenseId), expense, { merge: true });
    batch.update(doc(db, COLLECTION_NAME, bill.billId), {
        pendingOccurrences: (bill.pendingOccurrences ?? []).filter((ts) => ts !== occurrenceAt),
        lastGeneratedAt: occurrenceAt,
        ...(bill.rotation
            ? { rotation: { order: bill.rotation.order, index: (bill.rotation.index + 1) % bill.rotation.order.length } }
            : {}),
        updatedAt: Date.now(),
    });
    await batch.commit();
    return expense;
};

/**
 * Skip the bill's next occurrence ("we were all traveling in June"): records
 * it in skippedOccurrences and advances nextDueAt. The rotation turn is NOT
 * consumed. Works for pending variable occurrences too (pass their timestamp).
 */
export const skipOccurrence = async (bill: RecurringBill, occurrenceAt: number): Promise<void> => {
    const updates: Record<string, unknown> = {
        skippedOccurrences: [...new Set([...(bill.skippedOccurrences ?? []), occurrenceAt])].sort((a, b) => a - b),
        pendingOccurrences: (bill.pendingOccurrences ?? []).filter((ts) => ts !== occurrenceAt),
        updatedAt: Date.now(),
    };
    if (occurrenceAt === bill.nextDueAt) {
        const next = getNextDueAt(bill.recurrenceRule, bill.startAt, occurrenceAt);
        if (next) updates.nextDueAt = next;
        else updates.isActive = false;
    }
    await updateDoc(doc(db, COLLECTION_NAME, bill.billId), updates);
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

        // Variable AND accept-gated bills both park instead of generating —
        // the amount (variable) or the consent (1:1 request) arrives later.
        const parksOccurrences = bill.amountMode === 'variable' || bill.requiresAccept === true;
        const skipped = new Set(bill.skippedOccurrences ?? []);
        let currentDueAt = bill.nextDueAt;
        let processedForBill = 0;
        let shouldDeactivate = false;
        let lastGeneratedAt = bill.lastGeneratedAt;
        let rotationIndex = bill.rotation?.index ?? 0;
        const pending = [...(bill.pendingOccurrences ?? [])];
        const expensesToAdd: Expense[] = [];

        while (
            currentDueAt <= now &&
            processedForBill < MAX_GENERATION_CATCH_UP &&
            (!bill.endAt || currentDueAt <= bill.endAt)
        ) {
            if (skipped.has(currentDueAt)) {
                // Explicitly skipped: no expense, no rotation turn consumed.
            } else if (parksOccurrences) {
                if (!pending.includes(currentDueAt)) pending.push(currentDueAt);
            } else {
                const paidBy = bill.rotation
                    ? bill.rotation.order[rotationIndex % bill.rotation.order.length]
                    : bill.paidBy;
                expensesToAdd.push(generateExpenseFromBill(bill, currentDueAt, { paidBy }));
                lastGeneratedAt = currentDueAt;
                if (bill.rotation) rotationIndex = (rotationIndex + 1) % bill.rotation.order.length;
            }
            processedForBill++;

            const nextDueAt = getNextDueAt(bill.recurrenceRule, bill.startAt, currentDueAt);
            if (!nextDueAt || nextDueAt <= currentDueAt) {
                shouldDeactivate = true;
                break;
            }
            currentDueAt = nextDueAt;
        }

        if (processedForBill > 0) {
            const batch = writeBatch(db);
            const billRef = doc(db, COLLECTION_NAME, bill.billId);

            if (expensesToAdd.length > 0) {
                const groupRef = doc(db, 'groups', groupId);
                batch.update(groupRef, {
                    expenses: arrayUnion(...expensesToAdd),
                    updatedAt: Date.now(),
                });
                for (const expense of expensesToAdd) {
                    const topLevelRef = doc(db, 'expenses', expense.expenseId);
                    batch.set(topLevelRef, expense, { merge: true });
                }
            }

            batch.update(billRef, {
                recurrenceRule: bill.recurrenceRule,
                startAt: bill.startAt,
                nextDueAt: currentDueAt,
                isActive: shouldDeactivate ? false : bill.isActive,
                lastGeneratedAt: lastGeneratedAt ?? null,
                pendingOccurrences: pending.sort((a, b) => a - b).slice(-MAX_PENDING_OCCURRENCES),
                ...(bill.rotation ? { rotation: { order: bill.rotation.order, index: rotationIndex } } : {}),
                updatedAt: Date.now(),
            });

            await batch.commit();
            generatedCount += expensesToAdd.length;
        }
    }

    return generatedCount;
};
