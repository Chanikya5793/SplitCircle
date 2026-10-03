import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    applyExpenseMutation,
    applyGroupCurrencyConversion,
    type ExpenseMutationInput,
} from "./expenseMutation";
import { operationDigest } from "./monetizationEnforcement";
import { accountDocumentId } from "./monetizationStore";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = emulatorHost ? describe : describe.skip;
const PROJECT_ID = "manasplit-expense-mutation-test";
const UID = "expense-owner";
const NOW = Date.parse("2026-09-07T18:00:00.000Z");

const expense = (method: "exact" | "income", expenseId: string) => ({
    expenseId,
    requestId: expenseId,
    groupId: "group-1",
    title: "Dinner",
    category: "Food",
    amount: 20,
    paidBy: UID,
    splitType: "custom" as const,
    participants: [
        { userId: UID, share: 10 },
        { userId: "friend", share: 10 },
    ],
    splitMetadata: {
        version: 1 as const,
        method,
        participantConfig: [
            { userId: UID, included: true, computedAmount: 10 },
            { userId: "friend", included: true, computedAmount: 10 },
        ],
    },
    settled: false,
    notes: "",
    createdAt: NOW,
    updatedAt: NOW,
});

describeWithEmulator("server-owned expense mutation boundary", () => {
    const app = initializeApp({ projectId: PROJECT_ID }, "expense-mutation-test");
    const db = getFirestore(app);

    beforeAll(async () => {
        await db.recursiveDelete(db.collection("groups"));
        await db.recursiveDelete(db.collection("expenses"));
        await db.recursiveDelete(db.collection("recurringBills"));
        await db.recursiveDelete(db.collection("monetizationAccountStates"));
        await db.recursiveDelete(db.collection("monetizationUsageAccounts"));
        await db.collection("groups").doc("group-1").set({
            groupId: "group-1",
            currency: "USD",
            memberIds: [UID, "friend"],
            members: [
                { userId: UID, role: "owner" },
                { userId: "friend", role: "member" },
            ],
            archivedMembers: [],
            expenses: [],
            settlements: [],
        });
        const id = accountDocumentId("sandbox", UID);
        await db.collection("monetizationAccountStates").doc(id).set({
            schemaVersion: 1,
            uid: UID,
            environment: "sandbox",
            status: "active",
            appAccountToken: "11111111-1111-4111-8111-111111111111",
            creditBalance: 0,
            creditDebt: 0,
            planId: "free",
            validUntil: null,
            subscriptions: {},
        });
    });

    afterAll(async () => {
        await deleteApp(app);
    });

    const seedAuthorization = async (operationId: string, authorizationId: string) => {
        const accountId = accountDocumentId("sandbox", UID);
        await db.collection("monetizationUsageAccounts").doc(accountId)
            .collection("reservations").doc(authorizationId).set({
                schemaVersion: 1,
                status: "reserved",
                payloadDigest: "payload",
                authorizationId,
                operationDigest: operationDigest(operationId),
                environment: "sandbox",
                featureId: "advanced_split.completion",
                variant: "income",
                source: "included_use",
                creditCost: 0,
                windowDocumentId: null,
                previewDocumentId: null,
                expiresAtMs: NOW + 60_000,
                result: {
                    schemaVersion: 1,
                    allowed: true,
                    authorizationId,
                    environment: "sandbox",
                    featureId: "advanced_split.completion",
                    planId: "free",
                    source: "included_use",
                    reasonCode: "quota_available",
                    creditCost: 1,
                    creditBalance: 0,
                    remaining: 2,
                    resetsAt: NOW + 60_000,
                },
            });
    };

    it("allows an ordinary expense without a commerce authorization", async () => {
        const input: ExpenseMutationInput = {
            action: "create",
            groupId: "group-1",
            expense: expense("exact", "ordinary-1"),
        };
        await expect(applyExpenseMutation({ uid: UID, environment: "sandbox", input, nowMs: NOW, db }))
            .resolves.toMatchObject({ success: true, duplicate: false });
    });

    it("rejects an advanced expense without authorization and leaves no partial write", async () => {
        const input: ExpenseMutationInput = {
            action: "create",
            groupId: "group-1",
            expense: expense("income", "advanced-denied"),
        };
        await expect(applyExpenseMutation({ uid: UID, environment: "sandbox", input, nowMs: NOW, db }))
            .rejects.toMatchObject({ code: "failed-precondition" });
        expect((await db.collection("expenses").doc("advanced-denied").get()).exists).toBe(false);
    });

    it("atomically writes an advanced expense and consumes its authorization once", async () => {
        const operationId = "11111111-1111-4111-8111-111111111112";
        const authorizationId = "a".repeat(64);
        await seedAuthorization(operationId, authorizationId);
        const input: ExpenseMutationInput = {
            action: "create",
            groupId: "group-1",
            expense: expense("income", "advanced-1"),
            authorization: { operationId, authorizationId },
        };
        await expect(applyExpenseMutation({ uid: UID, environment: "sandbox", input, nowMs: NOW, db }))
            .resolves.toMatchObject({ success: true, duplicate: false });
        await expect(applyExpenseMutation({ uid: UID, environment: "sandbox", input, nowMs: NOW, db }))
            .resolves.toMatchObject({ success: true, duplicate: true });
        const reservation = await db.collection("monetizationUsageAccounts")
            .doc(accountDocumentId("sandbox", UID)).collection("reservations").doc(authorizationId).get();
        expect(reservation.data()).toMatchObject({ status: "finalized", outcome: "completed" });
        const stored = await db.collection("expenses").doc("advanced-1").get();
        expect(stored.exists).toBe(true);
    });

    it("converts every durable monetary source and rejects a stale source currency", async () => {
        const conversionNow = NOW + 10_000;
        const itemizedExpense = {
            ...expense("income", "conversion-itemized"),
            groupId: "conversion-group",
            revision: 2,
            amount: 20,
            participants: [
                { userId: UID, share: 7.33 },
                { userId: "friend", share: 12.67 },
            ],
            splitMetadata: {
                version: 1,
                method: "itemized",
                participantConfig: [
                    { userId: UID, included: true, exactAmount: 7.33, computedAmount: 7.33 },
                    { userId: "friend", included: true, exactAmount: 12.67, computedAmount: 12.67 },
                ],
                receiptItems: [{
                    id: "item-1",
                    name: "Food",
                    price: 18,
                    assignedTo: [UID, "friend"],
                    splitMode: "exact",
                    splitData: { [UID]: 7, friend: 11 },
                }],
                taxAmount: 1,
                taxSplitConfig: { mode: "exact", data: { [UID]: 0.25, friend: 0.75 } },
                tipAmount: 1,
                tipSplitConfig: { mode: "percentage", data: { [UID]: 50, friend: 50 } },
            },
            receipt: {
                url: "https://example.com/receipt.jpg",
                insights: { savings: 2 },
            },
        };
        const plainExpense = {
            ...expense("exact", "conversion-plain"),
            groupId: "conversion-group",
            amount: 10,
            participants: [
                { userId: UID, share: 5 },
                { userId: "friend", share: 5 },
            ],
            splitMetadata: {
                version: 1,
                method: "equal",
                participantConfig: [
                    { userId: UID, included: true },
                    { userId: "friend", included: true },
                ],
            },
        };
        await db.collection("groups").doc("conversion-group").set({
            groupId: "conversion-group",
            currency: "USD",
            memberIds: [UID, "friend"],
            members: [
                { userId: UID, role: "owner" },
                { userId: "friend", role: "member" },
            ],
            expenses: [itemizedExpense, plainExpense],
            settlements: [{
                settlementId: "settlement-1",
                revision: 1,
                fromUserId: "friend",
                toUserId: UID,
                amount: 4,
                createdAt: NOW,
                status: "completed",
            }],
            budgets: { Food: 100 },
        });
        await Promise.all([
            db.collection("expenses").doc(itemizedExpense.expenseId).set(itemizedExpense),
            db.collection("expenses").doc(plainExpense.expenseId).set(plainExpense),
            db.collection("recurringBills").doc("bill-1").set({
                groupId: "conversion-group",
                amount: 30,
                participants: [
                    { userId: UID, share: 10 },
                    { userId: "friend", share: 20 },
                ],
                updatedAt: NOW,
            }),
        ]);

        await expect(applyGroupCurrencyConversion({
            uid: UID,
            groupId: "conversion-group",
            expectedCurrency: "USD",
            newCurrency: "EUR",
            rate: 1.5,
            nowMs: conversionNow,
            db,
        })).resolves.toEqual({ success: true, previousCurrency: "USD", currency: "EUR" });

        const convertedGroup = (await db.collection("groups").doc("conversion-group").get()).data()!;
        const convertedItemized = convertedGroup.expenses.find(
            (value: Record<string, unknown>) => value.expenseId === itemizedExpense.expenseId,
        );
        expect(convertedGroup).toMatchObject({
            currency: "EUR",
            budgets: { Food: 150 },
            settlements: [{ amount: 6, revision: 2, updatedAt: conversionNow }],
        });
        expect(convertedItemized).toMatchObject({
            amount: 30,
            revision: 3,
            participants: [{ share: 11 }, { share: 19 }],
            splitMetadata: {
                participantConfig: [
                    { exactAmount: 11, computedAmount: 11 },
                    { exactAmount: 19.01, computedAmount: 19 },
                ],
                receiptItems: [{ price: 27, splitData: { [UID]: 10.5, friend: 16.5 } }],
                taxAmount: 1.5,
                taxSplitConfig: { mode: "exact", data: { [UID]: 0.38, friend: 1.12 } },
                tipAmount: 1.5,
                tipSplitConfig: { mode: "percentage", data: { [UID]: 50, friend: 50 } },
            },
            receipt: { insights: { savings: 3 } },
        });
        expect((await db.collection("expenses").doc(itemizedExpense.expenseId).get()).data())
            .toEqual(convertedItemized);
        expect((await db.collection("recurringBills").doc("bill-1").get()).data()).toMatchObject({
            amount: 45,
            participants: [{ share: 15 }, { share: 30 }],
            updatedAt: conversionNow,
        });

        const staleExpenseInput: ExpenseMutationInput = {
            action: "create",
            groupId: "conversion-group",
            expectedCurrency: "USD",
            expense: {
                ...expense("exact", "stale-currency-expense"),
                groupId: "conversion-group",
            },
        };
        await expect(applyExpenseMutation({
            uid: UID,
            environment: "sandbox",
            input: staleExpenseInput,
            nowMs: conversionNow + 1,
            db,
        })).rejects.toMatchObject({ code: "aborted" });
        expect((await db.collection("expenses").doc("stale-currency-expense").get()).exists).toBe(false);

        await expect(applyGroupCurrencyConversion({
            uid: UID,
            groupId: "conversion-group",
            expectedCurrency: "USD",
            newCurrency: "GBP",
            rate: 0.8,
            nowMs: conversionNow + 1,
            db,
        })).rejects.toMatchObject({ code: "aborted" });
        await expect(applyGroupCurrencyConversion({
            uid: UID,
            groupId: "conversion-group",
            expectedCurrency: "USD",
            newCurrency: "EUR",
            rate: 1.5,
            nowMs: conversionNow + 2,
            db,
        })).resolves.toEqual({ success: true, previousCurrency: "EUR", currency: "EUR" });
    });

    it("reconciles amplified legacy share dust to the converted total", async () => {
        await db.collection("groups").doc("conversion-dust").set({
            groupId: "conversion-dust",
            currency: "USD",
            memberIds: [UID, "friend"],
            members: [
                { userId: UID, role: "owner" },
                { userId: "friend", role: "member" },
            ],
            expenses: [{
                ...expense("exact", "conversion-dust-expense"),
                groupId: "conversion-dust",
                amount: 20,
                participants: [
                    { userId: UID, share: 19.98 },
                    { userId: "friend", share: 0 },
                ],
            }],
            settlements: [],
        });
        await applyGroupCurrencyConversion({
            uid: UID,
            groupId: "conversion-dust",
            expectedCurrency: "USD",
            newCurrency: "JPY",
            rate: 150,
            nowMs: NOW + 20_000,
            db,
        });
        const converted = (await db.collection("groups").doc("conversion-dust").get()).data()!.expenses[0];
        expect(converted.amount).toBe(3000);
        expect(converted.participants.reduce(
            (sum: number, participant: { share: number }) => sum + participant.share,
            0,
        )).toBe(3000);
    });
});
