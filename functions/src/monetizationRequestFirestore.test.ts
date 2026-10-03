import { getApps, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monetizationAccountDocumentId } from "./monetizationCore";
import { resolveRequestMonetizationContext } from "./monetizationRequest";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = emulatorHost ? describe : describe.skip;
const PROJECT_ID = "manasplit-commerce-environment-test";
const NOW_MS = Date.parse("2026-09-07T17:00:00.000Z");
const ISSUED_AT = Math.floor(NOW_MS / 1_000) - 60;
const EXPIRES_AT = ISSUED_AT + 24 * 60 * 60;

describeWithEmulator("production Firebase sandbox commerce selection", () => {
    beforeAll(async () => {
        process.env.MANASPLIT_MONETIZATION_ENVIRONMENT = "production";
        if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID });
        const db = getFirestore();
        await db.recursiveDelete(db.collection("monetizationInternalTestGrants"));
        await db.recursiveDelete(db.collection("monetizationSandboxCommerceGrants"));
    });

    afterAll(() => {
        delete process.env.MANASPLIT_MONETIZATION_ENVIRONMENT;
    });

    it("selects the sandbox ledger and quota bypass only for an exact internal grant", async () => {
        const uid = "owner-test-user";
        const grantId = "e7753935-c707-4106-ad09-2d8c4326cf92";
        const claim = {
            version: 1,
            role: "internal_tester",
            scope: "commercial_limits_only",
            environment: "sandbox",
            providerSafetyBypass: false,
            subjectUid: uid,
            grantId,
            reasonCode: "OWNER_TESTING",
            issuedAtEpochSeconds: ISSUED_AT,
            expiresAtEpochSeconds: EXPIRES_AT,
        };
        await getFirestore().collection("monetizationInternalTestGrants")
            .doc(monetizationAccountDocumentId("sandbox", uid)).set({
                schemaVersion: 1,
                status: "active",
                role: "internal_tester",
                scope: "commercial_limits_only",
                environment: "sandbox",
                providerSafetyBypass: false,
                subjectUid: uid,
                grantId,
                reasonCode: "OWNER_TESTING",
                issuedAt: Timestamp.fromMillis(ISSUED_AT * 1_000),
                expiresAt: Timestamp.fromMillis(EXPIRES_AT * 1_000),
            });
        const context = await resolveRequestMonetizationContext({
            auth: { uid, token: { manasplitInternalTest: claim } },
        }, NOW_MS);
        expect(context).toMatchObject({
            environment: "sandbox",
            sandboxCommerce: true,
            access: {
                kind: "internal_test",
                commercialQuotaBypass: true,
                providerSafetyBypass: false,
            },
        });
    });

    it("selects sandbox verification without quota bypass for App Review", async () => {
        const uid = "app-review-user";
        const grantId = "067bcd20-a5b6-4453-94af-36aeb7db0510";
        const claim = {
            version: 1,
            role: "sandbox_commerce_tester",
            environment: "sandbox",
            subjectUid: uid,
            grantId,
            issuedAtEpochSeconds: ISSUED_AT,
            expiresAtEpochSeconds: EXPIRES_AT,
        };
        await getFirestore().collection("monetizationSandboxCommerceGrants")
            .doc(monetizationAccountDocumentId("sandbox", uid)).set({
                schemaVersion: 1,
                status: "active",
                role: "sandbox_commerce_tester",
                environment: "sandbox",
                subjectUid: uid,
                grantId,
                issuedAt: Timestamp.fromMillis(ISSUED_AT * 1_000),
                expiresAt: Timestamp.fromMillis(EXPIRES_AT * 1_000),
            });
        const context = await resolveRequestMonetizationContext({
            auth: { uid, token: { manasplitSandboxCommerce: claim } },
        }, NOW_MS);
        expect(context).toMatchObject({
            environment: "sandbox",
            sandboxCommerce: true,
            access: {
                kind: "standard",
                commercialQuotaBypass: false,
                providerSafetyBypass: false,
            },
        });
    });

    it("ignores client-like sandbox flags without a signed server grant", async () => {
        const context = await resolveRequestMonetizationContext({
            auth: {
                uid: "ordinary-user",
                token: { distribution: "testflight", sandboxCommerce: true },
            },
        }, NOW_MS);
        expect(context).toMatchObject({
            environment: "production",
            sandboxCommerce: false,
            access: { commercialQuotaBypass: false },
        });
    });
});
