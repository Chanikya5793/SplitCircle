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
const MAX_PENDING_OCCURRENCES = 6;
const REMINDER_LEAD_MS = 3 * 24 * 60 * 60 * 1000; // T-3 days, monthly+ bills only

type ParticipantShare = {
    userId: string;
    share: number;
};

type BillRotation = {
    order: string[];
    index: number;
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
    // ── v2 (ai_layer/docs/26) ──
    amountMode: "fixed" | "variable";
    requiresAccept: boolean;
    rotation?: BillRotation;
    skippedOccurrences: number[];
    pendingOccurrences: number[];
    reminderSentFor?: number;
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

    let rotation: BillRotation | undefined;
    if (raw.rotation && typeof raw.rotation === "object") {
        const rawRotation = raw.rotation as { order?: unknown; index?: unknown };
        const order = Array.isArray(rawRotation.order)
            ? rawRotation.order.filter((id): id is string => typeof id === "string" && id.length > 0)
            : [];
        if (order.length >= 2) {
            const index = typeof rawRotation.index === "number" && Number.isFinite(rawRotation.index)
                ? Math.max(0, Math.trunc(rawRotation.index)) % order.length
                : 0;
            rotation = { order, index };
        }
    }

    const toOccurrenceList = (value: unknown): number[] => Array.isArray(value)
        ? value.filter((ts): ts is number => typeof ts === "number" && Number.isFinite(ts)).sort((a, b) => a - b)
        : [];

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
        amountMode: raw.amountMode === "variable" ? "variable" : "fixed",
        requiresAccept: raw.requiresAccept === true,
        rotation,
        skippedOccurrences: toOccurrenceList(raw.skippedOccurrences),
        pendingOccurrences: toOccurrenceList(raw.pendingOccurrences),
        reminderSentFor: toNumber(raw.reminderSentFor) ?? undefined,
    };
};

// Title carries NO "(Recurring)" decoration — recurrence is metadata
// (`expense.recurring`); renderers draw their own badge (ai_layer/docs/26).
// MUST stay byte-compatible with the client fallback in
// src/services/recurringBillService.ts (arrayUnion dedupes on deep equality).
const buildRecurringExpense = (bill: RecurringBillRecord, occurrenceAt: number, paidBy: string) => {
    const expenseId = `rec_${bill.billId}_${occurrenceAt}`;
    return {
        expenseId,
        groupId: bill.groupId,
        title: bill.title,
        category: bill.category,
        amount: bill.amount,
        paidBy,
        splitType: "custom",
        participants: bill.participants,
        splitMetadata: {
            version: 1,
            method: "exact",
            participantConfig: bill.participants.map((participant) => ({
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

/** Payer for the given rotation slot; falls back to the fixed payer. */
const rotationPayerAt = (bill: RecurringBillRecord, index: number): string =>
    bill.rotation ? bill.rotation.order[index % bill.rotation.order.length] : bill.paidBy;

/** T-3 reminders only make sense for monthly-and-slower cadences (doc 26). */
const reminderLeadMs = (rule: RecurrenceRule): number =>
    rule.frequency === "monthly" || rule.frequency === "yearly" ? REMINDER_LEAD_MS : 0;

/**
 * Rotation-aware payer push. Fire-and-forget: reminder delivery must never
 * fail bill generation. Lazily imported to keep cold-start cost off the
 * callable path.
 */
const sendBillReminder = async (
    bill: RecurringBillRecord,
    payerId: string,
    body: string,
): Promise<void> => {
    try {
        const { sendPushToUsers } = await import("./notifications");
        await sendPushToUsers(
            [payerId],
            bill.title,
            body,
            { groupId: bill.groupId, billId: bill.billId, kind: "recurringBill" },
            "expenses",
        );
    } catch (error) {
        logger.warn("Recurring bill reminder push failed", { billId: bill.billId, error });
    }
};

const processBill = async (
    billRef: DocumentReference,
    bill: RecurringBillRecord,
    now: number,
): Promise<number> => {
    if (!bill.isActive) return 0;

    // Variable AND accept-gated (1:1 request) bills park instead of generating.
    const parksOccurrences = bill.amountMode === "variable" || bill.requiresAccept;
    const skipped = new Set(bill.skippedOccurrences);
    let currentDueAt = bill.nextDueAt;
    let processedCount = 0;
    let shouldDeactivate = false;
    let lastGeneratedAt = bill.lastGeneratedAt;
    let rotationIndex = bill.rotation?.index ?? 0;
    const pending = [...bill.pendingOccurrences];
    const newlyPending: number[] = [];
    const expensesToAdd: ReturnType<typeof buildRecurringExpense>[] = [];

    while (
        currentDueAt <= now &&
        processedCount < MAX_OCCURRENCES_PER_RUN &&
        (!bill.endAt || currentDueAt <= bill.endAt)
    ) {
        if (skipped.has(currentDueAt)) {
            // Explicitly skipped: no expense, no rotation turn consumed.
        } else if (parksOccurrences) {
            if (!pending.includes(currentDueAt)) {
                pending.push(currentDueAt);
                newlyPending.push(currentDueAt);
            }
        } else {
            expensesToAdd.push(buildRecurringExpense(bill, currentDueAt, rotationPayerAt(bill, rotationIndex)));
            lastGeneratedAt = currentDueAt;
            if (bill.rotation) rotationIndex = (rotationIndex + 1) % bill.rotation.order.length;
        }
        processedCount += 1;

        const next = findNextOccurrenceAt(bill.recurrenceRule, bill.startAt, currentDueAt);
        if (!next || next <= currentDueAt) {
            shouldDeactivate = true;
            break;
        }
        currentDueAt = next;
    }

    // T-3 upcoming reminder for the (possibly advanced) next occurrence —
    // idempotent via reminderSentFor, rotation-aware, monthly+ only.
    const leadMs = reminderLeadMs(bill.recurrenceRule);
    const upcomingDueAt = processedCount > 0 ? currentDueAt : bill.nextDueAt;
    const shouldRemind =
        !shouldDeactivate &&
        leadMs > 0 &&
        upcomingDueAt > now &&
        upcomingDueAt - now <= leadMs &&
        bill.reminderSentFor !== upcomingDueAt &&
        (!bill.endAt || upcomingDueAt <= bill.endAt);

    if (processedCount === 0 && !shouldRemind) {
        return 0;
    }

    const db = getFirestore();
    const batch = db.batch();

    if (expensesToAdd.length > 0) {
        const groupRef = db.collection(GROUPS_COLLECTION).doc(bill.groupId);
        batch.update(groupRef, {
            expenses: FieldValue.arrayUnion(...expensesToAdd),
            updatedAt: Date.now(),
        });
        expensesToAdd.forEach((expense) => {
            const topLevelExpenseRef = db.collection(EXPENSES_COLLECTION).doc(expense.expenseId);
            batch.set(topLevelExpenseRef, expense, { merge: true });
        });
    }

    // Cap pendingOccurrences at MAX_PENDING_OCCURRENCES (oldest first out),
    // but the ones truncated off must land in skippedOccurrences — otherwise
    // they vanish with no expense, no skip record, and (since nextDueAt has
    // already moved past them) no way to ever confirm or regenerate them.
    // Mirrors the client fallback's identical fix in recurringBillService.ts.
    const sortedPending = pending.sort((a, b) => a - b);
    const keptPending = sortedPending.slice(-MAX_PENDING_OCCURRENCES);
    const droppedPending = sortedPending.slice(0, -MAX_PENDING_OCCURRENCES);

    batch.update(billRef, {
        recurrenceRule: bill.recurrenceRule,
        startAt: bill.startAt,
        nextDueAt: processedCount > 0 ? currentDueAt : bill.nextDueAt,
        isActive: shouldDeactivate ? false : bill.isActive,
        lastGeneratedAt: lastGeneratedAt ?? null,
        pendingOccurrences: keptPending,
        ...(droppedPending.length > 0
            ? { skippedOccurrences: [...new Set([...bill.skippedOccurrences, ...droppedPending])].sort((a, b) => a - b) }
            : {}),
        ...(bill.rotation ? { rotation: { order: bill.rotation.order, index: rotationIndex } } : {}),
        ...(shouldRemind ? { reminderSentFor: upcomingDueAt } : {}),
        updatedAt: Date.now(),
    });

    await batch.commit();

    if (shouldRemind) {
        const payerId = rotationPayerAt(bill, rotationIndex);
        const dueDate = new Date(upcomingDueAt).toISOString().slice(0, 10);
        await sendBillReminder(bill, payerId, `Due ${dueDate} — your turn to pay.`);
    }
    if (newlyPending.length > 0) {
        if (bill.requiresAccept) {
            // 1:1 request: consent comes from the counterparty (non-payer).
            const payerId = rotationPayerAt(bill, rotationIndex);
            const counterparty = bill.participants.find((p) => p.userId !== payerId);
            if (counterparty) {
                await sendBillReminder(bill, counterparty.userId, "Recurring request due — accept it in the chat to add it.");
            }
        } else {
            const payerId = rotationPayerAt(bill, rotationIndex);
            await sendBillReminder(bill, payerId, "Bill is due — enter this month's amount to split it.");
        }
    }

    return expensesToAdd.length;
};

const queryBills = async (groupId?: string) => {
    const db = getFirestore();
    const ref = db.collection(RECURRING_BILLS_COLLECTION);
    if (groupId) {
        return ref.where("groupId", "==", groupId).where("isActive", "==", true).get();
    }
    // Only scan active bills — inactive ones are permanently skipped anyway.
    return ref.where("isActive", "==", true).get();
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
