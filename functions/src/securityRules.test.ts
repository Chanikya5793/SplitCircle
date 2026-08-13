import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment,
    type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
import { afterAll, beforeAll, describe, it } from "vitest";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = emulatorHost ? describe : describe.skip;

describeWithEmulator("security monitoring Firestore isolation", () => {
    let environment: RulesTestEnvironment;

    beforeAll(async () => {
        environment = await initializeTestEnvironment({
            projectId: "manasplit-security-rules-test",
            firestore: {
                rules: readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8"),
            },
        });
        await environment.withSecurityRulesDisabled(async (context) => {
            await setDoc(doc(context.firestore(), "securityMonitors/alice"), {
                enabled: true,
                wrappedDek: "kms-ciphertext",
            });
            await setDoc(doc(context.firestore(), "securityMonitors/alice/identities/i1"), {
                encryptedValue: { ciphertext: "ciphertext" },
            });
            await setDoc(doc(context.firestore(), "securityMonitors/alice/findings/f1"), {
                title: "Normalized finding",
            });
            await setDoc(doc(context.firestore(), "securityProviderDeletions/d1"), {
                provider: "flare",
                status: "pending",
            });
            await setDoc(doc(context.firestore(), "securityProviderIdentifierRefs/r1"), {
                provider: "flare",
                providerReference: "42",
                referenceCount: 2,
            });
        });
    });

    afterAll(async () => {
        await environment.cleanup();
    });

    it("denies even the owner direct access to encrypted monitor storage", async () => {
        const db = environment.authenticatedContext("alice").firestore();
        await assertFails(getDoc(doc(db, "securityMonitors/alice")));
        await assertFails(getDoc(doc(db, "securityMonitors/alice/identities/i1")));
        await assertFails(getDocs(collection(db, "securityMonitors/alice/findings")));
        await assertFails(setDoc(doc(db, "securityMonitors/alice/findings/client-write"), { title: "forged" }));
    });

    it("denies cross-user and anonymous reads", async () => {
        const bob = environment.authenticatedContext("bob").firestore();
        const anonymous = environment.unauthenticatedContext().firestore();
        await assertFails(getDoc(doc(bob, "securityMonitors/alice/findings/f1")));
        await assertFails(getDoc(doc(anonymous, "securityMonitors/alice/findings/f1")));
    });

    it("keeps provider-deletion tombstones server-only", async () => {
        const db = environment.authenticatedContext("alice").firestore();
        await assertFails(getDoc(doc(db, "securityProviderDeletions/d1")));
        await assertFails(setDoc(doc(db, "securityProviderDeletions/forged"), { status: "done" }));
        await assertSucceeds(environment.withSecurityRulesDisabled((context) =>
            getDoc(doc(context.firestore(), "securityProviderDeletions/d1"))));
    });

    it("keeps shared provider reference counts server-only", async () => {
        const db = environment.authenticatedContext("alice").firestore();
        await assertFails(getDoc(doc(db, "securityProviderIdentifierRefs/r1")));
        await assertFails(setDoc(doc(db, "securityProviderIdentifierRefs/forged"), { referenceCount: 0 }));
    });
});
