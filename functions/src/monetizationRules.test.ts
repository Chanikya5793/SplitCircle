import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    assertFails,
    initializeTestEnvironment,
    type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { afterAll, beforeAll, describe, it } from "vitest";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = emulatorHost ? describe : describe.skip;

describeWithEmulator("server-only monetization Firestore isolation", () => {
    let environment: RulesTestEnvironment;
    const protectedPaths = [
        "monetizationAccountStates/production_account",
        "monetizationInternalTestGrants/production_account",
        "monetizationShadowAccounts/production_account",
        "monetizationShadowAccounts/production_account/events/event-1",
        "monetizationUsageAccounts/production_account",
        "monetizationUsageAccounts/production_account/reservations/reservation-1",
        "monetizationUsageAccounts/production_account/creditLedger/entry-1",
        "monetizationAppleTransactions/production_transaction",
        "monetizationAppleOriginalTransactions/production_original",
        "monetizationAppleAccountTokens/production_token",
        "monetizationAppleNotifications/production_notification",
        "monetizationSandboxCommerceGrants/sandbox_account",
        "monetizationSupportGrants/support-account",
        "monetizationSupportRateLimits/support-rate",
        "monetizationAdminAudit/audit-1",
    ];

    beforeAll(async () => {
        environment = await initializeTestEnvironment({
            projectId: "manasplit-monetization-rules-test",
            firestore: {
                rules: readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8"),
            },
        });
        await environment.withSecurityRulesDisabled(async (context) => {
            for (const path of protectedPaths) {
                await setDoc(doc(context.firestore(), path), { serverOwned: true });
            }
        });
    });

    afterAll(async () => {
        await environment.cleanup();
    });

    it("denies every server-owned record to an authenticated client", async () => {
        const db = environment.authenticatedContext("account-owner").firestore();
        for (const path of protectedPaths) {
            await assertFails(getDoc(doc(db, path)));
        }
    });

    it("denies client creation and mutation in every server-owned namespace", async () => {
        const db = environment.authenticatedContext("account-owner").firestore();
        for (const path of protectedPaths) {
            await assertFails(setDoc(doc(db, path), { forged: true }, { merge: true }));
        }
    });
});
