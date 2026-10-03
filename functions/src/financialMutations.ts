import {
    FieldValue,
    getFirestore,
    type DocumentData,
    type Firestore,
} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { z } from "zod";
import {
    findNextOccurrenceAt,
    normalizeRecurrenceRule,
    toLegacyRecurrenceRule,
    type LegacyBillFrequency,
    type RecurrenceRule,
} from "./recurrence";

const IDENTIFIER = /^[A-Za-z0-9_.:@-]{1,180}$/;
const finiteNumber = z.number().finite();
const identifier = z.string().trim().regex(IDENTIFIER);
const currencyCode = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const timestamp = finiteNumber.nonnegative();

const expectationSchema = z.object({
    expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    expectedUpdatedAt: timestamp.optional(),
}).strict().refine(
    (value) => value.expectedRevision !== undefined || value.expectedUpdatedAt !== undefined,
    "A revision or timestamp is required.",
);

const settlementSchema = z.object({
    settlementId: identifier,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    requestId: identifier.optional(),
    fromUserId: identifier,
    toUserId: identifier,
    amount: finiteNumber.positive().max(1_000_000_000),
    createdAt: timestamp,
    updatedAt: timestamp.optional(),
    note: z.string().max(5_000).optional(),
    status: z.enum(["pending", "completed"]),
}).strict();

const settlementMutationSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("create"),
        groupId: identifier,
        expectedCurrency: currencyCode,
        settlement: settlementSchema,
    }).strict(),
    z.object({
        action: z.literal("update"),
        groupId: identifier,
        expectedCurrency: currencyCode,
        settlement: settlementSchema,
        expectation: expectationSchema,
    }).strict(),
    z.object({
        action: z.literal("delete"),
        groupId: identifier,
        settlementId: identifier,
        expectation: expectationSchema,
    }).strict(),
]);

const participantShareSchema = z.object({
    userId: identifier,
    share: finiteNumber.nonnegative().max(1_000_000_000),
}).strict();

const recurrenceRuleSchema = z.object({
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(10_000),
    monthlyPattern: z.enum(["dayOfMonth", "weekdaysOfMonth"]).optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    daysOfMonth: z.array(z.number().int().min(1).max(31)).max(31).optional(),
    weeksOfMonth: z.array(z.number().int().min(1).max(5)).max(5).optional(),
    monthsOfYear: z.array(z.number().int().min(1).max(12)).max(12).optional(),
    timezoneOffsetMinutes: z.number().int().min(-1_440).max(1_440).optional(),
}).strict();

const rotationSchema = z.object({
    order: z.array(identifier).min(2).max(200),
    index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

const recurringBillCreateSchema = z.object({
    groupId: identifier,
    title: z.string().trim().min(1).max(300),
    amount: finiteNumber.positive().max(1_000_000_000),
    category: z.string().trim().min(1).max(120),
    paidBy: identifier,
    participants: z.array(participantShareSchema).min(1).max(200),
    recurrenceRule: recurrenceRuleSchema.optional(),
    startAt: timestamp,
    endAt: timestamp.optional(),
    amountMode: z.enum(["fixed", "variable"]).optional(),
    requiresAccept: z.boolean().optional(),
    rotation: rotationSchema.optional(),
    frequency: z.enum(["daily", "weekly", "biweekly", "monthly", "yearly"]).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    isActive: z.boolean(),
    nextDueAt: timestamp,
}).strict();

const recurringBillUpdateSchema = recurringBillCreateSchema
    .omit({ groupId: true })
    .partial()
    .extend({ rotation: rotationSchema.nullable().optional() })
    .strict()
    .refine((value) => Object.keys(value).length > 0, "At least one update is required.");

const recurringBillMutationSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("create"),
        billId: identifier,
        groupId: identifier,
        expectedCurrency: currencyCode,
        bill: recurringBillCreateSchema,
    }).strict(),
    z.object({
        action: z.literal("update"),
        billId: identifier,
        groupId: identifier,
        expectedCurrency: currencyCode,
        updates: recurringBillUpdateSchema,
    }).strict(),
    z.object({
        action: z.literal("skip"),
        billId: identifier,
        groupId: identifier,
        expectedCurrency: currencyCode,
        occurrenceAt: timestamp,
    }).strict(),
    z.object({
        action: z.literal("delete"),
        billId: identifier,
        groupId: identifier,
    }).strict(),
]);

export type SettlementMutationInput = z.infer<typeof settlementMutationSchema>;
export type RecurringBillMutationInput = z.infer<typeof recurringBillMutationSchema>;

function storedCurrency(group: DocumentData): string {
    return typeof group.currency === "string" ? group.currency.trim().toUpperCase() : "";
}

function assertExpectedCurrency(group: DocumentData, expectedCurrency: string): void {
    if (storedCurrency(group) !== expectedCurrency) {
        throw new HttpsError("aborted", "This group's currency changed on another device. Refresh and try again.", {
            reasonCode: "STALE_GROUP_CURRENCY",
        });
    }
}

function currentRevision(value: unknown): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

function currentTimestamp(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value && typeof value === "object" && "toMillis" in value &&
        typeof (value as { toMillis?: unknown }).toMillis === "function") {
        return (value as { toMillis: () => number }).toMillis();
    }
    return null;
}

function assertExpectation(
    current: DocumentData,
    expectation: z.infer<typeof expectationSchema>,
    entity: "settlement" | "recurring bill",
): void {
    const stale = expectation.expectedRevision !== undefined
        ? currentRevision(current.revision) !== expectation.expectedRevision
        : currentTimestamp(current.updatedAt) !== expectation.expectedUpdatedAt;
    if (stale) {
        throw new HttpsError("aborted", `This ${entity} changed on another device. Refresh and try again.`, {
            reasonCode: entity === "settlement" ? "STALE_SETTLEMENT" : "STALE_RECURRING_BILL",
        });
    }
}

function memberIds(group: DocumentData, includeArchived = false): Set<string> {
    const ids = new Set<string>(
        Array.isArray(group.memberIds)
            ? group.memberIds.filter((value): value is string => typeof value === "string")
            : [],
    );
    if (includeArchived && Array.isArray(group.archivedMembers)) {
        group.archivedMembers.forEach((entry: unknown) => {
            if (entry && typeof entry === "object" && typeof (entry as { userId?: unknown }).userId === "string") {
                ids.add((entry as { userId: string }).userId);
            }
        });
    }
    return ids;
}

function assertMember(group: DocumentData, uid: string): void {
    if (!memberIds(group).has(uid)) {
        throw new HttpsError("permission-denied", "You are not a member of this group.");
    }
}

function assertSettlementParticipants(
    settlement: z.infer<typeof settlementSchema>,
    group: DocumentData,
): void {
    const ids = memberIds(group, true);
    if (settlement.fromUserId === settlement.toUserId) {
        throw new HttpsError("invalid-argument", "A settlement must be between two different people.");
    }
    if (!ids.has(settlement.fromUserId) || !ids.has(settlement.toUserId)) {
        throw new HttpsError("failed-precondition", "Settlement participants must belong to this group.");
    }
}

export async function applySettlementMutation(params: {
    uid: string;
    input: SettlementMutationInput;
    nowMs?: number;
    db?: Firestore;
}): Promise<{ success: true; duplicate: boolean; settlement?: DocumentData }> {
    const db = params.db ?? getFirestore();
    const nowMs = params.nowMs ?? Date.now();
    const input = params.input;
    const groupRef = db.collection("groups").doc(input.groupId);

    return db.runTransaction(async (transaction) => {
        const groupSnapshot = await transaction.get(groupRef);
        if (!groupSnapshot.exists) throw new HttpsError("not-found", "Group not found.");
        const group = groupSnapshot.data() ?? {};
        assertMember(group, params.uid);
        const settlements = Array.isArray(group.settlements)
            ? group.settlements.filter((value): value is DocumentData => Boolean(value) && typeof value === "object")
            : [];

        if (input.action === "delete") {
            const current = settlements.find((value) => value.settlementId === input.settlementId);
            if (!current) throw new HttpsError("not-found", "Settlement not found.");
            assertExpectation(current, input.expectation, "settlement");
            transaction.update(groupRef, {
                settlements: settlements.filter((value) => value.settlementId !== input.settlementId),
                updatedAt: FieldValue.serverTimestamp(),
            });
            return { success: true, duplicate: false };
        }

        if (input.action === "create") {
            const duplicate = settlements.find((value) =>
                value.settlementId === input.settlement.settlementId ||
                (input.settlement.requestId && value.requestId === input.settlement.requestId));
            if (duplicate) {
                if (duplicate.settlementId !== input.settlement.settlementId) {
                    throw new HttpsError("already-exists", "This request already created another settlement.");
                }
                return { success: true, duplicate: true, settlement: duplicate };
            }
            assertExpectedCurrency(group, input.expectedCurrency);
            assertSettlementParticipants(input.settlement, group);
            const created = {
                ...input.settlement,
                revision: 1,
                createdAt: nowMs,
                updatedAt: nowMs,
            };
            transaction.update(groupRef, {
                settlements: [...settlements, created],
                updatedAt: FieldValue.serverTimestamp(),
            });
            return { success: true, duplicate: false, settlement: created };
        }

        assertExpectedCurrency(group, input.expectedCurrency);
        assertSettlementParticipants(input.settlement, group);
        const current = settlements.find((value) => value.settlementId === input.settlement.settlementId);
        if (!current) throw new HttpsError("not-found", "Settlement not found.");
        assertExpectation(current, input.expectation, "settlement");
        const updated = {
            ...input.settlement,
            revision: currentRevision(current.revision) + 1,
            createdAt: currentTimestamp(current.createdAt) ?? input.settlement.createdAt,
            updatedAt: nowMs,
        };
        transaction.update(groupRef, {
            settlements: settlements.map((value) =>
                value.settlementId === updated.settlementId ? updated : value),
            updatedAt: FieldValue.serverTimestamp(),
        });
        return { success: true, duplicate: false, settlement: updated };
    });
}

function recurrenceRuleFor(
    raw: Record<string, unknown>,
    startAt: number,
): RecurrenceRule {
    if (raw.recurrenceRule && typeof raw.recurrenceRule === "object") {
        return normalizeRecurrenceRule(raw.recurrenceRule as Partial<RecurrenceRule>, startAt);
    }
    return toLegacyRecurrenceRule(
        raw.frequency as LegacyBillFrequency | undefined,
        typeof raw.dayOfWeek === "number" ? raw.dayOfWeek : undefined,
        typeof raw.dayOfMonth === "number" ? raw.dayOfMonth : undefined,
        startAt,
    );
}

function cleanObject(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function assertRecurringBillParticipants(raw: Record<string, unknown>, group: DocumentData): void {
    const amount = raw.amount;
    const paidBy = raw.paidBy;
    const participants = raw.participants;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || !Array.isArray(participants)) {
        throw new HttpsError("invalid-argument", "Recurring bill amount and participants are invalid.");
    }
    const activeMemberIds = memberIds(group);
    const participantIds = participants.map((entry) => (entry as { userId: string }).userId);
    if (typeof paidBy !== "string" || !activeMemberIds.has(paidBy) ||
        participantIds.some((id) => !activeMemberIds.has(id))) {
        throw new HttpsError("failed-precondition", "Recurring bill participants must be active group members.");
    }
    if (new Set(participantIds).size !== participantIds.length) {
        throw new HttpsError("invalid-argument", "Recurring bill participants must be unique.");
    }
    const total = participants.reduce((sum, entry) => sum + (entry as { share: number }).share, 0);
    if (Math.abs(total - amount) > Math.max(0.02, participantIds.length * 0.01)) {
        throw new HttpsError("invalid-argument", "Recurring bill shares must add up to its amount.");
    }
    const rotation = raw.rotation;
    if (rotation && typeof rotation === "object") {
        const order = (rotation as { order?: unknown }).order;
        if (!Array.isArray(order) || new Set(order).size !== order.length ||
            order.some((id) => typeof id !== "string" || !activeMemberIds.has(id))) {
            throw new HttpsError("invalid-argument", "Recurring bill rotation must contain unique active members.");
        }
    }
}

function normalizeRecurringBillWrite(
    raw: Record<string, unknown>,
    group: DocumentData,
    nowMs: number,
): Record<string, unknown> {
    const startAt = currentTimestamp(raw.startAt) ?? nowMs;
    const recurrenceRule = recurrenceRuleFor(raw, startAt);
    const nextDueAt = currentTimestamp(raw.nextDueAt)
        ?? findNextOccurrenceAt(recurrenceRule, startAt, startAt - 1)
        ?? startAt;
    const rotation = raw.rotation === null ? null : raw.rotation;
    return cleanObject({
        ...raw,
        recurrenceRule,
        startAt,
        nextDueAt,
        rotation,
        requiresAccept: group.hidden === true,
    });
}

export async function applyRecurringBillMutation(params: {
    uid: string;
    input: RecurringBillMutationInput;
    nowMs?: number;
    db?: Firestore;
}): Promise<{ success: true; duplicate: boolean; billId: string }> {
    const db = params.db ?? getFirestore();
    const nowMs = params.nowMs ?? Date.now();
    const input = params.input;
    const groupRef = db.collection("groups").doc(input.groupId);
    const billRef = db.collection("recurringBills").doc(input.billId);

    return db.runTransaction(async (transaction) => {
        const [groupSnapshot, billSnapshot] = await Promise.all([
            transaction.get(groupRef),
            transaction.get(billRef),
        ]);
        if (!groupSnapshot.exists) throw new HttpsError("not-found", "Group not found.");
        const group = groupSnapshot.data() ?? {};
        assertMember(group, params.uid);

        if (input.action === "delete") {
            if (!billSnapshot.exists) return { success: true, duplicate: true, billId: input.billId };
            if (billSnapshot.data()?.groupId !== input.groupId) {
                throw new HttpsError("failed-precondition", "Recurring bill belongs to another group.");
            }
            transaction.delete(billRef);
            transaction.update(groupRef, { updatedAt: FieldValue.serverTimestamp() });
            return { success: true, duplicate: false, billId: input.billId };
        }

        if (input.action === "create") {
            if (input.bill.groupId !== input.groupId) {
                throw new HttpsError("invalid-argument", "Recurring bill group does not match the requested group.");
            }
            if (billSnapshot.exists) {
                if (billSnapshot.data()?.groupId !== input.groupId) {
                    throw new HttpsError("already-exists", "Recurring bill identifier is already in use.");
                }
                return { success: true, duplicate: true, billId: input.billId };
            }
            assertExpectedCurrency(group, input.expectedCurrency);
            const normalized = normalizeRecurringBillWrite(input.bill, group, nowMs);
            assertRecurringBillParticipants(normalized, group);
            transaction.create(billRef, {
                ...normalized,
                createdAt: nowMs,
                updatedAt: nowMs,
            });
            transaction.update(groupRef, { updatedAt: FieldValue.serverTimestamp() });
            return { success: true, duplicate: false, billId: input.billId };
        }

        if (!billSnapshot.exists) throw new HttpsError("not-found", "Recurring bill not found.");
        const current = billSnapshot.data() ?? {};
        if (current.groupId !== input.groupId) {
            throw new HttpsError("failed-precondition", "Recurring bill belongs to another group.");
        }
        assertExpectedCurrency(group, input.expectedCurrency);

        if (input.action === "skip") {
            const startAt = currentTimestamp(current.startAt) ?? nowMs;
            const rule = recurrenceRuleFor(current, startAt);
            const skipped = Array.isArray(current.skippedOccurrences)
                ? current.skippedOccurrences.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
                : [];
            const pending = Array.isArray(current.pendingOccurrences)
                ? current.pendingOccurrences.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
                : [];
            const updates: Record<string, unknown> = {
                skippedOccurrences: [...new Set([...skipped, input.occurrenceAt])].sort((a, b) => a - b),
                pendingOccurrences: pending.filter((value) => value !== input.occurrenceAt),
                updatedAt: nowMs,
            };
            if (currentTimestamp(current.nextDueAt) === input.occurrenceAt) {
                const next = findNextOccurrenceAt(rule, startAt, input.occurrenceAt);
                if (next === null) updates.isActive = false;
                else updates.nextDueAt = next;
            }
            transaction.update(billRef, updates);
            transaction.update(groupRef, { updatedAt: FieldValue.serverTimestamp() });
            return { success: true, duplicate: skipped.includes(input.occurrenceAt), billId: input.billId };
        }

        const merged = normalizeRecurringBillWrite({ ...current, ...input.updates }, group, nowMs);
        assertRecurringBillParticipants(merged, group);
        const updates = cleanObject({
            ...input.updates,
            requiresAccept: group.hidden === true,
        });
        const recurrenceChanged = input.updates.recurrenceRule !== undefined || input.updates.frequency !== undefined ||
            input.updates.dayOfWeek !== undefined || input.updates.dayOfMonth !== undefined ||
            input.updates.startAt !== undefined;
        if (recurrenceChanged) {
            updates.recurrenceRule = merged.recurrenceRule;
            updates.startAt = merged.startAt;
            if (input.updates.nextDueAt === undefined) updates.nextDueAt = merged.nextDueAt;
        }
        transaction.update(billRef, { ...updates, updatedAt: nowMs });
        transaction.update(groupRef, { updatedAt: FieldValue.serverTimestamp() });
        return { success: true, duplicate: false, billId: input.billId };
    });
}

function parsePayload<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
    if (JSON.stringify(data ?? null).length > 256_000) {
        throw new HttpsError("invalid-argument", `${label} payload is too large.`);
    }
    try {
        return schema.parse(data);
    } catch {
        throw new HttpsError("invalid-argument", `${label} request is invalid.`);
    }
}

export const mutateSettlement = onCall({ cors: true, maxInstances: 40 }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
    const input = parsePayload(settlementMutationSchema, request.data, "Settlement mutation");
    try {
        return await applySettlementMutation({ uid, input });
    } catch (error) {
        if (error instanceof HttpsError) throw error;
        logger.error("mutateSettlement failed", { uid, action: input.action, groupId: input.groupId, error });
        throw new HttpsError("internal", "Settlement could not be saved safely.");
    }
});

export const mutateRecurringBill = onCall({ cors: true, maxInstances: 40 }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
    const input = parsePayload(recurringBillMutationSchema, request.data, "Recurring bill mutation");
    try {
        return await applyRecurringBillMutation({ uid, input });
    } catch (error) {
        if (error instanceof HttpsError) throw error;
        logger.error("mutateRecurringBill failed", { uid, action: input.action, groupId: input.groupId, error });
        throw new HttpsError("internal", "Recurring bill could not be saved safely.");
    }
});
