import { randomUUID } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import firebaseFunctionsTest from "firebase-functions-test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    authorizeMonetizedOperation,
    authorizeServerMeteredOperation,
    finalizeMonetizedOperation,
    finalizeServerMeteredOperation,
    sanitizeAuthorizeMonetizedOperationInput,
} from "./monetizationEnforcement";
import { accountStateRef } from "./monetizationStore";
import { readMonetizationUsage, usageHistoryDays } from "./monetizationUsage";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = emulatorHost ? describe : describe.skip;
const PROJECT_ID = "manasplit-usage-test";
const UID = "usage-user";
const standardAccess = {
    kind: "standard" as const,
    commercialQuotaBypass: false,
    providerSafetyBypass: false as const,
    grantId: null,
    grantExpiresAt: null,
};

describe("client authorization scope", () => {
    it("accepts on-device features but never provider work", () => {
        expect(sanitizeAuthorizeMonetizedOperationInput({
            operationId: randomUUID(),
            featureId: "ai.expense_on_device_turn",
            executionRoute: "on_device_apple",
            useCredits: false,
        })).toMatchObject({ featureId: "ai.expense_on_device_turn" });
        expect(() => sanitizeAuthorizeMonetizedOperationInput({
            operationId: randomUUID(),
            featureId: "provider.security_check",
            executionRoute: "provider",
            useCredits: false,
        })).toThrow(/not enabled/i);
    });

    it("reports a 30-day window ending today", () => {
        const days = usageHistoryDays(Date.parse("2026-10-09T15:00:00.000Z"));
        expect(days).toHaveLength(30);
        expect(days[0]).toBe("2026-09-10");
        expect(days[29]).toBe("2026-10-09");
    });
});

describeWithEmulator("usage limits beyond advanced splits", () => {
    const testEnvironment = firebaseFunctionsTest({ projectId: PROJECT_ID });
    const authorize = testEnvironment.wrap(authorizeMonetizedOperation);
    const finalize = testEnvironment.wrap(finalizeMonetizedOperation);
    const auth = { uid: UID, token: { uid: UID } };

    beforeAll(async () => {
        process.env.MANASPLIT_MONETIZATION_ENVIRONMENT = "sandbox";
        if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID });
        const db = getFirestore();
        await db.recursiveDelete(db.collection("monetizationAccountStates"));
        await db.recursiveDelete(db.collection("monetizationUsageAccounts"));
        await db.recursiveDelete(db.collection("monetizationAppleAccountTokens"));
    });

    afterAll(() => {
        delete process.env.MANASPLIT_MONETIZATION_ENVIRONMENT;
        testEnvironment.cleanup();
    });

    const aiTurn = (operationId: string) => ({
        data: {
            operationId,
            featureId: "ai.expense_on_device_turn",
            executionRoute: "on_device_apple",
            useCredits: false,
        },
        auth,
    });

    it("caps free AI assistant messages per day and never offers credits for them", async () => {
        for (let index = 0; index < 3; index += 1) {
            const operationId = randomUUID();
            const decision = await authorize(aiTurn(operationId) as never);
            expect(decision).toMatchObject({ allowed: true, source: "included_use", remaining: 2 - index });
            await finalize({
                data: { operationId, authorizationId: decision.authorizationId, outcome: "completed" },
                auth,
            } as never);
        }
        const denied = await authorize(aiTurn(randomUUID()) as never);
        expect(denied).toMatchObject({
            allowed: false,
            source: "quota_exhausted",
            reasonCode: "upgrade_required",
            creditCost: null,
        });
    });

    it("meters provider checks server-side and spends credits only with consent", async () => {
        const db = getFirestore();
        const check = (operationKey: string, useCredits = false) => authorizeServerMeteredOperation({
            uid: UID,
            environment: "sandbox",
            access: standardAccess,
            featureId: "provider.security_check",
            operationKey,
            useCredits,
            db,
        });
        for (let index = 0; index < 3; index += 1) {
            const operationKey = `url-check:${randomUUID()}`;
            const decision = await check(operationKey);
            expect(decision.allowed).toBe(true);
            await finalizeServerMeteredOperation({
                uid: UID,
                environment: "sandbox",
                authorization: decision,
                operationKey,
                outcome: "completed",
                db,
            });
        }
        expect(await check(`url-check:${randomUUID()}`)).toMatchObject({
            allowed: false,
            reasonCode: "credit_consent_required",
            creditCost: 2,
        });

        await accountStateRef("sandbox", UID, db).update({ creditBalance: 5 });
        const operationKey = `url-check:${randomUUID()}`;
        const paid = await check(operationKey, true);
        expect(paid).toMatchObject({ allowed: true, source: "credits", creditBalance: 3 });
        await finalizeServerMeteredOperation({
            uid: UID,
            environment: "sandbox",
            authorization: paid,
            operationKey,
            outcome: "completed",
            db,
        });

        // A provider failure after reservation hands the credits back.
        const failedKey = `url-check:${randomUUID()}`;
        const failed = await check(failedKey, true);
        expect(failed).toMatchObject({ allowed: true, creditBalance: 1 });
        const released = await finalizeServerMeteredOperation({
            uid: UID,
            environment: "sandbox",
            authorization: failed,
            operationKey: failedKey,
            outcome: "failed",
            db,
        });
        expect(released).toMatchObject({ creditBalance: 3 });
    });

    it("summarizes meters, daily activity and credit history", async () => {
        const summary = await readMonetizationUsage({
            uid: UID,
            environment: "sandbox",
            access: standardAccess,
            nowMs: Date.now(),
            db: getFirestore(),
        });
        expect(summary).toMatchObject({ planId: "free", creditBalance: 3 });
        const ai = summary.features.find((feature) => feature.featureId === "ai.expense_on_device_turn");
        expect(ai).toMatchObject({ used: 3, limit: 3, remaining: 0, label: "AI assistant messages" });
        const checks = summary.features.find((feature) => feature.featureId === "provider.security_check");
        // Included uses only: the credit-paid check does not count against the window.
        expect(checks).toMatchObject({ used: 3, limit: 3, remaining: 0, creditCost: 2 });
        const split = summary.features.find((feature) => feature.featureId === "advanced_split.completion");
        expect(split?.previews?.every((preview) => preview.claimed === false)).toBe(true);

        const today = summary.daily[summary.daily.length - 1];
        expect(today.counts).toMatchObject({
            "ai.expense_on_device_turn": 3,
            "provider.security_check": 4,
        });
        expect(today.creditsSpent).toBe(2);
        expect(summary.ledger.map((item) => [item.status, item.creditDelta])).toEqual(
            expect.arrayContaining([["spent", -2], ["released", 0]]),
        );
    });
});
