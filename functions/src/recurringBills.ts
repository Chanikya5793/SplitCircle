import { FieldValue, getFirestore, type DocumentReference } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {
    findNextOccurrenceAt,
    normalizeRecurrenceRule,
    toLegacyRecurrenceRule,
    type LegacyBillFrequency,
    type RecurrenceRule,
} from "./recurrence";

const RECURRING_BILLS_COLLECTION = "recurringBills";
const GROUPS_COLLECTION = "groups";
const EXPENSES_COLLECTION = "expenses";
const MAX_OCCURRENCES_PER_RUN = 64;

type ParticipantShare = {
    userId: string;
    share: number;
};

type RecurringBillRecord = {
    billId: string;
    groupId: string;
    title: string;
    amount: number;
    category: string;
    paidBy: string;
    participants: ParticipantShare[];
    recurrenceRule: RecurrenceRule;
    startAt: number;
    endAt?: number;
    isActive: boolean;
    lastGeneratedAt?: number;
    nextDueAt: number;
    dayOfMonth?: number;
    dayOfWeek?: number;
    frequency?: LegacyBillFrequency;
};

type ProcessResult = {
    generatedExpenses: number;
    processedBills: number;
    scannedBills: number;
};

const toNumber = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "object" && value !== null) {
        const maybeTimestamp = value as { toMillis?: () => number; seconds?: number };
        if (typeof maybeTimestamp.toMillis === "function") return maybeTimestamp.toMillis();
        if (typeof maybeTimestamp.seconds === "number") return maybeTimestamp.seconds * 1000;
    }
    return null;
};

const toStringValue = (value: unknown): string => {
    return typeof value === "string" ? value.trim() : "";
};

const toParticipantShares = (value: unknown): ParticipantShare[] => {
    if (!Array.isArray(value)) return [];
    const payload: ParticipantShare[] = [];
    value.forEach((entry) => {
        if (!entry || typeof entry !== "object") return;
        const data = entry as { userId?: unknown; share?: unknown };
        if (typeof data.userId !== "string") return;
        if (typeof data.share !== "number" || !Number.isFinite(data.share)) return;
        payload.push({ userId: data.userId, share: data.share });
    });
    return payload;
};

const normalizeRecurringBill = (billId: string, raw: Record<string, unknown>): RecurringBillRecord | null => {
    const groupId = toStringValue(raw.groupId);
    const title = toStringValue(raw.title);
    const category = toStringValue(raw.category);
    const paidBy = toStringValue(raw.paidBy);
    const amount = typeof raw.amount === "number" && Number.isFinite(raw.amount) ? raw.amount : 0;
    const participants = toParticipantShares(raw.participants);

    if (!groupId || !title || !category || !paidBy || amount <= 0 || participants.length === 0) {
        return null;
    }

    const createdAt = toNumber(raw.createdAt) ?? Date.now();
    const startAt = toNumber(raw.startAt) ?? toNumber(raw.nextDueAt) ?? createdAt;
    const recurrenceRule = (raw.recurrenceRule && typeof raw.recurrenceRule === "object")
        ? normalizeRecurrenceRule(raw.recurrenceRule as Partial<RecurrenceRule>, startAt)
        : toLegacyRecurrenceRule(
            raw.frequency as LegacyBillFrequency | undefined,
            typeof raw.dayOfWeek === "number" ? raw.dayOfWeek : undefined,
            typeof raw.dayOfMonth === "number" ? raw.dayOfMonth : undefined,
            startAt,
        );

    const nextDueAt = toNumber(raw.nextDueAt) ?? findNextOccurrenceAt(recurrenceRule, startAt, startAt - 1) ?? startAt;
    const endAt = toNumber(raw.endAt) ?? undefined;
    const lastGeneratedAt = toNumber(raw.lastGeneratedAt) ?? undefined;
    const isActive = raw.isActive !== false;

    return {
        billId,
        groupId,
        title,
        amount,
        category,
        paidBy,
        participants,
        recurrenceRule,
        startAt,
        endAt,
        isActive,
        lastGeneratedAt,
        nextDueAt,
        dayOfMonth: typeof raw.dayOfMonth === "number" ? raw.dayOfMonth : undefined,
        dayOfWeek: typeof raw.dayOfWeek === "number" ? raw.dayOfWeek : undefined,
        frequency: raw.frequency as LegacyBillFrequency | undefined,
    };
};

const buildRecurringExpense = (bill: RecurringBillRecord, occurrenceAt: number) => {
    const expenseId = `rec_${bill.billId}_${occurrenceAt}`;
    return {
        expenseId,
        groupId: bill.groupId,
        title: `${bill.title} (Recurring)`,
        category: bill.category,
        amount: bill.amount,
        paidBy: bill.paidBy,
        splitType: "custom",
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

const processBill = async (
    billRef: DocumentReference,
    bill: RecurringBillRecord,
    now: number,
): Promise<number> => {
    if (!bill.isActive) return 0;

    let currentDueAt = bill.nextDueAt;
    let generatedCount = 0;
    let shouldDeactivate = false;
    let lastGeneratedAt = bill.lastGeneratedAt;
    const expensesToAdd: ReturnType<typeof buildRecurringExpense>[] = [];

    while (
        currentDueAt <= now &&
        generatedCount < MAX_OCCURRENCES_PER_RUN &&
        (!bill.endAt || currentDueAt <= bill.endAt)
    ) {
        expensesToAdd.push(buildRecurringExpense(bill, currentDueAt));
        lastGeneratedAt = currentDueAt;
        generatedCount += 1;

        const next = findNextOccurrenceAt(bill.recurrenceRule, bill.startAt, currentDueAt);
        if (!next || next <= currentDueAt) {
            shouldDeactivate = true;
            break;
        }
        currentDueAt = next;
    }

    if (generatedCount === 0) {
        return 0;
    }

    const db = getFirestore();
    const batch = db.batch();
    const groupRef = db.collection(GROUPS_COLLECTION).doc(bill.groupId);

    batch.update(groupRef, {
        expenses: FieldValue.arrayUnion(...expensesToAdd),
        updatedAt: Date.now(),
    });

    expensesToAdd.forEach((expense) => {
        const topLevelExpenseRef = db.collection(EXPENSES_COLLECTION).doc(expense.expenseId);
        batch.set(topLevelExpenseRef, expense, { merge: true });
    });

    batch.update(billRef, {
        recurrenceRule: bill.recurrenceRule,
        startAt: bill.startAt,
        nextDueAt: currentDueAt,
        isActive: shouldDeactivate ? false : bill.isActive,
        lastGeneratedAt: lastGeneratedAt ?? null,
        updatedAt: Date.now(),
    });

    await batch.commit();
    return generatedCount;
};

const queryBills = async (groupId?: string) => {
    const db = getFirestore();
    const ref = db.collection(RECURRING_BILLS_COLLECTION);
    if (groupId) {
        return ref.where("groupId", "==", groupId).get();
    }
    return ref.get();
};

const processQueryResult = async (
    querySnapshot: FirebaseFirestore.QuerySnapshot,
    now: number,
): Promise<ProcessResult> => {
    let generatedExpenses = 0;
    let processedBills = 0;
    let scannedBills = 0;

    for (const doc of querySnapshot.docs) {
        scannedBills += 1;
        const normalized = normalizeRecurringBill(doc.id, doc.data());
        if (!normalized) {
            logger.warn("Skipping invalid recurring bill document", { billId: doc.id });
            continue;
        }
        if (!normalized.isActive) continue;

        const generated = await processBill(doc.ref, normalized, now);
        if (generated > 0) {
            processedBills += 1;
            generatedExpenses += generated;
        }
    }

    return {
        generatedExpenses,
        processedBills,
        scannedBills,
    };
};

export const processAllDueRecurringBills = async (): Promise<ProcessResult> => {
    const now = Date.now();
    const snapshot = await queryBills();
    return processQueryResult(snapshot, now);
};

export const processGroupDueRecurringBills = async (groupId: string): Promise<ProcessResult> => {
    const now = Date.now();
    const snapshot = await queryBills(groupId);
    return processQueryResult(snapshot, now);
};
