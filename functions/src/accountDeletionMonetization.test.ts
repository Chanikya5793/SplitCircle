import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    deleteMonetizationData,
    getMonetizationDeletionDocumentIds,
} from "./accountDeletion";
import { hashOpaque, monetizationAccountDocumentId } from "./monetizationCore";
import { appleAccountTokenDocumentId } from "./monetizationStore";

describe("account deletion monetization namespaces", () => {
    it("covers sandbox and production using the server's opaque account IDs", () => {
        const ids = getMonetizationDeletionDocumentIds("owner-uid");
        expect(ids).toEqual({
            sandbox: monetizationAccountDocumentId("sandbox", "owner-uid"),
            production: monetizationAccountDocumentId("production", "owner-uid"),
        });
        expect(ids.sandbox).not.toContain("owner-uid");
        expect(ids.production).not.toContain("owner-uid");
        expect(ids.sandbox).not.toBe(ids.production);
    });
});

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = emulatorHost ? describe : describe.skip;

describeWithEmulator("account deletion monetization data cleanup", () => {
    const appName = "account-deletion-monetization-test";
    const uid = "deleting-user";
    let db: Firestore;
    const tokens = {
        sandbox: "d52a7cbd-30d1-48a9-a48e-75a12216ef43",
        production: "c0940e0f-9eb8-460e-905b-341b79d2dfa4",
    } as const;

    beforeAll(async () => {
        const app = getApps().find((candidate) => candidate.name === appName) ?? initializeApp({
            projectId: "manasplit-account-deletion-monetization-test",
        }, appName);
        db = getFirestore(app);
        const ids = getMonetizationDeletionDocumentIds(uid);
        for (const [environment, accountId] of Object.entries(ids) as Array<[
            "sandbox" | "production",
            string,
        ]>) {
            await db.collection("monetizationAccountStates").doc(accountId).set({
                uid,
                appAccountToken: tokens[environment],
            });
            await db.collection("monetizationInternalTestGrants").doc(accountId).set({ subjectUid: uid });
            await db.collection("monetizationSandboxCommerceGrants").doc(accountId).set({ subjectUid: uid });
            await db.collection("monetizationAppleAccountTokens")
                .doc(appleAccountTokenDocumentId(environment, tokens[environment]))
                .set({ accountDocumentId: accountId });
            const root = db.collection("monetizationShadowAccounts").doc(accountId);
            await root.set({ uid });
            await root.collection("events").doc("event-1").set({ featureId: "test" });
            const usage = db.collection("monetizationUsageAccounts").doc(accountId);
            await usage.set({ uid });
            await usage.collection("reservations").doc("reservation-1").set({ status: "reserved" });
            await db.collection("monetizationAppleTransactions").doc(`${environment}-transaction`)
                .set({ accountDocumentId: accountId, transactionId: `${environment}-transaction-id` });
            await db.collection("monetizationAppleOriginalTransactions").doc(`${environment}-original`)
                .set({ accountDocumentId: accountId, originalTransactionId: `${environment}-original-id` });
            await db.collection("monetizationAppleNotifications").doc(`${environment}-notification`)
                .set({ accountDocumentId: accountId, notificationUUID: `${environment}-notification-id` });
        }
        await db.collection("monetizationAdminAudit").doc("delete-me").set({ subjectUid: uid });
        await db.collection("monetizationAdminAudit").doc("delete-actor").set({ actorUid: uid });
        await db.collection("monetizationAdminAudit").doc("keep-me").set({ subjectUid: "other-user" });
        await db.collection("monetizationSupportGrants")
            .doc(hashOpaque(["support-grant-v1", uid])).set({ subjectUid: uid });
        await db.collection("monetizationSupportRateLimits").doc("delete-rate")
            .set({ actorUid: uid });
    });

    afterAll(async () => {
        const app = getApps().find((candidate) => candidate.name === appName);
        if (app) await deleteApp(app);
    });

    it("removes account data and leaves only de-identified purchase tombstones", async () => {
        await deleteMonetizationData(db, uid);
        const ids = getMonetizationDeletionDocumentIds(uid);
        for (const accountId of Object.values(ids)) {
            expect((await db.collection("monetizationAccountStates").doc(accountId).get()).exists).toBe(false);
            expect((await db.collection("monetizationInternalTestGrants").doc(accountId).get()).exists).toBe(false);
            expect((await db.collection("monetizationSandboxCommerceGrants").doc(accountId).get()).exists)
                .toBe(false);
            const root = db.collection("monetizationShadowAccounts").doc(accountId);
            expect((await root.get()).exists).toBe(false);
            expect((await root.collection("events").get()).empty).toBe(true);
            const usage = db.collection("monetizationUsageAccounts").doc(accountId);
            expect((await usage.get()).exists).toBe(false);
            expect((await usage.collection("reservations").get()).empty).toBe(true);
            const environment = accountId.startsWith("sandbox_") ? "sandbox" : "production";
            expect((await db.collection("monetizationAppleAccountTokens")
                .doc(appleAccountTokenDocumentId(environment, tokens[environment])).get()).exists)
                .toBe(false);
            for (const [collection, suffix] of [
                ["monetizationAppleTransactions", "transaction"],
                ["monetizationAppleOriginalTransactions", "original"],
                ["monetizationAppleNotifications", "notification"],
            ] as const) {
                const tombstone = await db.collection(collection).doc(`${environment}-${suffix}`).get();
                expect(tombstone.exists).toBe(true);
                expect(tombstone.data()).toMatchObject({
                    accountDocumentId: null,
                    ownerDeleted: true,
                });
            }
        }
        expect((await db.collection("monetizationAdminAudit").doc("delete-me").get()).exists).toBe(false);
        expect((await db.collection("monetizationAdminAudit").doc("delete-actor").get()).exists)
            .toBe(false);
        expect((await db.collection("monetizationAdminAudit").doc("keep-me").get()).exists).toBe(true);
        expect((await db.collection("monetizationSupportGrants")
            .doc(hashOpaque(["support-grant-v1", uid])).get()).exists).toBe(false);
        expect((await db.collection("monetizationSupportRateLimits").doc("delete-rate").get()).exists)
            .toBe(false);
    });
});
