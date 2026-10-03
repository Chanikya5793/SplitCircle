import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import firebaseFunctionsTest from "firebase-functions-test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    authorizeMonetizedOperation,
    finalizeMonetizedOperation,
    releaseMonetizationReservation,
    sanitizeAuthorizeMonetizedOperationInput,
} from "./monetizationEnforcement";
import { accountDocumentId, accountStateRef } from "./monetizationStore";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = emulatorHost ? describe : describe.skip;
const PROJECT_ID = "manasplit-enforcement-test";
const UID = "quota-user";
const IDS = [
    "11c62f22-c4d5-4f0b-915c-622b02ac3bb9",
    "513e4ca8-8d58-45f5-8969-f83d4f770795",
    "168e4413-9a17-4335-8f9b-59de385d0e77",
    "6edbd078-892c-4722-a5e6-d03668350cfd",
    "b30a0200-6f38-45d5-9600-4ff00df17ac7",
    "86de2f68-e5d1-4f2e-8ad8-139086547a44",
] as const;

describe("monetized operation input", () => {
    it("requires explicit credit consent and catalog-valid feature metadata", () => {
        expect(() => sanitizeAuthorizeMonetizedOperationInput({
            operationId: IDS[0],
            featureId: "advanced_split.completion",
            variant: "income",
            executionRoute: "local_deterministic",
        })).toThrow(/useCredits/i);
        expect(() => sanitizeAuthorizeMonetizedOperationInput({
            operationId: IDS[0],
            featureId: "advanced_split.completion",
            variant: "roulette",
            executionRoute: "local_deterministic",
            useCredits: false,
        })).toThrow(/variant/i);
    });
});

describeWithEmulator("server-enforced quota and credit reservations", () => {
    const testEnvironment = firebaseFunctionsTest({ projectId: PROJECT_ID });
    const authorize = testEnvironment.wrap(authorizeMonetizedOperation);
    const finalize = testEnvironment.wrap(finalizeMonetizedOperation);

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

    const auth = { uid: UID, token: { uid: UID } };
    const authorizationRequest = (operationId: string, useCredits = false) => ({
        data: {
            operationId,
            featureId: "advanced_split.completion",
            variant: "income",
            executionRoute: "local_deterministic",
            useCredits,
        },
        auth,
    });

    it("reserves a preview, consumes included quota, and refunds an abandoned credit", async () => {
        for (let index = 0; index < 4; index += 1) {
            const authorized = await authorize(authorizationRequest(IDS[index] as string) as never);
            expect(authorized.allowed).toBe(true);
            expect(authorized.source).toBe(index === 0 ? "preview" : "included_use");
            const finalized = await finalize({
                data: {
                    operationId: IDS[index],
                    authorizationId: authorized.authorizationId,
                    outcome: "completed",
                },
                auth,
            } as never);
            expect(finalized).toMatchObject({ accepted: true, duplicate: false, outcome: "completed" });
        }

        const denied = await authorize(authorizationRequest(IDS[4]) as never);
        expect(denied).toMatchObject({
            allowed: false,
            authorizationId: null,
            source: "quota_exhausted",
            reasonCode: "credit_consent_required",
            creditCost: 1,
            creditBalance: 0,
        });

        const accountRef = accountStateRef("sandbox", UID);
        await accountRef.update({ creditBalance: 2 });
        const withCredits = await authorize(authorizationRequest(IDS[4], true) as never);
        expect(withCredits).toMatchObject({
            allowed: true,
            source: "credits",
            creditBalance: 1,
        });
        const released = await finalize({
            data: {
                operationId: IDS[4],
                authorizationId: withCredits.authorizationId,
                outcome: "failed",
            },
            auth,
        } as never);
        expect(released).toMatchObject({
            accepted: true,
            duplicate: false,
            outcome: "failed",
            creditBalance: 2,
        });
        const retry = await finalize({
            data: {
                operationId: IDS[4],
                authorizationId: withCredits.authorizationId,
                outcome: "failed",
            },
            auth,
        } as never);
        expect(retry).toMatchObject({ duplicate: true, creditBalance: 2 });

        const replayedAuthorization = await authorize(authorizationRequest(IDS[0]) as never);
        expect(replayedAuthorization).toMatchObject({
            allowed: false,
            authorizationId: null,
            reasonCode: "operation_already_finalized",
        });
    });

    it("lets the reaper release an expired reservation", async () => {
        const authorized = await authorize(authorizationRequest(IDS[5], true) as never);
        expect(authorized.allowed).toBe(true);
        const future = Date.now() + 16 * 60 * 1_000;
        const released = await releaseMonetizationReservation({
            db: getFirestore(),
            accountId: accountDocumentId("sandbox", UID),
            reservationId: authorized.authorizationId,
            nowMs: future,
        });
        expect(released).toMatchObject({ accepted: true, outcome: "abandoned" });
    });
});
