import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyGroupCurrencyConversion } from "./expenseMutation";
import { confirmRecurringBillOccurrence, processGroupDueRecurringBills } from "./recurringBills";
import {
    applyRecurringBillMutation,
    applySettlementMutation,
    type RecurringBillMutationInput,
    type SettlementMutationInput,
} from "./financialMutations";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = emulatorHost ? describe : describe.skip;
const PROJECT_ID = "manasplit-financial-mutations-test";
const UID = "currency-owner";
const FRIEND = "currency-friend";
const NOW = Date.parse("2026-09-07T19:00:00.000Z");

const groupData = (groupId: string, hidden = false) => ({
    groupId,
    name: "Currency Group",
    currency: "USD",
    inviteCode: "CURRENCY",
    createdBy: UID,
    memberIds: [UID, FRIEND],
    members: [
        { userId: UID, role: "owner" },
        { userId: FRIEND, role: "member" },
    ],
    archivedMembers: [],
    expenses: [],
    settlements: [],
    hidden,
    createdAt: NOW,
    updatedAt: NOW,
});

const settlementInput = (
    groupId: string,
    settlementId: string,
    expectedCurrency = "USD",
): SettlementMutationInput => ({
    action: "create",
    groupId,
    expectedCurrency,
    settlement: {
        settlementId,
        requestId: settlementId,
        fromUserId: FRIEND,
        toUserId: UID,
        amount: 10,
        createdAt: NOW,
        updatedAt: NOW,
        status: "pending",
    },
});

const recurringCreateInput = (
    groupId: string,
    billId: string,
    expectedCurrency = "USD",
): RecurringBillMutationInput => ({
    action: "create",
    billId,
    groupId,
    expectedCurrency,
    bill: {
        groupId,
        title: "Rent",
        amount: 10,
        category: "Housing",
        paidBy: UID,
        participants: [
            { userId: UID, share: 4 },
            { userId: FRIEND, share: 6 },
        ],
        recurrenceRule: {
            frequency: "monthly",
            interval: 1,
            monthlyPattern: "dayOfMonth",
            daysOfMonth: [7],
            timezoneOffsetMinutes: 0,
        },
        startAt: NOW,
        nextDueAt: NOW,
        amountMode: "fixed",
        requiresAccept: false,
        rotation: { order: [UID, FRIEND], index: 0 },
        isActive: true,
    },
});

describeWithEmulator("currency-aware financial mutation boundaries", () => {
    const app = initializeApp({ projectId: PROJECT_ID }, "financial-mutations-test");
    const db = getFirestore(app);

    beforeAll(async () => {
        await db.recursiveDelete(db.collection("groups"));
        await db.recursiveDelete(db.collection("expenses"));
        await db.recursiveDelete(db.collection("recurringBills"));
    }, 15_000);

    afterAll(async () => {
        await deleteApp(app);
    });

    it("keeps ordinary settlement CRUD free, authenticated, idempotent, and revision guarded", async () => {
        await db.collection("groups").doc("settlement-crud").set(groupData("settlement-crud"));
        const create = settlementInput("settlement-crud", "settlement-1");
        await expect(applySettlementMutation({ uid: UID, input: create, nowMs: NOW + 1, db }))
            .resolves.toMatchObject({ success: true, duplicate: false });
        await expect(applySettlementMutation({ uid: UID, input: create, nowMs: NOW + 2, db }))
            .resolves.toMatchObject({ success: true, duplicate: true });
        await expect(applySettlementMutation({ uid: "outsider", input: create, nowMs: NOW + 2, db }))
            .rejects.toMatchObject({ code: "permission-denied" });

        const update: SettlementMutationInput = {
            action: "update",
            groupId: "settlement-crud",
            expectedCurrency: "USD",
            expectation: { expectedRevision: 1 },
            settlement: {
                ...create.settlement,
                amount: 12,
                revision: 999,
                status: "completed",
            },
        };
        await expect(applySettlementMutation({ uid: UID, input: update, nowMs: NOW + 3, db }))
            .resolves.toMatchObject({ settlement: { amount: 12, revision: 2, status: "completed" } });
        await expect(applySettlementMutation({ uid: UID, input: update, nowMs: NOW + 4, db }))
            .rejects.toMatchObject({ code: "aborted" });
        await expect(applySettlementMutation({
            uid: UID,
            input: {
                action: "delete",
                groupId: "settlement-crud",
                settlementId: "settlement-1",
                expectation: { expectedRevision: 2 },
            },
            nowMs: NOW + 5,
            db,
        })).resolves.toMatchObject({ success: true });
    });

    it("never leaves a settlement amount labeled with a converted currency", async () => {
        await db.collection("groups").doc("settlement-race").set(groupData("settlement-race"));
        const results = await Promise.allSettled([
            applySettlementMutation({
                uid: UID,
                input: settlementInput("settlement-race", "settlement-race-1"),
                nowMs: NOW + 10,
                db,
            }),
            applyGroupCurrencyConversion({
                uid: UID,
                groupId: "settlement-race",
                expectedCurrency: "USD",
                newCurrency: "EUR",
                rate: 1.5,
                nowMs: NOW + 11,
                db,
            }),
        ]);
        expect(results[1].status).toBe("fulfilled");
        const stored = (await db.collection("groups").doc("settlement-race").get()).data()!;
        expect(stored.currency).toBe("EUR");
        if (stored.settlements.length > 0) expect(stored.settlements[0].amount).toBe(15);
        if (results[0].status === "rejected") {
            expect(results[0].reason).toMatchObject({ code: "aborted" });
        }
    });

    it("acknowledges a duplicate settlement retry after a later conversion", async () => {
        await db.collection("groups").doc("settlement-retry").set(groupData("settlement-retry"));
        const input = settlementInput("settlement-retry", "settlement-retry-1");
        await applySettlementMutation({ uid: UID, input, nowMs: NOW + 20, db });
        await applyGroupCurrencyConversion({
            uid: UID,
            groupId: "settlement-retry",
            expectedCurrency: "USD",
            newCurrency: "EUR",
            rate: 1.5,
            nowMs: NOW + 21,
            db,
        });
        await expect(applySettlementMutation({ uid: UID, input, nowMs: NOW + 22, db }))
            .resolves.toMatchObject({ duplicate: true });
    });

    it("derives recurring internal policy and routes create, update, skip, and delete through one boundary", async () => {
        await db.collection("groups").doc("recurring-crud").set(groupData("recurring-crud", true));
        const create = recurringCreateInput("recurring-crud", "bill-1");
        await expect(applyRecurringBillMutation({ uid: UID, input: create, nowMs: NOW + 30, db }))
            .resolves.toMatchObject({ duplicate: false, billId: "bill-1" });
        expect((await db.collection("recurringBills").doc("bill-1").get()).data()).toMatchObject({
            groupId: "recurring-crud",
            amount: 10,
            requiresAccept: true,
            createdAt: NOW + 30,
            updatedAt: NOW + 30,
        });

        const update: RecurringBillMutationInput = {
            action: "update",
            billId: "bill-1",
            groupId: "recurring-crud",
            expectedCurrency: "USD",
            updates: {
                title: "Updated rent",
                amount: 12,
                participants: [
                    { userId: UID, share: 5 },
                    { userId: FRIEND, share: 7 },
                ],
                requiresAccept: false,
            },
        };
        await applyRecurringBillMutation({ uid: UID, input: update, nowMs: NOW + 31, db });
        expect((await db.collection("recurringBills").doc("bill-1").get()).data()).toMatchObject({
            title: "Updated rent",
            amount: 12,
            requiresAccept: true,
        });

        await applyRecurringBillMutation({
            uid: UID,
            input: {
                action: "skip",
                billId: "bill-1",
                groupId: "recurring-crud",
                expectedCurrency: "USD",
                occurrenceAt: NOW,
            },
            nowMs: NOW + 32,
            db,
        });
        expect((await db.collection("recurringBills").doc("bill-1").get()).data())
            .toMatchObject({ skippedOccurrences: [NOW] });
        await expect(applyRecurringBillMutation({
            uid: UID,
            input: { action: "delete", billId: "bill-1", groupId: "recurring-crud" },
            nowMs: NOW + 33,
            db,
        })).resolves.toMatchObject({ duplicate: false });
    });

    it("serializes recurring creation against conversion and rejects stale edits", async () => {
        await db.collection("groups").doc("recurring-race").set(groupData("recurring-race"));
        const create = recurringCreateInput("recurring-race", "bill-race");
        const results = await Promise.allSettled([
            applyRecurringBillMutation({ uid: UID, input: create, nowMs: NOW + 40, db }),
            applyGroupCurrencyConversion({
                uid: UID,
                groupId: "recurring-race",
                expectedCurrency: "USD",
                newCurrency: "EUR",
                rate: 1.5,
                nowMs: NOW + 41,
                db,
            }),
        ]);
        expect(results[1].status).toBe("fulfilled");
        const bill = await db.collection("recurringBills").doc("bill-race").get();
        if (bill.exists) {
            expect(bill.data()).toMatchObject({
                amount: 15,
                participants: [{ share: 6 }, { share: 9 }],
            });
        } else {
            expect(results[0].status).toBe("rejected");
        }

        if (bill.exists) {
            await expect(applyRecurringBillMutation({
                uid: UID,
                input: {
                    action: "update",
                    billId: "bill-race",
                    groupId: "recurring-race",
                    expectedCurrency: "USD",
                    updates: {
                        amount: 20,
                        participants: [
                            { userId: UID, share: 10 },
                            { userId: FRIEND, share: 10 },
                        ],
                    },
                },
                nowMs: NOW + 42,
                db,
            })).rejects.toMatchObject({ code: "aborted" });
        }
    }, 15_000);

    it("confirms variable amounts with reconciled shares and keeps fixed requests fixed", async () => {
        await db.collection("groups").doc("confirm-variable").set(groupData("confirm-variable"));
        const variable = recurringCreateInput("confirm-variable", "variable-bill");
        variable.bill.amountMode = "variable";
        await applyRecurringBillMutation({ uid: UID, input: variable, nowMs: NOW + 50, db });
        await db.collection("recurringBills").doc("variable-bill").update({ pendingOccurrences: [NOW] });
        const confirmed = await confirmRecurringBillOccurrence({
            uid: UID,
            groupId: "confirm-variable",
            billId: "variable-bill",
            occurrenceAt: NOW,
            amount: 25,
            expectedCurrency: "USD",
            db,
        });
        expect(confirmed).toMatchObject({
            duplicate: false,
            expense: {
                amount: 25,
                participants: [{ share: 10 }, { share: 15 }],
                splitMetadata: {
                    participantConfig: [{ exactAmount: 10 }, { exactAmount: 15 }],
                },
            },
        });

        await db.collection("groups").doc("confirm-fixed").set(groupData("confirm-fixed", true));
        const fixed = recurringCreateInput("confirm-fixed", "fixed-request");
        await applyRecurringBillMutation({ uid: UID, input: fixed, nowMs: NOW + 51, db });
        await db.collection("recurringBills").doc("fixed-request").update({ pendingOccurrences: [NOW] });
        const accepted = await confirmRecurringBillOccurrence({
            uid: FRIEND,
            groupId: "confirm-fixed",
            billId: "fixed-request",
            occurrenceAt: NOW,
            amount: 999,
            expectedCurrency: "USD",
            db,
        });
        expect(accepted.expense).toMatchObject({ amount: 10, participants: [{ share: 4 }, { share: 6 }] });
    });

    it("re-reads recurring state transactionally when generation races conversion", async () => {
        await db.collection("groups").doc("scheduler-race").set(groupData("scheduler-race"));
        const create = recurringCreateInput("scheduler-race", "scheduler-bill");
        create.bill.nextDueAt = NOW;
        await applyRecurringBillMutation({ uid: UID, input: create, nowMs: NOW - 1, db });

        const [generation, conversion] = await Promise.allSettled([
            processGroupDueRecurringBills("scheduler-race", { now: NOW, db }),
            applyGroupCurrencyConversion({
                uid: UID,
                groupId: "scheduler-race",
                expectedCurrency: "USD",
                newCurrency: "EUR",
                rate: 1.5,
                nowMs: NOW + 1,
                db,
            }),
        ]);
        expect(generation.status).toBe("fulfilled");
        expect(conversion.status).toBe("fulfilled");
        const group = (await db.collection("groups").doc("scheduler-race").get()).data()!;
        const generated = group.expenses.find(
            (entry: Record<string, unknown>) => entry.expenseId === `rec_scheduler-bill_${NOW}`,
        );
        expect(group.currency).toBe("EUR");
        expect(generated).toMatchObject({
            amount: 15,
            participants: [{ share: 6 }, { share: 9 }],
        });
    }, 15_000);
});
