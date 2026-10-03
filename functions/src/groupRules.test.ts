import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
    type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeAll, describe, it } from "vitest";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = emulatorHost ? describe : describe.skip;

describeWithEmulator("group membership Firestore isolation", () => {
    let environment: RulesTestEnvironment;

    beforeAll(async () => {
        environment = await initializeTestEnvironment({
            projectId: "manasplit-group-rules-test",
            firestore: {
                rules: readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8"),
            },
        });
        await environment.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), "groups/group-1"), {
                groupId: "group-1",
                name: "Review Group",
                currency: "USD",
                inviteCode: "SECRET",
                createdBy: "alice",
                memberIds: ["alice"],
                members: [{ userId: "alice", displayName: "Alice", role: "owner", balance: 0 }],
                archivedMembers: [],
                expenses: [],
                settlements: [],
                createdAt: 1,
                updatedAt: 1,
            });
        });
    });

    afterAll(async () => {
        await environment.cleanup();
    });

    it("denies a direct join by a signed-in non-member who knows the group ID", async () => {
        const db = environment.authenticatedContext("mallory").firestore();
        await assertFails(updateDoc(doc(db, "groups/group-1"), {
            memberIds: ["alice", "mallory"],
            members: [
                { userId: "alice", displayName: "Alice", role: "owner", balance: 0 },
                { userId: "mallory", displayName: "Mallory", role: "member", balance: 0 },
            ],
            archivedMembers: [],
            updatedAt: 2,
        }));
    });

    it("denies a member changing another member's role directly", async () => {
        await environment.withSecurityRulesDisabled(async (context) => {
            await updateDoc(doc(context.firestore(), "groups/group-1"), {
                memberIds: ["alice", "bob"],
                members: [
                    { userId: "alice", displayName: "Alice", role: "owner", balance: 0 },
                    { userId: "bob", displayName: "Bob", role: "member", balance: 0 },
                ],
            });
        });
        const db = environment.authenticatedContext("bob").firestore();
        await assertFails(updateDoc(doc(db, "groups/group-1"), {
            members: [
                { userId: "alice", displayName: "Alice", role: "owner", balance: 0 },
                { userId: "bob", displayName: "Bob", role: "admin", balance: 0 },
            ],
            updatedAt: 3,
        }));
    });

    it("allows only the caller to remove themselves through the direct departure rule", async () => {
        const db = environment.authenticatedContext("bob").firestore();
        await assertSucceeds(updateDoc(doc(db, "groups/group-1"), {
            memberIds: ["alice"],
            members: [{ userId: "alice", displayName: "Alice", role: "owner", balance: 0 }],
            archivedMembers: [{ userId: "bob", displayName: "Bob", role: "member", balance: 0 }],
            updatedAt: 4,
        }));
    });

    it("denies direct expense persistence even to a group member", async () => {
        await environment.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), "groups/group-expense-boundary"), {
                groupId: "group-expense-boundary",
                name: "Billing Boundary",
                currency: "USD",
                inviteCode: "BOUNDARY",
                createdBy: "alice",
                memberIds: ["alice"],
                members: [{ userId: "alice", displayName: "Alice", role: "owner", balance: 0 }],
                archivedMembers: [],
                expenses: [],
                settlements: [],
                createdAt: 1,
                updatedAt: 1,
            });
        });
        const db = environment.authenticatedContext("alice").firestore();
        const advancedExpense = {
            expenseId: "forged-advanced",
            groupId: "group-expense-boundary",
            amount: 10,
            splitMetadata: { version: 1, method: "income", participantConfig: [] },
        };
        await assertFails(updateDoc(doc(db, "groups/group-expense-boundary"), {
            expenses: [advancedExpense],
            updatedAt: 2,
        }));
        await assertFails(setDoc(doc(db, "expenses/forged-advanced"), advancedExpense));
        await assertFails(setDoc(doc(db, "groups/group-expense-boundary/expenses/forged-advanced"), advancedExpense));
    });

    it("denies bypassing the server conversion by changing currency directly", async () => {
        const db = environment.authenticatedContext("alice").firestore();
        await assertFails(updateDoc(doc(db, "groups/group-1"), {
            currency: "EUR",
            updatedAt: 5,
        }));
    });

    it("denies direct settlement mutations even to a group member", async () => {
        const db = environment.authenticatedContext("alice").firestore();
        await assertFails(updateDoc(doc(db, "groups/group-1"), {
            settlements: [{
                settlementId: "forged-settlement",
                fromUserId: "alice",
                toUserId: "bob",
                amount: 25,
                status: "completed",
                createdAt: 1,
            }],
            updatedAt: 6,
        }));
    });

    it("denies direct recurring-bill create, update, and delete", async () => {
        await environment.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), "recurringBills/bill-1"), {
                groupId: "group-1",
                title: "Rent",
                amount: 100,
                isActive: true,
            });
        });
        const db = environment.authenticatedContext("alice").firestore();
        await assertFails(setDoc(doc(db, "recurringBills/forged-bill"), {
            groupId: "group-1",
            title: "Forged",
            amount: 1,
        }));
        await assertFails(updateDoc(doc(db, "recurringBills/bill-1"), { amount: 1 }));
        await assertFails(deleteDoc(doc(db, "recurringBills/bill-1")));
    });

    it("denies creating a group pre-seeded with financial records", async () => {
        const db = environment.authenticatedContext("mallory").firestore();
        const base = {
            groupId: "seeded-group",
            name: "Seeded",
            currency: "USD",
            inviteCode: "SEEDED",
            createdBy: "mallory",
            memberIds: ["mallory"],
            members: [{ userId: "mallory", displayName: "Mallory", role: "owner", balance: 0 }],
            archivedMembers: [],
            settlements: [],
            expenses: [],
            createdAt: 1,
            updatedAt: 1,
        };
        await assertFails(setDoc(doc(db, "groups/seeded-expense"), {
            ...base,
            groupId: "seeded-expense",
            expenses: [{ expenseId: "forged", amount: 10 }],
        }));
        await assertFails(setDoc(doc(db, "groups/seeded-settlement"), {
            ...base,
            groupId: "seeded-settlement",
            settlements: [{ settlementId: "forged", amount: 10 }],
        }));
        await assertSucceeds(setDoc(doc(db, "groups/empty-financials"), {
            ...base,
            groupId: "empty-financials",
        }));
    });
});
