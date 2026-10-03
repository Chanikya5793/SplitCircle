import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import firebaseFunctionsTest from "firebase-functions-test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordMonetizationUsage } from "./monetization";
import { getMonetizationStoragePaths } from "./monetization";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = emulatorHost ? describe : describe.skip;
const PROJECT_ID = "manasplit-monetization-test";
const UID = "shadow-user";
const OPERATION_ID = "8ae9c043-9a18-4768-a58b-29f3a8e6c67f";

describeWithEmulator("monetization shadow Firestore transaction", () => {
    const testEnvironment = firebaseFunctionsTest({ projectId: PROJECT_ID });
    const wrapped = testEnvironment.wrap(recordMonetizationUsage);

    beforeAll(async () => {
        process.env.MANASPLIT_MONETIZATION_ENVIRONMENT = "sandbox";
        if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID });
        const db = getFirestore();
        await db.recursiveDelete(db.collection("monetizationAccountStates"));
        await db.recursiveDelete(db.collection("monetizationShadowAccounts"));
        await db.recursiveDelete(db.collection("monetizationInternalTestGrants"));
    });

    afterAll(() => {
        delete process.env.MANASPLIT_MONETIZATION_ENVIRONMENT;
        testEnvironment.cleanup();
    });

    const request = (outcome: "completed" | "failed" = "completed") => ({
        data: {
            operationId: OPERATION_ID,
            featureId: "advanced_split.completion",
            outcome,
            variant: "income",
            executionRoute: "local_deterministic",
            connectivity: "offline_reconciled",
            app: { platform: "ios", distribution: "testflight" },
            amount: 901.22,
            groupId: "must-not-persist",
            receiptText: "must-not-persist",
        },
        auth: { uid: UID, token: { uid: UID } },
    });

    it("deduplicates retries atomically and stores only the privacy projection", async () => {
        const first = await wrapped(request() as never);
        const retry = await wrapped(request() as never);
        expect(first).toMatchObject({
            accepted: true,
            duplicate: false,
            enforcementApplied: false,
            allowed: true,
            environment: "sandbox",
            shadowDecision: { source: "preview", claimedPreview: true },
            offline: { reconciled: true, leaseVerified: false, windowBasis: "server_received_at" },
        });
        expect(retry).toMatchObject({ duplicate: true });

        const paths = getMonetizationStoragePaths({
            environment: "sandbox",
            uid: UID,
            operationId: OPERATION_ID,
        });
        const event = await getFirestore().doc(paths.event as string).get();
        expect(event.exists).toBe(true);
        const serialized = JSON.stringify(event.data());
        expect(serialized).not.toContain("must-not-persist");
        expect(serialized).not.toContain("901.22");
        expect(serialized).not.toContain(OPERATION_ID);

        const account = getFirestore().doc(paths.shadowAccount);
        expect((await account.collection("events").get()).size).toBe(1);
        expect((await account.collection("previews").get()).size).toBe(1);
        expect((await account.collection("usageWindows").get()).size).toBe(0);
        const ingestion = await account.collection("ingestionWindows").get();
        expect(ingestion.size).toBe(1);
        expect(ingestion.docs[0]?.data().count).toBe(1);
    });

    it("rejects reusing an operation id for a different terminal outcome", async () => {
        await expect(wrapped(request("failed") as never)).rejects.toMatchObject({
            code: "failed-precondition",
            details: { reasonCode: "IDEMPOTENCY_KEY_REUSED" },
        });
    });
});
