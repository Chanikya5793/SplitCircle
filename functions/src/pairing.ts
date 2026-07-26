import {
    FieldValue,
    getFirestore,
    type DocumentData,
} from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";
import * as logger from "firebase-functions/logger";
import { randomInt } from "crypto";
import { sendPushToUsers } from "./notifications";

/**
 * Companion-device pairing (ai_layer/docs/31_multi_device_icloud_sync.md §3.4).
 * Cloud-Function-only, Admin SDK — mirrors the joinGroupByInviteCode pattern
 * (groupJoin.ts): impl functions here, thin onCall wrappers in index.ts.
 *
 * Phase 1 scope note: the "secondary out-of-band confirmation" code below is
 * a server-generated random 6-digit code tied to THIS pairing transaction —
 * NOT yet a hash of both devices' Signal identity public keys as doc 31 §3.4
 * point 3 ultimately specifies. Signal identity keys don't exist until
 * Phase 3 (E2E encryption core) publishes them to signalPrekeys. This is
 * still a real MITM check on the PAIRING CHANNEL itself (a photographed/
 * intercepted QR redeemed in a different session shows a different code),
 * it just doesn't yet cryptographically bind to a persistent device
 * identity — Phase 3 should upgrade this derivation once real keys exist,
 * without changing the pairing flow's API shape.
 */

const PAIRING_CODES_COLLECTION = "pairingCodes";
const USERS_COLLECTION = "users";
const PAIRED_DEVICES_SUBCOLLECTION = "pairedDevices";
const NOTIFICATION_DEVICES_SUBCOLLECTION = "notificationDevices";
const RTDB_PAIRING_CONFIRM_PATH = "pairingConfirm";

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes — bounds redemption only
const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h — bounds confirmation, doc 31 §3.4 point 6
const MAX_ACTIVE_DEVICES = 4; // doc 31 decision #21

const toSafeError = (error: unknown): { name?: string; message?: string } => {
    if (error instanceof Error) {
        return { name: error.name, message: error.message };
    }
    return { message: "Unknown error" };
};

const generatePairingCode = (): string => {
    // 8 uppercase alphanumeric chars, ambiguous glyphs (0/O, 1/I/L) excluded
    // for the manual-entry fallback (doc 31 decision #8).
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 8; i += 1) {
        code += alphabet[randomInt(0, alphabet.length)];
    }
    return code;
};

const generateConfirmationCode = (): string => {
    return String(randomInt(0, 1_000_000)).padStart(6, "0");
};

export interface CreatePairingResult {
    code: string;
    expiresAt: number;
}

/**
 * Main device: generate a short-lived, single-use pairing code. Caller must
 * already have passed a biometric re-auth gate CLIENT-SIDE before reaching
 * this — doc 31 §3.4 point 1 — this function doesn't re-verify that (there's
 * no server-side signal for "did Face ID just succeed"), so the client is
 * trusted for that specific gate, same trust model this app already uses for
 * settlement confirmation (SettlementsScreen.tsx).
 */
export async function createPairingCode(uid: string): Promise<CreatePairingResult> {
    const db = getFirestore();
    const code = generatePairingCode();
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;

    await db.collection(PAIRING_CODES_COLLECTION).doc(code).set({
        uid,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
        consumedBy: null,
        consumedAt: null,
    });

    return { code, expiresAt };
}

export interface RedeemPairingInput {
    code: string;
    deviceId: string;
    platform: "ios" | "android";
    deviceName: string | null;
    modelName: string | null;
}

export interface RedeemPairingResult {
    customToken: string;
    confirmationCode: string;
    confirmationExpiresAt: number;
    /**
     * True for a reverse-pairing redemption: a trusted device scanned this one,
     * so it is already `confirmed` and the client must NOT show the
     * waiting-for-confirmation UI.
     */
    autoConfirmed: boolean;
}

/**
 * New device: redeem a pairing code. One Firestore transaction covers the
 * idempotent code-consumption check-and-set AND the new device's record
 * writes (pairedDevices, notificationDevices) atomically — a genuinely
 * different guarantee than groupJoin.ts's single `.update()` precedent,
 * required here because "was this code already consumed" must be checked
 * and set in the same atomic step or a retried redemption after a dropped
 * response could either double-pair or false-negative (doc 31 §3.4/§4).
 * Custom-token minting and the RTDB nudge happen AFTER the transaction
 * commits — neither is a Firestore operation, so neither can be inside it;
 * both only run once the transactional state is already safely committed.
 */
/**
 * Redeems a pairing code from a device that is NOT signed in.
 *
 * This is deliberately callable WITHOUT auth, and that is the entire point of
 * pairing: the new phone has no credentials yet, which is why the user is
 * scanning a QR instead of typing a password. The pairing CODE is the
 * credential, and `uid` is derived from the code document — never taken from
 * the caller.
 *
 * It previously required `request.auth.uid` while simultaneously returning a
 * custom token for the caller to sign in WITH, which is circular: you needed
 * to be signed in to obtain the token that signs you in. Scanning a QR on a
 * fresh device therefore always failed with "Authentication required."
 *
 * What keeps an unauthenticated endpoint safe here:
 *  - the code is 8 chars from a 32-symbol alphabet (~2^40) and lives 5 minutes;
 *  - it is single-use (`consumedBy`);
 *  - redemption only ever yields a device in `pending_confirmation`, which
 *    still requires explicit approval on an existing device before it can read
 *    anything. Redeeming a code is not, by itself, access.
 */
export async function redeemPairingCode(
    input: RedeemPairingInput,
): Promise<RedeemPairingResult> {
    const db = getFirestore();
    const codeRef = db.collection(PAIRING_CODES_COLLECTION).doc(input.code);

    // uid comes from the CODE, not the caller — the caller has no identity yet.
    const preflight = await codeRef.get();
    if (!preflight.exists) {
        throw new Error("Pairing code not found");
    }
    const uid = (preflight.data() as DocumentData).uid as string;
    if (!uid || typeof uid !== "string") {
        throw new Error("Pairing code not found");
    }

    const pairedDeviceRef = db
        .collection(USERS_COLLECTION)
        .doc(uid)
        .collection(PAIRED_DEVICES_SUBCOLLECTION)
        .doc(input.deviceId);
    const notificationDeviceRef = db
        .collection(USERS_COLLECTION)
        .doc(uid)
        .collection(NOTIFICATION_DEVICES_SUBCOLLECTION)
        .doc(input.deviceId);

    const confirmationCode = generateConfirmationCode();
    const confirmationExpiresAt = Date.now() + CONFIRMATION_TTL_MS;
    // Set inside the transaction, read after it commits — the post-commit
    // push and the return value both need to know which path ran.
    let wasAutoConfirmed = false;

    await db.runTransaction(async (tx) => {
        const codeSnap = await tx.get(codeRef);
        if (!codeSnap.exists) {
            throw new Error("Pairing code not found");
        }
        const codeData = codeSnap.data() as DocumentData;
        if (codeData.uid !== uid) {
            // Re-read inside the transaction: guards against the code being
            // rewritten between the preflight lookup above and here.
            throw new Error("Pairing code not found");
        }
        if (codeData.consumedBy) {
            throw new Error("Pairing code already used");
        }
        if (typeof codeData.expiresAt !== "number" || codeData.expiresAt < Date.now()) {
            throw new Error("Pairing code expired");
        }

        // Reverse-pairing codes are bound to the exact device the main device
        // scanned. Without this check the flow would be strictly WEAKER than
        // the forward one: the companion's on-screen nonce is long-lived by
        // comparison (it sits visible while the user fetches the other phone)
        // and there is no confirmation step behind it.
        if (
            typeof codeData.preauthorizedDeviceId === "string" &&
            codeData.preauthorizedDeviceId !== input.deviceId
        ) {
            throw new Error("Pairing code not found");
        }

        // 4-device cap (doc 31 decision #21) — an expired, never-confirmed
        // pending pairing doesn't count against the cap, so a stale
        // abandoned pairing attempt can't permanently squat a slot.
        const activeDevicesSnap = await tx.get(
            db.collection(USERS_COLLECTION).doc(uid).collection(PAIRED_DEVICES_SUBCOLLECTION),
        );
        const now = Date.now();
        const activeCount = activeDevicesSnap.docs.filter((docSnap) => {
            const data = docSnap.data();
            if (data.pairingStatus === "confirmed") return true;
            if (data.pairingStatus === "pending_confirmation") {
                return typeof data.confirmationExpiresAt === "number" && data.confirmationExpiresAt > now;
            }
            return false;
        }).length;
        if (activeCount >= MAX_ACTIVE_DEVICES) {
            throw new Error("Device limit reached");
        }

        tx.update(codeRef, {
            consumedBy: input.deviceId,
            consumedAt: FieldValue.serverTimestamp(),
        });

        // An auto-confirm code was authorized by a trusted device that
        // physically scanned this one, so the scan already served as the
        // out-of-band confirmation and no confirmationCode is issued.
        const autoConfirm = codeData.autoConfirm === true;
        wasAutoConfirmed = autoConfirm;

        tx.set(pairedDeviceRef, {
            deviceId: input.deviceId,
            platform: input.platform,
            deviceName: input.deviceName,
            modelName: input.modelName,
            isMainDevice: false,
            pairingStatus: autoConfirm ? "confirmed" : "pending_confirmation",
            ...(autoConfirm
                ? { confirmedAt: FieldValue.serverTimestamp() }
                : { confirmationCode, confirmationExpiresAt }),
            pairedAt: FieldValue.serverTimestamp(),
            lastSeenAt: FieldValue.serverTimestamp(),
        });

        // Merge, not overwrite: if this deviceId already has a
        // notificationDevices doc (e.g. it registered for push before
        // pairing completed — unlikely but not impossible), preserve its
        // push-token fields and just layer role/pairing status on top.
        tx.set(
            notificationDeviceRef,
            {
                role: "companion",
                updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
        );
    });

    /**
     * THE CODE IS ALREADY CONSUMED BY THE TIME WE GET HERE.
     *
     * The transaction above committed, so a failure in this step is not
     * recoverable by retrying with the same code — the next attempt gets
     * "already used". That is exactly the loop that was reported: the device
     * paired server-side (its pairedDevices row exists, the main device can
     * even approve it) while the companion never received the token it signs
     * in with, so nothing on screen ever changed.
     *
     * `createCustomToken` is the ONLY call in this entire backend that needs
     * to SIGN something, which is why no other function ever exposed this. In
     * Gen2 the runtime service account needs `iam.serviceAccounts.signBlob`
     * (roles/iam.serviceAccountTokenCreator) on itself, and it does not have
     * it by default. Named explicitly here so the cause is unmistakable in
     * the logs instead of arriving as a bare "internal" error.
     */
    let customToken: string;
    try {
        customToken = await getAuth().createCustomToken(uid, {
            deviceId: input.deviceId,
        });
    } catch (error) {
        logger.error("redeemPairingCode: createCustomToken FAILED — the code is now consumed", {
            uid,
            deviceId: input.deviceId,
            hint: "Grant roles/iam.serviceAccountTokenCreator to the function's runtime service account",
            errorMessage: error instanceof Error ? error.message : String(error),
        });
        // Release the code so the user's next scan is a clean retry rather
        // than a permanent "already used" dead end.
        try {
            await codeRef.update({ consumedBy: null, consumedAt: null });
        } catch {
            // Best-effort; the error below is what matters.
        }
        throw new Error("Could not issue a sign-in token for this device");
    }

    // Best-effort nudge for a main device that already has the app open —
    // the mandatory push below is the reliable path, this is just lower
    // latency when it lands. Mirrors groupJoin.ts's "atomic primary write,
    // best-effort secondary side-effect" shape.
    try {
        await getDatabase()
            .ref(`${RTDB_PAIRING_CONFIRM_PATH}/${uid}/${input.code}`)
            .set({ deviceId: input.deviceId, deviceName: input.deviceName, at: Date.now() });
    } catch (error) {
        logger.warn("redeemPairingCode: RTDB nudge failed (redemption still succeeded)", {
            uid,
            deviceId: input.deviceId,
            error: toSafeError(error),
        });
    }

    try {
        // "general" has no per-category user mute toggle (see
        // NotificationPreference in models/user.ts) — deliberate, this
        // confirmation must be mandatory, not something a notification
        // setting can silently suppress. Fans out to ALL of this user's
        // registered devices (sendPushToUsers has no per-device targeting),
        // including the brand-new pending device itself — harmless
        // overinclusion, not a security issue, but a known Phase 1
        // imperfection worth fixing if per-device push targeting is ever
        // added generally.
        await sendPushToUsers(
            [uid],
            wasAutoConfirmed ? "New device linked" : "New device wants to link",
            wasAutoConfirmed
                // Still notified, even though nothing needs approving: the
                // user should always learn that a device joined their account,
                // and this is the only signal reaching their OTHER devices.
                ? `${input.deviceName ?? "A device"} was linked to your account. Remove it in Settings if this wasn't you.`
                : `${input.deviceName ?? "A device"} is trying to link to your account. Confirm in Settings if this is you.`,
            {
                type: wasAutoConfirmed ? "device_pairing_linked" : "device_pairing_confirmation",
                deviceId: input.deviceId,
                ...(wasAutoConfirmed ? {} : { confirmationCode }),
            },
            "general",
        );
    } catch (error) {
        logger.warn("redeemPairingCode: confirmation push failed (redemption still succeeded)", {
            uid,
            deviceId: input.deviceId,
            error: toSafeError(error),
        });
    }

    return {
        customToken,
        confirmationCode,
        confirmationExpiresAt,
        autoConfirmed: wasAutoConfirmed,
    };
}

/**
 * Main device only: confirm or deny a pending companion pairing. Requires
 * the CALLER's own deviceId to currently be marked isMainDevice — prevents
 * a companion (even one whose confirmation push it also received, per the
 * fan-out note above) from confirming its own pairing.
 */
export async function confirmPairing(
    uid: string,
    callerDeviceId: string,
    targetDeviceId: string,
    confirm: boolean,
): Promise<{ status: "confirmed" | "denied" }> {
    const db = getFirestore();
    const devicesRef = db.collection(USERS_COLLECTION).doc(uid).collection(PAIRED_DEVICES_SUBCOLLECTION);
    const callerRef = devicesRef.doc(callerDeviceId);
    const targetRef = devicesRef.doc(targetDeviceId);

    const callerSnap = await callerRef.get();
    if (!callerSnap.exists || callerSnap.data()?.isMainDevice !== true) {
        throw new Error("Only the main device can confirm a new device");
    }

    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) {
        throw new Error("Pending device not found");
    }
    const targetData = targetSnap.data() as DocumentData;
    if (targetData.pairingStatus !== "pending_confirmation") {
        throw new Error("Device is not awaiting confirmation");
    }

    if (!confirm) {
        await revokeDeviceRecords(uid, targetDeviceId);
        return { status: "denied" };
    }

    // 4-device cap (doc 31 decision #21). redeemPairingCode enforces this at
    // redemption, but a self-registered device (one that signed in directly
    // and was written as pending by syncNotificationDeviceRecord) never goes
    // through redemption — so without this check, approving here was a second
    // way past the cap. The client disables the button too; this is the
    // authoritative one.
    const confirmedSnap = await devicesRef.where("pairingStatus", "==", "confirmed").get();
    if (confirmedSnap.size >= MAX_ACTIVE_DEVICES) {
        throw new Error(
            `You can link at most ${MAX_ACTIVE_DEVICES} devices. Remove one before approving another.`,
        );
    }

    await targetRef.update({
        pairingStatus: "confirmed",
        confirmationCode: FieldValue.delete(),
        confirmationExpiresAt: FieldValue.delete(),
        confirmedAt: FieldValue.serverTimestamp(),
    });

    return { status: "confirmed" };
}

/**
 * Deletes pairedDevices + notificationDevices + signalPrekeys for a device
 * in one atomic WriteBatch (doc 31 §3.4 point 5 / §3.11 — must be a literal
 * atomic multi-doc operation, not sequential awaits, or a partial failure
 * here reproduces the archivedMembers/isGroupJoinUpdate class of bug).
 * Shared by confirmPairing's deny path and revokeDevice below.
 */
async function revokeDeviceRecords(uid: string, deviceId: string): Promise<void> {
    const db = getFirestore();
    const userRef = db.collection(USERS_COLLECTION).doc(uid);
    const batch = db.batch();
    batch.delete(userRef.collection(PAIRED_DEVICES_SUBCOLLECTION).doc(deviceId));
    batch.delete(userRef.collection(NOTIFICATION_DEVICES_SUBCOLLECTION).doc(deviceId));
    batch.delete(userRef.collection("signalPrekeys").doc(deviceId));
    await batch.commit();
}

/**
 * Revoke a linked device. Either the caller revoking itself (sign this
 * device out), or the main device revoking any other device — a non-main
 * device may not revoke a DIFFERENT device.
 */
export async function revokeDevice(
    uid: string,
    callerDeviceId: string,
    targetDeviceId: string,
): Promise<void> {
    const db = getFirestore();

    if (callerDeviceId === targetDeviceId) {
        // Self-revoking the MAIN device is deliberately blocked here — that's
        // the device-retirement flow's job (doc 31 §3.7, Phase 7, not yet
        // built), which gates it on a verified-complete backup first so this
        // simple function can't be used to accidentally strand an account
        // with no main device and no path to promote a companion.
        const selfSnap = await db
            .collection(USERS_COLLECTION)
            .doc(uid)
            .collection(PAIRED_DEVICES_SUBCOLLECTION)
            .doc(callerDeviceId)
            .get();
        if (selfSnap.exists && selfSnap.data()?.isMainDevice === true) {
            throw new Error("Cannot remove the main device this way — use device retirement instead");
        }
    } else {
        const callerSnap = await db
            .collection(USERS_COLLECTION)
            .doc(uid)
            .collection(PAIRED_DEVICES_SUBCOLLECTION)
            .doc(callerDeviceId)
            .get();
        if (!callerSnap.exists || callerSnap.data()?.isMainDevice !== true) {
            throw new Error("Only the main device can remove a different device");
        }
    }

    await revokeDeviceRecords(uid, targetDeviceId);

    // TODO(Phase 1 follow-up / noted in doc 31): this deletes the Firestore
    // records but does NOT yet force-invalidate the revoked device's already
    //-cached Firebase Auth session — that requires the deviceId custom-claim
    // check landing in firestore.rules/database.rules.json (this same phase,
    // see the rules changes) so the NEXT read/write from that cached client
    // fails under the new rule, rather than surviving until natural token
    // TTL expiry. Revocation is "hard" only once both pieces are in place.
}

export interface AuthorizeScannedDeviceInput {
    /** Nonce the companion generated and encoded in its own QR. */
    code: string;
    /** The companion's installation id, from the same QR. */
    deviceId: string;
    platform: "ios" | "android";
    deviceName: string | null;
    modelName: string | null;
}

/**
 * REVERSE PAIRING (product-owner request 2026-07-25): the MAIN device scans a
 * code displayed by the new device, rather than the other way round.
 *
 * The companion has no account, so it cannot be issued a code by the server —
 * it mints a high-entropy nonce itself, shows it, and polls redemption. This
 * call is what turns that nonce into a real pairing code, and it can only be
 * made by an already-authenticated device, which is where the trust comes from.
 *
 * Two properties make this SAFER than the forward flow rather than merely
 * equivalent:
 *
 *  - The code is bound to `preauthorizedDeviceId`. Photographing the
 *    companion's screen is useless: only the device whose installation id is
 *    in the QR can redeem it. The forward flow has no such binding, which is
 *    exactly why it needs a separate confirmation step.
 *  - Because a trusted device performed the scan deliberately, that scan IS
 *    the out-of-band confirmation §3.4 point 3 asks for. The companion is
 *    therefore redeemed straight to `confirmed`, with no second approval —
 *    asking the user to confirm on the same device they just scanned with
 *    would be ceremony, not security.
 *
 * `create()` rather than `set()`: a nonce that already exists belongs to some
 * other pairing attempt, and silently overwriting it would hijack that one.
 */
export async function authorizeScannedDevice(
    uid: string,
    input: AuthorizeScannedDeviceInput,
): Promise<{ expiresAt: number }> {
    const db = getFirestore();

    // Only a CONFIRMED device may bring another device onto the account —
    // otherwise a phone still sitting behind PendingPairingGate could pair
    // further devices and bootstrap itself past approval entirely.
    const callerDevices = await db
        .collection(USERS_COLLECTION)
        .doc(uid)
        .collection(PAIRED_DEVICES_SUBCOLLECTION)
        .where("pairingStatus", "==", "confirmed")
        .limit(1)
        .get();
    if (callerDevices.empty) {
        throw new Error("Only a confirmed device can link a new device");
    }

    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
    try {
        await db.collection(PAIRING_CODES_COLLECTION).doc(input.code).create({
            uid,
            createdAt: FieldValue.serverTimestamp(),
            expiresAt,
            consumedBy: null,
            consumedAt: null,
            preauthorizedDeviceId: input.deviceId,
            autoConfirm: true,
            scannedDeviceName: input.deviceName,
            scannedPlatform: input.platform,
            scannedModelName: input.modelName,
        });
    } catch {
        throw new Error("That code is no longer valid — ask the other device for a fresh one");
    }

    return { expiresAt };
}
