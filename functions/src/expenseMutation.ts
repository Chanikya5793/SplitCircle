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
    finalizeReservationInTransaction,
    operationDigest,
} from "./monetizationEnforcement";
import { accountDocumentId, MONETIZATION_USAGE_ACCOUNT_COLLECTION } from "./monetizationStore";
import { resolveRequestMonetizationContext } from "./monetizationRequest";

const IDENTIFIER = /^[A-Za-z0-9_.:@-]{1,180}$/;
const AUTHORIZATION_ID = /^[0-9a-f]{64}$/;
const ADVANCED_SPLIT_METHODS = new Set([
    "itemized",
    "income",
    "consumption",
    "timeBased",
    "itemType",
]);

const finiteNumber = z.number().finite();
const nonNegativeNumber = finiteNumber.min(0);
const identifier = z.string().trim().regex(IDENTIFIER);
const currencyCode = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);

const participantShareSchema = z.object({
    userId: identifier,
    share: nonNegativeNumber.max(1_000_000_000),
}).strict();

const participantConfigSchema = z.object({
    userId: identifier,
    included: z.boolean(),
    exactAmount: nonNegativeNumber.max(1_000_000_000).optional(),
    percentage: nonNegativeNumber.max(100).optional(),
    shares: nonNegativeNumber.max(1_000_000).optional(),
    adjustment: finiteNumber.min(-1_000_000_000).max(1_000_000_000).optional(),
    incomeWeight: nonNegativeNumber.max(1_000_000_000).optional(),
    historicalPaid: nonNegativeNumber.max(1_000_000_000).optional(),
    daysStayed: nonNegativeNumber.max(100_000).optional(),
    checkInDate: z.string().max(64).optional(),
    checkOutDate: z.string().max(64).optional(),
    selectedStayDates: z.array(z.string().max(64)).max(400).optional(),
    partsConsumed: nonNegativeNumber.max(1_000_000).optional(),
    rouletteWeight: nonNegativeNumber.max(1_000_000).optional(),
    computedAmount: nonNegativeNumber.max(1_000_000_000).optional(),
}).strict();

const itemSplitConfigSchema = z.object({
    mode: z.enum(["equal", "exact", "percentage", "shares"]),
    data: z.record(z.string().max(180), finiteNumber).optional(),
}).strict();

const receiptItemSchema = z.object({
    id: identifier,
    name: z.string().trim().min(1).max(300),
    price: nonNegativeNumber.max(1_000_000_000),
    quantity: nonNegativeNumber.max(1_000_000).optional(),
    assignedTo: z.array(identifier).max(200),
    splitMode: z.enum(["equal", "exact", "percentage", "shares"]).optional(),
    splitData: z.record(z.string().max(180), finiteNumber).optional(),
}).strict();

const splitMetadataSchema = z.object({
    version: z.literal(1),
    method: z.enum([
        "equal",
        "exact",
        "percentage",
        "shares",
        "adjustment",
        "itemized",
        "income",
        "consumption",
        "timeBased",
        "gamified",
        "itemType",
    ]),
    participantConfig: z.array(participantConfigSchema).min(1).max(200),
    receiptItems: z.array(receiptItemSchema).max(500).optional(),
    taxAmount: nonNegativeNumber.max(1_000_000_000).optional(),
    taxSplitConfig: itemSplitConfigSchema.optional(),
    tipAmount: nonNegativeNumber.max(1_000_000_000).optional(),
    tipSplitConfig: itemSplitConfigSchema.optional(),
    totalParts: nonNegativeNumber.max(1_000_000).optional(),
    timeSplitVariant: z.enum(["dynamic", "standard"]).optional(),
    timePeriodDays: nonNegativeNumber.max(100_000).optional(),
    timePeriodStartDate: z.string().max(64).optional(),
    timePeriodEndDate: z.string().max(64).optional(),
    gamifiedMode: z.enum(["roulette", "weightedRoulette", "scrooge"]).optional(),
    rouletteLoserId: identifier.optional(),
    weightedAssignments: z.array(z.object({
        userId: identifier,
        percentage: nonNegativeNumber.max(100),
    }).strict()).max(200).optional(),
    karmaIntensity: finiteNumber.min(-1_000_000).max(1_000_000).optional(),
    itemCategories: z.array(z.object({
        id: identifier,
        label: z.string().trim().min(1).max(200),
        amount: nonNegativeNumber.max(1_000_000_000),
        excludedParticipants: z.array(identifier).max(200),
    }).strict()).max(500).optional(),
}).strict();

const receiptSchema = z.object({
    url: z.string().url().max(4096).optional(),
    fileName: z.string().trim().min(1).max(255).optional(),
    size: nonNegativeNumber.max(100_000_000).optional(),
    scannedWith: z.enum(["visionkit", "ocr", "manual"]).optional(),
    insights: z.object({
        merchantAddress: z.string().max(500).optional(),
        merchantPhone: z.string().max(100).optional(),
        paymentMethod: z.string().max(150).optional(),
        savings: nonNegativeNumber.max(1_000_000_000).optional(),
        returnPolicy: z.string().max(2_000).optional(),
    }).strict().optional(),
}).strict();

const expenseSchema = z.object({
    expenseId: identifier,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    requestId: identifier.optional(),
    groupId: identifier,
    title: z.string().trim().min(1).max(300),
    category: z.string().trim().min(1).max(120),
    amount: finiteNumber.positive().max(1_000_000_000),
    paidBy: identifier,
    splitType: z.enum(["equal", "percentage", "shares", "custom"]),
    participants: z.array(participantShareSchema).min(1).max(200),
    splitMetadata: splitMetadataSchema.optional(),
    settled: z.boolean(),
    settledParticipantIds: z.array(identifier).max(200).optional(),
    notes: z.string().max(5_000).optional(),
    receipt: receiptSchema.optional(),
    recurring: z.object({
        billId: identifier,
        occurrenceAt: finiteNumber.nonnegative(),
    }).strict().optional(),
    createdAt: finiteNumber.nonnegative(),
    updatedAt: finiteNumber.nonnegative(),
}).strict();

const expectationSchema = z.object({
    expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    expectedUpdatedAt: finiteNumber.nonnegative().optional(),
}).strict().refine(
    (value) => value.expectedRevision !== undefined || value.expectedUpdatedAt !== undefined,
    "A revision or timestamp is required.",
);

const authorizationSchema = z.object({
    operationId: identifier,
    authorizationId: z.string().regex(AUTHORIZATION_ID),
}).strict();

const mutationSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("create"),
        groupId: identifier,
        expense: expenseSchema,
        expectedCurrency: currencyCode.optional(),
        authorization: authorizationSchema.optional(),
    }).strict(),
    z.object({
        action: z.literal("update"),
        groupId: identifier,
        expense: expenseSchema,
        expectation: expectationSchema,
        expectedCurrency: currencyCode.optional(),
        authorization: authorizationSchema.optional(),
    }).strict(),
    z.object({
        action: z.literal("delete"),
        groupId: identifier,
        expenseId: identifier,
        expectation: expectationSchema,
    }).strict(),
]);

const currencyConversionSchema = z.object({
    groupId: identifier,
    expectedCurrency: currencyCode,
    newCurrency: currencyCode,
    rate: finiteNumber.positive().max(1_000_000),
}).strict();

export type ExpenseMutationInput = z.infer<typeof mutationSchema>;

function isAdvancedExpense(expense: z.infer<typeof expenseSchema>): boolean {
    return ADVANCED_SPLIT_METHODS.has(expense.splitMetadata?.method ?? "");
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

function assertExpectation(current: DocumentData, expectation: z.infer<typeof expectationSchema>): void {
    if (expectation.expectedRevision !== undefined &&
        currentRevision(current.revision) !== expectation.expectedRevision) {
        throw new HttpsError("aborted", "This expense changed on another device. Refresh and try again.", {
            reasonCode: "STALE_EXPENSE",
        });
    }
    if (expectation.expectedRevision === undefined && expectation.expectedUpdatedAt !== undefined &&
        currentTimestamp(current.updatedAt) !== expectation.expectedUpdatedAt) {
        throw new HttpsError("aborted", "This expense changed on another device. Refresh and try again.", {
            reasonCode: "STALE_EXPENSE",
        });
    }
}

function assertExpenseParticipants(expense: z.infer<typeof expenseSchema>, group: DocumentData): void {
    const memberIds = new Set<string>([
        ...(Array.isArray(group.memberIds) ? group.memberIds.filter((value): value is string => typeof value === "string") : []),
        ...(Array.isArray(group.archivedMembers)
            ? group.archivedMembers
                .map((value: unknown) => value && typeof value === "object" ? (value as { userId?: unknown }).userId : null)
                .filter((value: unknown): value is string => typeof value === "string")
            : []),
    ]);
    const participantIds = expense.participants.map((participant) => participant.userId);
    if (!memberIds.has(expense.paidBy) || participantIds.some((userId) => !memberIds.has(userId))) {
        throw new HttpsError("failed-precondition", "Expense participants must belong to this group.");
    }
    if (new Set(participantIds).size !== participantIds.length) {
        throw new HttpsError("invalid-argument", "Expense participants must be unique.");
    }
    const total = expense.participants.reduce((sum, participant) => sum + participant.share, 0);
    const tolerance = Math.max(0.02, participantIds.length * 0.01);
    if (Math.abs(total - expense.amount) > tolerance) {
        throw new HttpsError("invalid-argument", "Expense shares must add up to the total amount.");
    }
}

function storedCurrency(group: DocumentData): string {
    return typeof group.currency === "string" ? group.currency.trim().toUpperCase() : "";
}

function assertExpectedCurrency(group: DocumentData, expectedCurrency: string | undefined): void {
    if (expectedCurrency && storedCurrency(group) !== expectedCurrency) {
        throw new HttpsError("aborted", "This group's currency changed on another device. Refresh and try again.", {
            reasonCode: "STALE_GROUP_CURRENCY",
        });
    }
}

async function consumeAdvancedSplitAuthorization(params: {
    transaction: FirebaseFirestore.Transaction;
    db: Firestore;
    uid: string;
    environment: "sandbox" | "production";
    authorization: z.infer<typeof authorizationSchema> | undefined;
    variant: string;
    nowMs: number;
    allowFinalizedDuplicate: boolean;
}): Promise<void> {
    if (!params.authorization) {
        throw new HttpsError("failed-precondition", "Advanced split authorization is required.", {
            reasonCode: "MONETIZATION_AUTHORIZATION_REQUIRED",
        });
    }
    const accountId = accountDocumentId(params.environment, params.uid);
    const reservationRef = params.db.collection(MONETIZATION_USAGE_ACCOUNT_COLLECTION)
        .doc(accountId)
        .collection("reservations")
        .doc(params.authorization.authorizationId);
    const reservationSnapshot = await params.transaction.get(reservationRef);
    const reservation = reservationSnapshot.data();
    if (!reservationSnapshot.exists || reservation?.featureId !== "advanced_split.completion" ||
        reservation?.variant !== params.variant) {
        throw new HttpsError("permission-denied", "Authorization does not match this advanced split.");
    }
    if (reservation?.status === "finalized" && !params.allowFinalizedDuplicate) {
        throw new HttpsError("failed-precondition", "This authorization was already used.", {
            reasonCode: "AUTHORIZATION_ALREADY_USED",
        });
    }
    await finalizeReservationInTransaction({
        transaction: params.transaction,
        db: params.db,
        accountId,
        reservationId: params.authorization.authorizationId,
        expectedAuthorizationId: params.authorization.authorizationId,
        expectedOperationDigest: operationDigest(params.authorization.operationId),
        outcome: "completed",
        nowMs: params.nowMs,
    });
}

export async function applyExpenseMutation(params: {
    uid: string;
    environment: "sandbox" | "production";
    input: ExpenseMutationInput;
    nowMs?: number;
    db?: Firestore;
}): Promise<{ success: true; duplicate: boolean; expense?: DocumentData }> {
    const db = params.db ?? getFirestore();
    const nowMs = params.nowMs ?? Date.now();
    const input = params.input;
    const groupRef = db.collection("groups").doc(input.groupId);

    return db.runTransaction(async (transaction) => {
        const groupSnapshot = await transaction.get(groupRef);
        if (!groupSnapshot.exists) throw new HttpsError("not-found", "Group not found.");
        const group = groupSnapshot.data() ?? {};
        if (!Array.isArray(group.memberIds) || !group.memberIds.includes(params.uid)) {
            throw new HttpsError("permission-denied", "You are not a member of this group.");
        }
        const expenses = Array.isArray(group.expenses)
            ? group.expenses.filter((value): value is DocumentData => Boolean(value) && typeof value === "object")
            : [];

        if (input.action === "delete") {
            const current = expenses.find((expense) => expense.expenseId === input.expenseId);
            if (!current) throw new HttpsError("not-found", "Expense not found.");
            assertExpectation(current, input.expectation);
            transaction.update(groupRef, {
                expenses: expenses.filter((expense) => expense.expenseId !== input.expenseId),
                updatedAt: FieldValue.serverTimestamp(),
            });
            transaction.delete(db.collection("expenses").doc(input.expenseId));
            return { success: true, duplicate: false };
        }

        if (input.expense.groupId !== input.groupId) {
            throw new HttpsError("invalid-argument", "Expense group does not match the requested group.");
        }
        assertExpenseParticipants(input.expense, group);
        const expenseRef = db.collection("expenses").doc(input.expense.expenseId);
        const expenseSnapshot = await transaction.get(expenseRef);

        if (input.action === "create") {
            const duplicate = expenses.find((expense) =>
                expense.expenseId === input.expense.expenseId ||
                (input.expense.requestId && expense.requestId === input.expense.requestId));
            if (duplicate) {
                if (duplicate.expenseId !== input.expense.expenseId) {
                    throw new HttpsError("already-exists", "This request already created another expense.");
                }
                if (isAdvancedExpense(input.expense)) {
                    await consumeAdvancedSplitAuthorization({
                        transaction,
                        db,
                        uid: params.uid,
                        environment: params.environment,
                        authorization: input.authorization,
                        variant: input.expense.splitMetadata?.method ?? "",
                        nowMs,
                        allowFinalizedDuplicate: true,
                    });
                }
                return { success: true, duplicate: true, expense: duplicate };
            }
            assertExpectedCurrency(group, input.expectedCurrency);
            if (expenseSnapshot.exists) {
                throw new HttpsError("already-exists", "Expense identifier is already in use.");
            }
            if (isAdvancedExpense(input.expense)) {
                await consumeAdvancedSplitAuthorization({
                    transaction,
                    db,
                    uid: params.uid,
                    environment: params.environment,
                    authorization: input.authorization,
                    variant: input.expense.splitMetadata?.method ?? "",
                    nowMs,
                    allowFinalizedDuplicate: false,
                });
            }
            const created = {
                ...input.expense,
                revision: 1,
                createdAt: nowMs,
                updatedAt: nowMs,
            };
            transaction.update(groupRef, {
                expenses: [...expenses, created],
                updatedAt: FieldValue.serverTimestamp(),
            });
            transaction.create(expenseRef, created);
            return { success: true, duplicate: false, expense: created };
        }

        const current = expenses.find((expense) => expense.expenseId === input.expense.expenseId);
        if (!current) throw new HttpsError("not-found", "Expense not found.");
        assertExpectedCurrency(group, input.expectedCurrency);
        assertExpectation(current, input.expectation);
        const requiresAuthorization = isAdvancedExpense(input.expense);
        if (requiresAuthorization) {
            await consumeAdvancedSplitAuthorization({
                transaction,
                db,
                uid: params.uid,
                environment: params.environment,
                authorization: input.authorization,
                variant: input.expense.splitMetadata?.method ?? "",
                nowMs,
                allowFinalizedDuplicate: false,
            });
        }
        const updated = {
            ...input.expense,
            revision: currentRevision(current.revision) + 1,
            createdAt: currentTimestamp(current.createdAt) ?? input.expense.createdAt,
            updatedAt: nowMs,
        };
        transaction.update(groupRef, {
            expenses: expenses.map((expense) => expense.expenseId === updated.expenseId ? updated : expense),
            updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.set(expenseRef, updated, { merge: false });
        return { success: true, duplicate: false, expense: updated };
    });
}

export const mutateExpense = onCall(
    { cors: true, maxInstances: 40 },
    async (request) => {
        let input: ExpenseMutationInput;
        try {
            if (JSON.stringify(request.data ?? null).length > 512_000) {
                throw new HttpsError("invalid-argument", "Expense payload is too large.");
            }
            input = mutationSchema.parse(request.data);
        } catch (error) {
            if (error instanceof HttpsError) throw error;
            throw new HttpsError("invalid-argument", "Expense mutation is invalid.");
        }
        const context = await resolveRequestMonetizationContext(request);
        try {
            return await applyExpenseMutation({
                uid: context.uid,
                environment: context.environment,
                input,
            });
        } catch (error) {
            if (error instanceof HttpsError) throw error;
            logger.error("mutateExpense failed", {
                uid: context.uid,
                action: input.action,
                groupId: input.groupId,
                errorName: error instanceof Error ? error.name : "UnknownError",
            });
            throw new HttpsError("internal", "Expense could not be saved safely.");
        }
    },
);

function convertOptionalMoney(
    value: unknown,
    convert: (value: number) => number,
): unknown {
    return typeof value === "number" && Number.isFinite(value) ? convert(value) : value;
}

function convertExactSplitConfig(
    value: unknown,
    total: unknown,
    convert: (value: number) => number,
    rawUnits: (value: number) => number,
    scale: number,
): unknown {
    if (!value || typeof value !== "object") return value;
    const config = value as Record<string, unknown>;
    if (config.mode !== "exact" || !config.data || typeof config.data !== "object" || Array.isArray(config.data)) {
        return value;
    }
    return {
        ...config,
        data: typeof total === "number" && Number.isFinite(total)
            ? convertMoneyDistribution(config.data, total, rawUnits, scale)
            : convertMoneyRecord(config.data, convert),
    };
}

function convertMoneyRecord(
    value: unknown,
    convert: (value: number) => number,
): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
            key,
            convertOptionalMoney(entry, convert),
        ]),
    );
}

function convertMoneyFields(
    value: Record<string, unknown>,
    fields: readonly string[],
    convert: (value: number) => number,
): Record<string, unknown> {
    const result = { ...value };
    fields.forEach((field) => {
        const entry = value[field];
        if (typeof entry === "number" && Number.isFinite(entry)) {
            result[field] = convert(entry);
        }
    });
    return result;
}

function convertMoneyDistribution(
    value: unknown,
    total: number,
    rawUnits: (value: number) => number,
    scale: number,
): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([, entry]) => typeof entry !== "number" || !Number.isFinite(entry))) return value;
    const shares = reconcileConvertedShares({
        amount: total,
        shares: entries.map(([, entry]) => entry as number),
        rawUnits,
        scale,
    });
    return Object.fromEntries(entries.map(([key], index) => [key, shares[index]]));
}

function reconcileConvertedShares(params: {
    amount: number;
    shares: number[];
    rawUnits: (value: number) => number;
    scale: number;
}): number[] {
    if (params.shares.length === 0) return [];
    const raw = params.shares.map(params.rawUnits);
    const units = raw.map(Math.floor);
    let remainder = Math.round(params.rawUnits(params.amount)) - units.reduce((sum, value) => sum + value, 0);
    const direction = remainder >= 0 ? 1 : -1;
    const order = raw
        .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
        .sort((left, right) => direction > 0
            ? right.fraction - left.fraction || left.index - right.index
            : left.fraction - right.fraction || left.index - right.index);

    // A legacy expense may contain a small amount/share mismatch. Currency
    // conversion magnifies that drift, so a single pass of one minor unit per
    // participant is not enough. Distribute full rounds first, then the final
    // remainder, keeping the converted shares exactly equal to the total.
    const fullRounds = Math.trunc(remainder / units.length);
    if (fullRounds !== 0) {
        units.forEach((_, index) => { units[index] += fullRounds; });
        remainder -= fullRounds * units.length;
    }
    for (let index = 0; index < Math.abs(remainder); index += 1) {
        units[order[index].index] += direction;
    }
    return units.map((value) => value / params.scale);
}

export async function applyGroupCurrencyConversion(params: {
    uid: string;
    groupId: string;
    expectedCurrency: string;
    newCurrency: string;
    rate: number;
    nowMs?: number;
    db?: Firestore;
}): Promise<{ success: true; previousCurrency: string; currency: string }> {
    const db = params.db ?? getFirestore();
    const nowMs = params.nowMs ?? Date.now();
    const groupRef = db.collection("groups").doc(params.groupId);
    return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(groupRef);
        if (!snapshot.exists) throw new HttpsError("not-found", "Group not found.");
        const group = snapshot.data() ?? {};
        const member = Array.isArray(group.members)
            ? (group.members as Array<Record<string, unknown>>).find((value) => value.userId === params.uid)
            : undefined;
        if (member?.role !== "owner" && member?.role !== "admin") {
            throw new HttpsError("permission-denied", "Only group admins can convert the currency.");
        }
        const previousCurrency = storedCurrency(group);
        if (previousCurrency === params.newCurrency) {
            return { success: true, previousCurrency, currency: params.newCurrency };
        }
        if (previousCurrency !== params.expectedCurrency) {
            throw new HttpsError("aborted", "This group's currency changed on another device. Refresh and try again.", {
                reasonCode: "STALE_GROUP_CURRENCY",
            });
        }
        const recurringBillsSnapshot = await transaction.get(
            db.collection("recurringBills").where("groupId", "==", params.groupId),
        );
        const expenses = Array.isArray(group.expenses)
            ? group.expenses.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
            : [];
        if (expenses.length + recurringBillsSnapshot.size > 450) {
            throw new HttpsError("resource-exhausted", "This group is too large for one-step currency conversion.");
        }
        const zeroDecimal = ["JPY", "KRW", "VND", "CLP"].includes(params.newCurrency);
        const scale = zeroDecimal ? 1 : 100;
        const rawUnits = (value: number) => value * params.rate * scale;
        const convert = (value: number) => Math.round(rawUnits(value)) / scale;
        const convertedExpenses = expenses.map((expense) => {
            const amount = typeof expense.amount === "number" && Number.isFinite(expense.amount)
                ? expense.amount
                : 0;
            const participants = Array.isArray(expense.participants)
                ? expense.participants.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
                : [];
            const convertedShares = reconcileConvertedShares({
                amount,
                shares: participants.map((participant) =>
                    typeof participant.share === "number" && Number.isFinite(participant.share) ? participant.share : 0),
                rawUnits,
                scale,
            });
            const splitMetadata = expense.splitMetadata && typeof expense.splitMetadata === "object"
                ? expense.splitMetadata as Record<string, unknown>
                : undefined;
            const convertedShareByUserId = new Map(
                participants.map((participant, index) => [participant.userId, convertedShares[index]]),
            );
            const participantConfig = Array.isArray(splitMetadata?.participantConfig)
                ? (splitMetadata.participantConfig as Array<Record<string, unknown>>).map((entry) => {
                    const converted = convertMoneyFields(
                        entry,
                        ["exactAmount", "adjustment", "historicalPaid", "computedAmount"],
                        convert,
                    );
                    const finalShare = convertedShareByUserId.get(entry.userId);
                    if (typeof finalShare === "number") {
                        if (splitMetadata?.method === "exact" && "exactAmount" in entry) {
                            converted.exactAmount = finalShare;
                        }
                        if ("computedAmount" in entry) converted.computedAmount = finalShare;
                    }
                    return converted;
                })
                : splitMetadata?.participantConfig;
            let convertedMetadata: Record<string, unknown> | undefined;
            if (splitMetadata) {
                convertedMetadata = { ...splitMetadata };
                if (Array.isArray(participantConfig)) convertedMetadata.participantConfig = participantConfig;
                if (typeof splitMetadata.taxAmount === "number" && Number.isFinite(splitMetadata.taxAmount)) {
                    convertedMetadata.taxAmount = convert(splitMetadata.taxAmount);
                }
                if (typeof splitMetadata.tipAmount === "number" && Number.isFinite(splitMetadata.tipAmount)) {
                    convertedMetadata.tipAmount = convert(splitMetadata.tipAmount);
                }
                if (splitMetadata.taxSplitConfig !== undefined) {
                    convertedMetadata.taxSplitConfig = convertExactSplitConfig(
                        splitMetadata.taxSplitConfig,
                        splitMetadata.taxAmount,
                        convert,
                        rawUnits,
                        scale,
                    );
                }
                if (splitMetadata.tipSplitConfig !== undefined) {
                    convertedMetadata.tipSplitConfig = convertExactSplitConfig(
                        splitMetadata.tipSplitConfig,
                        splitMetadata.tipAmount,
                        convert,
                        rawUnits,
                        scale,
                    );
                }
                if (Array.isArray(splitMetadata.receiptItems)) {
                    convertedMetadata.receiptItems = (splitMetadata.receiptItems as Array<Record<string, unknown>>).map((item) => ({
                        ...item,
                        price: convertOptionalMoney(item.price, convert),
                        ...(item.splitData !== undefined
                            ? { splitData: item.splitMode === "exact"
                                ? convertMoneyDistribution(
                                    item.splitData,
                                    typeof item.price === "number" && Number.isFinite(item.price) ? item.price : 0,
                                    rawUnits,
                                    scale,
                                )
                                : item.splitData }
                            : {}),
                    }));
                }
                if (Array.isArray(splitMetadata.itemCategories)) {
                    convertedMetadata.itemCategories = (splitMetadata.itemCategories as Array<Record<string, unknown>>).map((item) => ({
                        ...item,
                        amount: convertOptionalMoney(item.amount, convert),
                    }));
                }
            }
            let convertedReceipt = expense.receipt;
            if (expense.receipt && typeof expense.receipt === "object") {
                const receipt = expense.receipt as Record<string, unknown>;
                if (receipt.insights && typeof receipt.insights === "object" && !Array.isArray(receipt.insights)) {
                    const insights = receipt.insights as Record<string, unknown>;
                    convertedReceipt = {
                        ...receipt,
                        insights: {
                            ...insights,
                            ...(typeof insights.savings === "number" && Number.isFinite(insights.savings)
                                ? { savings: convert(insights.savings) }
                                : {}),
                        },
                    };
                }
            }
            const convertedExpense: Record<string, unknown> = {
                ...expense,
                revision: currentRevision(expense.revision) + 1,
                amount: convert(amount),
                participants: participants.map((participant, index) => ({
                    ...participant,
                    share: convertedShares[index],
                })),
                ...(convertedMetadata ? { splitMetadata: convertedMetadata } : {}),
                ...(convertedReceipt !== expense.receipt ? { receipt: convertedReceipt } : {}),
                updatedAt: nowMs,
            };
            return convertedExpense;
        });
        const settlements = Array.isArray(group.settlements)
            ? (group.settlements as Array<Record<string, unknown>>).map((settlement) => ({
                ...settlement,
                revision: currentRevision(settlement.revision) + 1,
                amount: convert(typeof settlement.amount === "number" ? settlement.amount : 0),
                updatedAt: nowMs,
            }))
            : [];
        const budgets = group.budgets && typeof group.budgets === "object" && !Array.isArray(group.budgets)
            ? Object.fromEntries(Object.entries(group.budgets as Record<string, unknown>).map(([key, value]) => [
                key,
                convert(typeof value === "number" ? value : 0),
            ]))
            : undefined;
        transaction.update(groupRef, {
            currency: params.newCurrency,
            expenses: convertedExpenses,
            settlements,
            ...(budgets ? { budgets } : {}),
            updatedAt: FieldValue.serverTimestamp(),
        });
        convertedExpenses.forEach((expense) => {
            if (expense.groupId === params.groupId && typeof expense.expenseId === "string" && IDENTIFIER.test(expense.expenseId)) {
                transaction.set(db.collection("expenses").doc(expense.expenseId), expense, { merge: false });
            }
        });
        recurringBillsSnapshot.docs.forEach((billSnapshot) => {
            const bill = billSnapshot.data();
            const amount = typeof bill.amount === "number" && Number.isFinite(bill.amount) ? bill.amount : null;
            const participants = Array.isArray(bill.participants)
                ? bill.participants.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
                : [];
            if (amount === null || amount < 0 || participants.length === 0 || participants.some((participant) =>
                typeof participant.share !== "number" || !Number.isFinite(participant.share))) {
                throw new HttpsError("failed-precondition", "A recurring bill must be repaired before converting this group.");
            }
            const convertedShares = reconcileConvertedShares({
                amount,
                shares: participants.map((participant) => participant.share as number),
                rawUnits,
                scale,
            });
            transaction.update(billSnapshot.ref, {
                amount: convert(amount),
                participants: participants.map((participant, index) => ({
                    ...participant,
                    share: convertedShares[index],
                })),
                updatedAt: nowMs,
            });
        });
        return { success: true, previousCurrency, currency: params.newCurrency };
    });
}

export const convertGroupCurrency = onCall({ cors: true, maxInstances: 10 }, async (request) => {
    let input: z.infer<typeof currencyConversionSchema>;
    try {
        input = currencyConversionSchema.parse(request.data);
    } catch {
        throw new HttpsError("invalid-argument", "Currency conversion request is invalid.");
    }
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
    return applyGroupCurrencyConversion({ uid, ...input });
});
