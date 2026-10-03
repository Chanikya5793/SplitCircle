import { getApps, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    grantCourtesyCreditsForSupport,
    requireSupportActor,
    releaseReservationForSupport,
    setMonetizationTestAccessForAdmin,
    setMonetizationTestAccessForTrustedLocalOperator,
    type MonetizationTestAccessAuth,
} from "./monetizationSupport";
import {
    accountDocumentId,
    accountStateRef,
    ensureMonetizationAccount,
} from "./monetizationStore";
import { hashOpaque } from "./monetizationCore";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeWithEmulator = emulatorHost ? describe : describe.skip;
const PROJECT_ID = "manasplit-support-test";
const UID = "courtesy-credit-user";
const TEST_NOW_MS = Date.UTC(2026, 8, 7, 12);

class MemoryTestAccessAuth implements MonetizationTestAccessAuth {
    readonly users = new Map<string, {
        disabled: boolean;
        customClaims: Record<string, unknown>;
    }>();
    revokedUids: string[] = [];
    setClaimUids: string[] = [];
    beforeSet: ((uid: string, claims: Record<string, unknown>) => Promise<void>) | null = null;

    addUser(uid: string, customClaims: Record<string, unknown> = {}, disabled = false): void {
        this.users.set(uid, { disabled, customClaims: { ...customClaims } });
    }

    async getUser(uid: string) {
        const user = this.users.get(uid);
        if (!user) throw new Error(`Unknown fake user: ${uid}`);
        return { disabled: user.disabled, customClaims: { ...user.customClaims } };
    }

    async setCustomUserClaims(uid: string, claims: Record<string, unknown>): Promise<void> {
        this.setClaimUids.push(uid);
        if (this.beforeSet) await this.beforeSet(uid, claims);
        const user = this.users.get(uid);
        if (!user) throw new Error(`Unknown fake user: ${uid}`);
        user.customClaims = { ...claims };
    }

    async revokeRefreshTokens(uid: string): Promise<void> {
        this.revokedUids.push(uid);
    }
}

describeWithEmulator("support courtesy credit idempotency", () => {
    beforeAll(async () => {
        if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID });
        const db = getFirestore();
        await Promise.all([
            db.recursiveDelete(db.collection("monetizationAccountStates")),
            db.recursiveDelete(db.collection("monetizationUsageAccounts")),
            db.recursiveDelete(db.collection("monetizationAppleAccountTokens")),
            db.recursiveDelete(db.collection("monetizationSupportRateLimits")),
            db.recursiveDelete(db.collection("monetizationAdminAudit")),
            db.recursiveDelete(db.collection("monetizationInternalTestGrants")),
            db.recursiveDelete(db.collection("monetizationSandboxCommerceGrants")),
            db.recursiveDelete(db.collection("monetizationTestAccessOperations")),
            db.recursiveDelete(db.collection("monetizationTestAccessControls")),
            db.recursiveDelete(db.collection("monetizationSupportGrants")),
        ]);
    });

    afterAll(async () => {
        await Promise.all(getApps().map((app) => app.delete()));
    });

    const request = (overrides: Partial<Parameters<typeof grantCourtesyCreditsForSupport>[0]> = {}) => ({
        db: getFirestore(),
        actor: { uid: "support-agent-a", role: "support" as const },
        targetUid: UID,
        environment: "sandbox" as const,
        reasonCode: "PURCHASE_RECOVERY",
        ticketId: "ticket-4471",
        amount: 25,
        nowMs: Date.UTC(2026, 8, 7, 12),
        ...overrides,
    });

    it("rejects a cached admin token after the server-side admin claim is removed", async () => {
        const auth = new MemoryTestAccessAuth();
        auth.addUser("former-admin", { admin: false });

        await expect(requireSupportActor({
            auth: { uid: "former-admin", token: { admin: true } },
        }, "monetization.credit_grant", { auth })).rejects.toMatchObject({
            code: "permission-denied",
        });
    });

    it("rejects a cached admin token after the server-side account is disabled", async () => {
        const auth = new MemoryTestAccessAuth();
        auth.addUser("disabled-admin", { admin: true }, true);

        await expect(requireSupportActor({
            auth: { uid: "disabled-admin", token: { admin: true } },
        }, "monetization.read", { auth })).rejects.toMatchObject({
            code: "permission-denied",
        });
    });

    it("preserves exact server-backed support-scope authorization", async () => {
        const db = getFirestore();
        const auth = new MemoryTestAccessAuth();
        const uid = "scoped-support-agent";
        auth.addUser(uid);
        const grantId = "60eb7e5a-7979-4cb5-8631-32ecf0b50a47";
        const issuedAt = Math.floor(TEST_NOW_MS / 1_000) - 60;
        const expiresAt = Math.floor(TEST_NOW_MS / 1_000) + 60 * 60;
        await db.collection("monetizationSupportGrants")
            .doc(hashOpaque(["support-grant-v1", uid]))
            .set({
                status: "active",
                subjectUid: uid,
                grantId,
                scopes: ["monetization.read"],
                expiresAt: Timestamp.fromMillis(expiresAt * 1_000),
            });

        const actor = await requireSupportActor({
            auth: {
                uid,
                token: {
                    manasplitSupport: {
                        version: 1,
                        role: "support",
                        subjectUid: uid,
                        grantId,
                        scopes: ["monetization.read"],
                        issuedAtEpochSeconds: issuedAt,
                        expiresAtEpochSeconds: expiresAt,
                    },
                },
            },
        }, "monetization.read", { auth, db, nowMs: TEST_NOW_MS });

        expect(actor).toEqual({ uid, role: "support" });
        await expect(requireSupportActor({
            auth: {
                uid,
                token: {
                    manasplitSupport: {
                        version: 1,
                        role: "support",
                        subjectUid: uid,
                        grantId,
                        scopes: ["monetization.read"],
                        issuedAtEpochSeconds: issuedAt,
                        expiresAtEpochSeconds: expiresAt,
                    },
                },
            },
        }, "monetization.credit_grant", { auth, db, nowMs: TEST_NOW_MS }))
            .rejects.toMatchObject({ code: "permission-denied" });
    });

    it("rejects a server-backed support grant when the Auth user is disabled", async () => {
        const db = getFirestore();
        const auth = new MemoryTestAccessAuth();
        const uid = "disabled-support-agent";
        const grantId = "3b176e6b-cfa1-4a06-b899-267438056f86";
        const issuedAt = Math.floor(TEST_NOW_MS / 1_000) - 60;
        const expiresAt = Math.floor(TEST_NOW_MS / 1_000) + 60 * 60;
        auth.addUser(uid, {}, true);
        await db.collection("monetizationSupportGrants")
            .doc(hashOpaque(["support-grant-v1", uid]))
            .set({
                status: "active",
                subjectUid: uid,
                grantId,
                scopes: ["monetization.credit_grant"],
                expiresAt: Timestamp.fromMillis(expiresAt * 1_000),
            });

        await expect(requireSupportActor({
            auth: {
                uid,
                token: {
                    manasplitSupport: {
                        version: 1,
                        role: "support",
                        subjectUid: uid,
                        grantId,
                        scopes: ["monetization.credit_grant"],
                        issuedAtEpochSeconds: issuedAt,
                        expiresAtEpochSeconds: expiresAt,
                    },
                },
            },
        }, "monetization.credit_grant", { auth, db, nowMs: TEST_NOW_MS }))
            .rejects.toMatchObject({ code: "permission-denied" });
    });

    it("returns the stored result for sequential and cross-actor retries", async () => {
        const first = await grantCourtesyCreditsForSupport(request());
        const retry = await grantCourtesyCreditsForSupport(request());
        const handoffRetry = await grantCourtesyCreditsForSupport(request({
            actor: { uid: "support-agent-b", role: "support" },
            nowMs: Date.UTC(2026, 8, 8, 12),
        }));

        expect(first).toEqual({
            amount: 25,
            creditBalance: 25,
            creditDebt: 0,
            duplicate: false,
        });
        expect(retry).toEqual({ ...first, duplicate: true });
        expect(handoffRetry).toEqual({ ...first, duplicate: true });

        const db = getFirestore();
        expect((await accountStateRef("sandbox", UID, db).get()).data()?.creditBalance).toBe(25);
        expect((await db.collectionGroup("supportCourtesyGrants").get()).size).toBe(1);
        expect((await db.collectionGroup("creditLedger").get()).size).toBe(1);
        expect((await db.collection("monetizationAdminAudit").get()).size).toBe(1);
        const rateLimits = await db.collection("monetizationSupportRateLimits").get();
        expect(rateLimits.size).toBe(1);
        expect(rateLimits.docs[0]?.data().creditsGranted).toBe(25);
    });

    it("rejects changed grant details under the same customer ticket key", async () => {
        await expect(grantCourtesyCreditsForSupport(request({ amount: 50 }))).rejects.toMatchObject({
            code: "failed-precondition",
            details: { reasonCode: "IDEMPOTENCY_KEY_REUSED" },
        });
        expect((await accountStateRef("sandbox", UID, getFirestore()).get()).data()?.creditBalance)
            .toBe(25);
    });

    it("commits only one grant when identical requests race", async () => {
        const targetUid = "concurrent-courtesy-user";
        const ticketId = "ticket-concurrent-1";
        const [left, right] = await Promise.all([
            grantCourtesyCreditsForSupport(request({ targetUid, ticketId, amount: 40 })),
            grantCourtesyCreditsForSupport(request({ targetUid, ticketId, amount: 40 })),
        ]);

        expect([left.duplicate, right.duplicate].sort()).toEqual([false, true]);
        expect((await accountStateRef("sandbox", targetUid, getFirestore()).get()).data()?.creditBalance)
            .toBe(40);
    }, 15_000);

    it("commits a support reservation release with exactly one audit record", async () => {
        const db = getFirestore();
        const targetUid = "reservation-release-user";
        const nowMs = Date.UTC(2026, 8, 7, 12);
        const authorizationId = "a".repeat(64);
        await ensureMonetizationAccount({ uid: targetUid, environment: "sandbox", db });
        const reservationRef = db.collection("monetizationUsageAccounts")
            .doc(accountDocumentId("sandbox", targetUid))
            .collection("reservations")
            .doc(authorizationId);
        await reservationRef.set({
            status: "reserved",
            payloadDigest: "payload-digest",
            authorizationId,
            operationDigest: "operation-digest",
            environment: "sandbox",
            featureId: "advanced_split.completion",
            source: "included_use",
            creditCost: 0,
            windowDocumentId: null,
            previewDocumentId: null,
            expiresAtMs: nowMs + 60_000,
            result: {},
        });
        const params = {
            db,
            actor: { uid: "support-agent-a", role: "support" as const },
            targetUid,
            environment: "sandbox" as const,
            reasonCode: "STUCK_RESERVATION",
            ticketId: "ticket-release-1",
            authorizationId,
            nowMs,
        };

        const first = await releaseReservationForSupport(params);
        const retry = await releaseReservationForSupport(params);

        expect(first).toMatchObject({ duplicate: false, outcome: "abandoned" });
        expect(retry).toMatchObject({ duplicate: true, outcome: "abandoned" });
        expect((await reservationRef.get()).data()).toMatchObject({
            status: "finalized",
            outcome: "abandoned",
        });
        const audits = await db.collection("monetizationAdminAudit")
            .where("action", "==", "reservation_released")
            .where("subjectUid", "==", targetUid)
            .get();
        expect(audits.size).toBe(1);
    }, 15_000);

    const testAccessRequest = (
        auth: MemoryTestAccessAuth,
        overrides: Partial<Parameters<typeof setMonetizationTestAccessForAdmin>[0]> = {},
    ) => ({
        db: getFirestore(),
        auth,
        actor: { uid: "current-admin", role: "admin" as const },
        targetUid: "internal-test-user",
        environment: "sandbox" as const,
        reasonCode: "OWNER_TESTING",
        ticketId: "owner-test-1",
        action: "grant" as const,
        accessType: "internal_test" as const,
        durationHours: 24,
        nowMs: TEST_NOW_MS,
        ...overrides,
    });

    it("requires the operator to still be an enabled server-side admin", async () => {
        const auth = new MemoryTestAccessAuth();
        auth.addUser("current-admin", { admin: false });
        auth.addUser("unauthorized-target");

        await expect(setMonetizationTestAccessForAdmin(testAccessRequest(auth, {
            targetUid: "unauthorized-target",
            ticketId: "unauthorized-admin-1",
        }))).rejects.toMatchObject({ code: "permission-denied" });

        const grants = await getFirestore().collection("monetizationInternalTestGrants")
            .where("subjectUid", "==", "unauthorized-target").get();
        expect(grants.empty).toBe(true);
    });

    it("rejects self-targeted remote test access without rewriting the admin claim", async () => {
        const auth = new MemoryTestAccessAuth();
        auth.addUser("current-admin", { admin: true, retainedClaim: "retained" });

        await expect(setMonetizationTestAccessForAdmin(testAccessRequest(auth, {
            targetUid: "current-admin",
            ticketId: "remote-self-target-1",
        }))).rejects.toMatchObject({
            code: "permission-denied",
            details: { reasonCode: "SELF_TARGET_REQUIRES_LOCAL_OPERATOR" },
        });

        expect((await auth.getUser("current-admin")).customClaims).toEqual({
            admin: true,
            retainedClaim: "retained",
        });
        expect(auth.setClaimUids).toEqual([]);
        expect((await getFirestore().collection("monetizationInternalTestGrants")
            .doc(accountDocumentId("sandbox", "current-admin")).get()).exists).toBe(false);
    });

    it("allows audited local self-access while preserving unrelated claims", async () => {
        const auth = new MemoryTestAccessAuth();
        auth.addUser("current-admin", { admin: true, retainedClaim: "retained" });

        await expect(setMonetizationTestAccessForTrustedLocalOperator(testAccessRequest(auth, {
            targetUid: "current-admin",
            ticketId: "local-self-target-1",
        }))).resolves.toMatchObject({ accepted: true, duplicate: false });

        expect((await auth.getUser("current-admin")).customClaims).toMatchObject({
            admin: true,
            retainedClaim: "retained",
            manasplitInternalTest: {
                environment: "sandbox",
                subjectUid: "current-admin",
            },
        });
    });

    it("preserves unrelated claims and makes identical ticket retries idempotent", async () => {
        const auth = new MemoryTestAccessAuth();
        auth.addUser("current-admin", { admin: true });
        auth.addUser("idempotent-test-user", { retainedClaim: "retained" });
        const request = testAccessRequest(auth, {
            targetUid: "idempotent-test-user",
            ticketId: "idempotent-grant-1",
            durationHours: 1,
        });

        const first = await setMonetizationTestAccessForAdmin(request);
        const retry = await setMonetizationTestAccessForAdmin({
            ...request,
            nowMs: TEST_NOW_MS + 2 * 60 * 60 * 1_000,
        });

        expect(first).toMatchObject({ accepted: true, duplicate: false });
        expect(retry).toEqual({ ...first, duplicate: true });
        expect(retry.expiresAt).toBe(TEST_NOW_MS + 60 * 60 * 1_000);
        const user = await auth.getUser("idempotent-test-user");
        expect(user.customClaims?.retainedClaim).toBe("retained");
        expect(user.customClaims?.manasplitInternalTest).toMatchObject({
            environment: "sandbox",
            expiresAtEpochSeconds: Math.floor((TEST_NOW_MS + 60 * 60 * 1_000) / 1_000),
        });

        await expect(setMonetizationTestAccessForAdmin({
            ...request,
            durationHours: 2,
        })).rejects.toMatchObject({
            code: "failed-precondition",
            details: { reasonCode: "IDEMPOTENCY_KEY_REUSED" },
        });
    });

    it("serializes competing claim updates and lets the newer request retry safely", async () => {
        const auth = new MemoryTestAccessAuth();
        auth.addUser("current-admin", { admin: true });
        auth.addUser("concurrent-test-user");
        let releaseFirstSet: (() => void) | undefined;
        let announceFirstSet: (() => void) | undefined;
        const firstSetEntered = new Promise<void>((resolve) => {
            announceFirstSet = resolve;
        });
        const firstSetRelease = new Promise<void>((resolve) => {
            releaseFirstSet = resolve;
        });
        let blocked = false;
        auth.beforeSet = async (uid) => {
            if (uid === "concurrent-test-user" && !blocked) {
                blocked = true;
                announceFirstSet?.();
                await firstSetRelease;
            }
        };
        const firstRequest = testAccessRequest(auth, {
            targetUid: "concurrent-test-user",
            ticketId: "concurrent-grant-a",
        });
        const secondRequest = testAccessRequest(auth, {
            targetUid: "concurrent-test-user",
            ticketId: "concurrent-grant-b",
        });

        const first = setMonetizationTestAccessForAdmin(firstRequest);
        await firstSetEntered;
        await expect(setMonetizationTestAccessForAdmin(secondRequest)).rejects.toMatchObject({
            code: "aborted",
            details: { reasonCode: "TEST_ACCESS_OPERATION_IN_PROGRESS" },
        });
        releaseFirstSet?.();
        await expect(first).resolves.toMatchObject({ accepted: true, duplicate: false });

        const second = await setMonetizationTestAccessForAdmin(secondRequest);
        expect(second).toMatchObject({ accepted: true, duplicate: false });
        const accountId = accountDocumentId("sandbox", "concurrent-test-user");
        const grant = (await getFirestore().collection("monetizationInternalTestGrants")
            .doc(accountId).get()).data();
        const claim = (await auth.getUser("concurrent-test-user"))
            .customClaims?.manasplitInternalTest as Record<string, unknown>;
        expect(grant).toMatchObject({ status: "active", grantId: claim.grantId });
    });

    it("revokes only the requested environment and preserves a current opposite claim", async () => {
        const auth = new MemoryTestAccessAuth();
        auth.addUser("current-admin", { admin: true });
        auth.addUser("environment-test-user");
        await setMonetizationTestAccessForAdmin(testAccessRequest(auth, {
            targetUid: "environment-test-user",
            environment: "production",
            ticketId: "production-grant-1",
        }));

        const revoked = await setMonetizationTestAccessForAdmin(testAccessRequest(auth, {
            targetUid: "environment-test-user",
            ticketId: "sandbox-revoke-1",
            action: "revoke",
            durationHours: undefined,
        }));

        expect(revoked).toMatchObject({ action: "revoke", duplicate: false });
        const user = await auth.getUser("environment-test-user");
        expect(user.customClaims?.manasplitInternalTest).toMatchObject({
            environment: "production",
        });
        expect(auth.revokedUids).not.toContain("environment-test-user");
        const productionGrant = await getFirestore().collection("monetizationInternalTestGrants")
            .doc(accountDocumentId("production", "environment-test-user")).get();
        expect(productionGrant.data()?.status).toBe("active");
    });

    it("keeps failed claim synchronization denied and supports a same-ticket recovery", async () => {
        const auth = new MemoryTestAccessAuth();
        auth.addUser("current-admin", { admin: true });
        auth.addUser("claim-failure-user");
        let fail = true;
        auth.beforeSet = async (uid) => {
            if (uid === "claim-failure-user" && fail) throw new Error("simulated auth outage");
        };
        const request = testAccessRequest(auth, {
            targetUid: "claim-failure-user",
            ticketId: "claim-failure-1",
        });

        await expect(setMonetizationTestAccessForAdmin(request))
            .rejects.toThrow("simulated auth outage");
        const grantRef = getFirestore().collection("monetizationInternalTestGrants")
            .doc(accountDocumentId("sandbox", "claim-failure-user"));
        expect((await grantRef.get()).data()?.status).toBe("claim_sync_failed");

        fail = false;
        await expect(setMonetizationTestAccessForAdmin(request))
            .resolves.toMatchObject({ accepted: true, duplicate: false });
        expect((await grantRef.get()).data()?.status).toBe("active");
    });
});
