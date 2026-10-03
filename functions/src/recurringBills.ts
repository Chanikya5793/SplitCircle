import { FieldValue, getFirestore, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { HttpsError } from "firebase-functions/v2/https";
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

const scaleParticipantShares = (
    participants: ParticipantShare[],
    fromTotal: number,
    toTotal: number,
): ParticipantShare[] => {
    if (participants.length === 0 || fromTotal === toTotal) return participants;
    const scaled = fromTotal > 0
        ? participants.map((participant) => ({
            ...participant,
            share: Math.round((participant.share / fromTotal) * toTotal * 100) / 100,
        }))
        : participants.map((participant) => ({
            ...participant,
            share: Math.round((toTotal / participants.length) * 100) / 100,
        }));
    const total = scaled.reduce((sum, participant) => sum + participant.share, 0);
    const remainder = Math.round((toTotal - total) * 100) / 100;
    if (remainder !== 0) {
        scaled[0] = {
            ...scaled[0],
            share: Math.round((scaled[0].share + remainder) * 100) / 100,
        };
    }
    return scaled;
};

/**
 * Confirms a pending variable bill or 1:1 recurring request. This is server
 * owned because group expense arrays are no longer client writable.
 */
export async function confirmRecurringBillOccurrence(params: {
    uid: string;
    groupId: string;
    billId: string;
    occurrenceAt: number;
    amount: number;
    expectedCurrency: string;
    db?: Firestore;
}): Promise<{ expense: ReturnType<typeof buildRecurringExpense>; duplicate: boolean }> {
    if (!Number.isFinite(params.occurrenceAt) || params.occurrenceAt <= 0 ||
        !Number.isFinite(params.amount) || params.amount <= 0 || params.amount > 1_000_000_000) {
        throw new HttpsError("invalid-argument", "A valid occurrence and positive amount are required.");
    }
    const db = params.db ?? getFirestore();
    const billRef = db.collection(RECURRING_BILLS_COLLECTION).doc(params.billId);
    const groupRef = db.collection(GROUPS_COLLECTION).doc(params.groupId);
    const expenseId = `rec_${params.billId}_${params.occurrenceAt}`;
    const expenseRef = db.collection(EXPENSES_COLLECTION).doc(expenseId);

    return db.runTransaction(async (transaction) => {
        const [billSnapshot, groupSnapshot, expenseSnapshot] = await Promise.all([
            transaction.get(billRef),
            transaction.get(groupRef),
            transaction.get(expenseRef),
        ]);
        if (!billSnapshot.exists) throw new HttpsError("not-found", "Recurring bill not found.");
        if (!groupSnapshot.exists) throw new HttpsError("not-found", "Group not found.");
        const bill = normalizeRecurringBill(params.billId, billSnapshot.data() as Record<string, unknown>);
        if (!bill || bill.groupId !== params.groupId) {
            throw new HttpsError("failed-precondition", "Recurring bill is invalid or belongs to another group.");
        }
        const group = groupSnapshot.data() ?? {};
        const memberIds = Array.isArray(group.memberIds) ? group.memberIds as unknown[] : [];
        if (!memberIds.includes(params.uid)) {
            throw new HttpsError("permission-denied", "You are not a member of this group.");
        }

        const paidBy = rotationPayerAt(bill, bill.rotation?.index ?? 0);
        const members = Array.isArray(group.members) ? group.members as Array<Record<string, unknown>> : [];
        const callerRole = members.find((member) => member.userId === params.uid)?.role;
        const mayConfirm = bill.requiresAccept
            ? params.uid !== paidBy && bill.participants.some((participant) => participant.userId === params.uid)
            : params.uid === paidBy || callerRole === "owner" || callerRole === "admin";
        if (!mayConfirm) {
            throw new HttpsError("permission-denied", "You cannot confirm this recurring occurrence.");
        }

        const expense = buildRecurringExpense({ ...bill, amount: params.amount }, params.occurrenceAt, paidBy);
        const groupExpenses = Array.isArray(group.expenses)
            ? group.expenses.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
            : [];
        const existing = groupExpenses.find((value) => value.expenseId === expenseId);
        if (existing || expenseSnapshot.exists) {
            return {
                expense: (existing ?? expenseSnapshot.data() ?? expense) as ReturnType<typeof buildRecurringExpense>,
                duplicate: true,
            };
        }
        const groupCurrency = typeof group.currency === "string" ? group.currency.trim().toUpperCase() : "";
        if (groupCurrency !== params.expectedCurrency.trim().toUpperCase()) {
            throw new HttpsError("aborted", "This group's currency changed on another device. Refresh and try again.", {
                reasonCode: "STALE_GROUP_CURRENCY",
            });
        }
        if (!bill.pendingOccurrences.includes(params.occurrenceAt)) {
            throw new HttpsError("failed-precondition", "This occurrence is not waiting for confirmation.");
        }

        const effectiveAmount = bill.requiresAccept && bill.amountMode !== "variable"
            ? bill.amount
            : params.amount;
        const participants = scaleParticipantShares(bill.participants, bill.amount, effectiveAmount);
        const confirmedExpense = buildRecurringExpense(
            { ...bill, amount: effectiveAmount, participants },
            params.occurrenceAt,
            paidBy,
        );

        transaction.update(groupRef, {
            expenses: [...groupExpenses, confirmedExpense],
            updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.create(expenseRef, confirmedExpense);
        transaction.update(billRef, {
            pendingOccurrences: bill.pendingOccurrences.filter((value) => value !== params.occurrenceAt),
            lastGeneratedAt: params.occurrenceAt,
            ...(bill.rotation
                ? {
                    rotation: {
                        order: bill.rotation.order,
                        index: (bill.rotation.index + 1) % bill.rotation.order.length,
                    },
                }
                : {}),
            updatedAt: Date.now(),
        });
        return { expense: confirmedExpense, duplicate: false };
    });
}

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
    expectedGroupId: string,
    now: number,
    db: Firestore,
): Promise<number> => {
    const groupRef = db.collection(GROUPS_COLLECTION).doc(expectedGroupId);
    const outcome = await db.runTransaction(async (transaction) => {
        // Currency conversion locks the group before its recurring bills. Use
        // the same order here so generation cannot deadlock with conversion.
        // The scheduler query remains only a work list: both documents are
        // re-read and the bill/group binding is validated transactionally.
        const groupSnapshot = await transaction.get(groupRef);
        if (!groupSnapshot.exists) return null;
        const billSnapshot = await transaction.get(billRef);
        if (!billSnapshot.exists) return null;
        const bill = normalizeRecurringBill(billRef.id, billSnapshot.data() as Record<string, unknown>);
        if (!bill || !bill.isActive || bill.groupId !== expectedGroupId) return null;
        const group = groupSnapshot.data() ?? {};

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
        const plannedExpenses: ReturnType<typeof buildRecurringExpense>[] = [];

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
                plannedExpenses.push(buildRecurringExpense(
                    bill,
                    currentDueAt,
                    rotationPayerAt(bill, rotationIndex),
                ));
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

        const leadMs = reminderLeadMs(bill.recurrenceRule);
        const upcomingDueAt = processedCount > 0 ? currentDueAt : bill.nextDueAt;
        const shouldRemind =
            !shouldDeactivate &&
            leadMs > 0 &&
            upcomingDueAt > now &&
            upcomingDueAt - now <= leadMs &&
            bill.reminderSentFor !== upcomingDueAt &&
            (!bill.endAt || upcomingDueAt <= bill.endAt);
        if (processedCount === 0 && !shouldRemind) return null;

        const groupExpenses = Array.isArray(group.expenses)
            ? group.expenses.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
            : [];
        const existingExpenseIds = new Set(groupExpenses
            .map((value) => value.expenseId)
            .filter((value): value is string => typeof value === "string"));
        const expensesToAdd = plannedExpenses.filter((expense) => !existingExpenseIds.has(expense.expenseId));
        if (expensesToAdd.length > 0) {
            transaction.update(groupRef, {
                expenses: [...groupExpenses, ...expensesToAdd],
                updatedAt: FieldValue.serverTimestamp(),
            });
            expensesToAdd.forEach((expense) => {
                transaction.set(db.collection(EXPENSES_COLLECTION).doc(expense.expenseId), expense, { merge: false });
            });
        }

        // Cap pending occurrences and record dropped entries as skipped so no
        // due occurrence silently disappears.
        const sortedPending = pending.sort((a, b) => a - b);
        const keptPending = sortedPending.slice(-MAX_PENDING_OCCURRENCES);
        const droppedPending = sortedPending.slice(0, -MAX_PENDING_OCCURRENCES);
        transaction.update(billRef, {
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
            updatedAt: now,
        });
        return {
            bill,
            generated: expensesToAdd.length,
            newlyPending,
            rotationIndex,
            shouldRemind,
            upcomingDueAt,
        };
    });

    if (!outcome) return 0;
    if (outcome.shouldRemind) {
        const payerId = rotationPayerAt(outcome.bill, outcome.rotationIndex);
        const dueDate = new Date(outcome.upcomingDueAt).toISOString().slice(0, 10);
        await sendBillReminder(outcome.bill, payerId, `Due ${dueDate} — your turn to pay.`);
    }
    if (outcome.newlyPending.length > 0) {
        if (outcome.bill.requiresAccept) {
            // 1:1 request: consent comes from the counterparty (non-payer).
            const payerId = rotationPayerAt(outcome.bill, outcome.rotationIndex);
            const counterparty = outcome.bill.participants.find((p) => p.userId !== payerId);
            if (counterparty) {
                await sendBillReminder(outcome.bill, counterparty.userId, "Recurring request due — accept it in the chat to add it.");
            }
        } else {
            const payerId = rotationPayerAt(outcome.bill, outcome.rotationIndex);
            await sendBillReminder(outcome.bill, payerId, "Bill is due — enter this month's amount to split it.");
        }
    }
    return outcome.generated;
};

const queryBills = async (groupId: string | undefined, db: Firestore) => {
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
    db: Firestore,
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

        const generated = await processBill(doc.ref, normalized.groupId, now, db);
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

export const processAllDueRecurringBills = async (options?: {
    now?: number;
    db?: Firestore;
}): Promise<ProcessResult> => {
    const now = options?.now ?? Date.now();
    const db = options?.db ?? getFirestore();
    const snapshot = await queryBills(undefined, db);
    return processQueryResult(snapshot, now, db);
};

export const processGroupDueRecurringBills = async (groupId: string, options?: {
    now?: number;
    db?: Firestore;
}): Promise<ProcessResult> => {
    const now = options?.now ?? Date.now();
    const db = options?.db ?? getFirestore();
    const snapshot = await queryBills(groupId, db);
    return processQueryResult(snapshot, now, db);
};
