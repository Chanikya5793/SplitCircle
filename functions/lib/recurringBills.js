"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.processGroupDueRecurringBills = exports.processAllDueRecurringBills = void 0;
const firestore_1 = require("firebase-admin/firestore");
const logger = __importStar(require("firebase-functions/logger"));
const recurrence_1 = require("./recurrence");
const RECURRING_BILLS_COLLECTION = "recurringBills";
const GROUPS_COLLECTION = "groups";
const EXPENSES_COLLECTION = "expenses";
const MAX_OCCURRENCES_PER_RUN = 64;
const toNumber = (value) => {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "object" && value !== null) {
        const maybeTimestamp = value;
        if (typeof maybeTimestamp.toMillis === "function")
            return maybeTimestamp.toMillis();
        if (typeof maybeTimestamp.seconds === "number")
            return maybeTimestamp.seconds * 1000;
    }
    return null;
};
const toStringValue = (value) => {
    return typeof value === "string" ? value.trim() : "";
};
const toParticipantShares = (value) => {
    if (!Array.isArray(value))
        return [];
    const payload = [];
    value.forEach((entry) => {
        if (!entry || typeof entry !== "object")
            return;
        const data = entry;
        if (typeof data.userId !== "string")
            return;
        if (typeof data.share !== "number" || !Number.isFinite(data.share))
            return;
        payload.push({ userId: data.userId, share: data.share });
    });
    return payload;
};
const normalizeRecurringBill = (billId, raw) => {
    var _a, _b, _c, _d, _e, _f, _g;
    const groupId = toStringValue(raw.groupId);
    const title = toStringValue(raw.title);
    const category = toStringValue(raw.category);
    const paidBy = toStringValue(raw.paidBy);
    const amount = typeof raw.amount === "number" && Number.isFinite(raw.amount) ? raw.amount : 0;
    const participants = toParticipantShares(raw.participants);
    if (!groupId || !title || !category || !paidBy || amount <= 0 || participants.length === 0) {
        return null;
    }
    const createdAt = (_a = toNumber(raw.createdAt)) !== null && _a !== void 0 ? _a : Date.now();
    const startAt = (_c = (_b = toNumber(raw.startAt)) !== null && _b !== void 0 ? _b : toNumber(raw.nextDueAt)) !== null && _c !== void 0 ? _c : createdAt;
    const recurrenceRule = (raw.recurrenceRule && typeof raw.recurrenceRule === "object")
        ? (0, recurrence_1.normalizeRecurrenceRule)(raw.recurrenceRule, startAt)
        : (0, recurrence_1.toLegacyRecurrenceRule)(raw.frequency, typeof raw.dayOfWeek === "number" ? raw.dayOfWeek : undefined, typeof raw.dayOfMonth === "number" ? raw.dayOfMonth : undefined, startAt);
    const nextDueAt = (_e = (_d = toNumber(raw.nextDueAt)) !== null && _d !== void 0 ? _d : (0, recurrence_1.findNextOccurrenceAt)(recurrenceRule, startAt, startAt - 1)) !== null && _e !== void 0 ? _e : startAt;
    const endAt = (_f = toNumber(raw.endAt)) !== null && _f !== void 0 ? _f : undefined;
    const lastGeneratedAt = (_g = toNumber(raw.lastGeneratedAt)) !== null && _g !== void 0 ? _g : undefined;
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
        frequency: raw.frequency,
    };
};
const buildRecurringExpense = (bill, occurrenceAt) => {
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
const processBill = async (billRef, bill, now) => {
    if (!bill.isActive)
        return 0;
    let currentDueAt = bill.nextDueAt;
    let generatedCount = 0;
    let shouldDeactivate = false;
    let lastGeneratedAt = bill.lastGeneratedAt;
    const expensesToAdd = [];
    while (currentDueAt <= now &&
        generatedCount < MAX_OCCURRENCES_PER_RUN &&
        (!bill.endAt || currentDueAt <= bill.endAt)) {
        expensesToAdd.push(buildRecurringExpense(bill, currentDueAt));
        lastGeneratedAt = currentDueAt;
        generatedCount += 1;
        const next = (0, recurrence_1.findNextOccurrenceAt)(bill.recurrenceRule, bill.startAt, currentDueAt);
        if (!next || next <= currentDueAt) {
            shouldDeactivate = true;
            break;
        }
        currentDueAt = next;
    }
    if (generatedCount === 0) {
        return 0;
    }
    const db = (0, firestore_1.getFirestore)();
    const batch = db.batch();
    const groupRef = db.collection(GROUPS_COLLECTION).doc(bill.groupId);
    batch.update(groupRef, {
        expenses: firestore_1.FieldValue.arrayUnion(...expensesToAdd),
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
        lastGeneratedAt: lastGeneratedAt !== null && lastGeneratedAt !== void 0 ? lastGeneratedAt : null,
        updatedAt: Date.now(),
    });
    await batch.commit();
    return generatedCount;
};
const queryBills = async (groupId) => {
    const db = (0, firestore_1.getFirestore)();
    const ref = db.collection(RECURRING_BILLS_COLLECTION);
    if (groupId) {
        return ref.where("groupId", "==", groupId).get();
    }
    return ref.get();
};
const processQueryResult = async (querySnapshot, now) => {
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
        if (!normalized.isActive)
            continue;
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
const processAllDueRecurringBills = async () => {
    const now = Date.now();
    const snapshot = await queryBills();
    return processQueryResult(snapshot, now);
};
exports.processAllDueRecurringBills = processAllDueRecurringBills;
const processGroupDueRecurringBills = async (groupId) => {
    const now = Date.now();
    const snapshot = await queryBills(groupId);
    return processQueryResult(snapshot, now);
};
exports.processGroupDueRecurringBills = processGroupDueRecurringBills;
//# sourceMappingURL=recurringBills.js.map