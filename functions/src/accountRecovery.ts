import { FieldValue, getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { timingSafeEqual } from "crypto";

/**
 * New-main-device recovery bootstrap
 * (ai_layer/docs/31_multi_device_icloud_sync.md §3.12).
 *
 * THE BUG THIS EXISTS TO FIX. After §5b bug #2 was closed, any device that is
 * not the account's first registers as `pending_confirmation` and sits behind
 * `PendingPairingGate` until an EXISTING device approves it. That is correct
 * for adding a companion — and a total lockout for the single most common real
 * case: the user's only phone was lost, stolen, or died, and the approver they
 * are told to use is the device they no longer have. There was no escape: the
 * gate's only action is "Cancel", which signs out into the same state. Every
 * chat, expense and group became permanently unreachable through the app.
 *
 * §3.12's resolution, confirmed by the product owner 2026-07-24, matches
 * WhatsApp's own model: a brand-new device proves account ownership with
 * Firebase Auth and backup ownership with the passphrase, and that combination
 * alone promotes it to main. No existing device's cooperation — or continued
 * existence — is required.
 *
 * WHY A SERVER-SIDE VERIFIER IS LOAD-BEARING. The client proves it holds the
 * passphrase by decrypting the manifest, but that proof is local: a malicious
 * client could simply call this and assert success. If it could, stolen
 * SplitCircle credentials alone would grant a confirmed main device, which is
 * precisely what the pending-confirmation gate exists to prevent. So the
 * manifest carries a random `recoverySecret`, its SHA-256 is published here at
 * backup time, and recovery must present the preimage. Because the secret
 * lives only inside the encrypted backup, presenting it demonstrates all three
 * §3.12 factors at once: Firebase Auth (this call is authenticated), iCloud
 * account access (the backup is only readable from the signed-in account's
 * private database), and the passphrase (nothing else decrypts the manifest).
 *
 * The verifier document is Cloud-Function-only for READ as well as write. A
 * client-readable expected value would let an attacker holding only stolen
 * credentials read it back and replay it, collapsing three factors into one.
 */

const USERS_COLLECTION = "users";
const PAIRED_DEVICES_SUBCOLLECTION = "pairedDevices";
const NOTIFICATION_DEVICES_SUBCOLLECTION = "notificationDevices";
const SIGNAL_PREKEYS_SUBCOLLECTION = "signalPrekeys";
const RECOVERY_SUBCOLLECTION = "backupRecovery";
const RECOVERY_DOC = "current";

/** Hex SHA-256. Anything else is a malformed client, not a wrong passphrase. */
const VERIFIER_PATTERN = /^[0-9a-f]{64}$/;

const recoveryDocRef = (uid: string) =>
    getFirestore()
        .collection(USERS_COLLECTION)
        .doc(uid)
        .collection(RECOVERY_SUBCOLLECTION)
        .doc(RECOVERY_DOC);

/**
 * Publishes the recovery verifier. Called after every successful backup, not
 * only at enrollment: if the local copy of the secret is ever lost (app
 * reinstall on the same device) the next export mints a fresh one and writes a
 * new manifest, and re-publishing on every run is what keeps the server's copy
 * describing the backup that actually exists. A stale verifier would fail
 * recovery against a perfectly good backup.
 */
export async function setBackupRecoveryVerifier(
    uid: string,
    verifier: string,
): Promise<void> {
    if (!VERIFIER_PATTERN.test(verifier)) {
        throw new Error("Malformed recovery verifier");
    }

    await recoveryDocRef(uid).set(
        {
            verifier,
            // ONLY the verifier lives here.
            //
            // The backup's summary (dates, counts, size) deliberately does NOT:
            // it rides in the manifest record's CloudKit metadata instead, where
            // any device on the user's Apple ID can read it without a passphrase.
            // That keeps the user's own data in the user's own storage and means
            // this server never learns how many messages they have. What stays
            // here is the one thing that MUST be tamper-proof and unreadable by
            // the client.
            updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
    );
}

/** Whether this account has a recoverable backup. Existence only — the
 * summary comes from the user's own iCloud, not from us. */
export async function hasBackupRecoveryVerifier(uid: string): Promise<{ hasBackup: boolean }> {
    const snap = await recoveryDocRef(uid).get();
    return { hasBackup: typeof snap.data()?.verifier === "string" };
}

export interface RecoverAsNewMainInput {
    deviceId: string;
    /** SHA-256 of the manifest's `recoverySecret`. Absent = no-backup path. */
    verifier?: string;
    /**
     * Set only on the no-backup path, where the user has typed the
     * acknowledgement phrase. Never a substitute for a verifier that exists.
     */
    acknowledgedNoBackup?: boolean;
    /**
     * "I still have my old phone" — demote the other devices to companions
     * instead of revoking them.
     *
     * The distinction is the user's to make and cannot be inferred: a phone
     * that was lost or sold must be cut off immediately (this flow is the only
     * one that can, per §3.7 point 6), while a phone still in their hand
     * should keep working as a secondary device rather than being silently
     * bricked. Defaults to revoking, because that is the safe reading when
     * nobody has said otherwise.
     */
    keepOtherDevices?: boolean;
}

export interface RecoverAsNewMainResult {
    status: "recovered";
    /** Devices whose access was revoked, so the UI can say what happened. */
    revokedDeviceIds: string[];
    /** Devices demoted to companion instead of revoked. */
    demotedDeviceIds: string[];
    /** False when recovery ran on the no-backup path. */
    backupVerified: boolean;
}

/**
 * Promotes the calling device to confirmed main and revokes every other
 * device on the account.
 *
 * REVOKING THE OTHERS IS DELIBERATE, not cleanup. Recovery means "my other
 * devices are gone"; if one is gone because it was stolen, this is the only
 * flow that cuts it off, since §3.7 point 6's "report lost/stolen" gap has no
 * other answer — every existing revoke path requires a trusted device the user
 * by definition no longer has. A user who still HAS their other device should
 * be approving from it instead, which is what the recovery screen tells them.
 */
export async function recoverAsNewMainDevice(
    uid: string,
    input: RecoverAsNewMainInput,
): Promise<RecoverAsNewMainResult> {
    const db = getFirestore();
    const deviceId = input.deviceId?.trim();
    if (!deviceId) {
        throw new Error("A device id is required");
    }

    const storedSnap = await recoveryDocRef(uid).get();
    const storedVerifier = storedSnap.exists ? storedSnap.data()?.verifier : undefined;
    const hasStoredVerifier = typeof storedVerifier === "string" && VERIFIER_PATTERN.test(storedVerifier);

    let backupVerified = false;

    if (hasStoredVerifier) {
        const presented = input.verifier;
        if (typeof presented !== "string" || !VERIFIER_PATTERN.test(presented)) {
            throw new Error("BACKUP_PROOF_REQUIRED");
        }
        // Constant-time: both sides are fixed-length hex, so the buffers are
        // always equal length and timingSafeEqual cannot throw here.
        const matches = timingSafeEqual(
            Buffer.from(presented, "hex"),
            Buffer.from(storedVerifier as string, "hex"),
        );
        if (!matches) {
            logger.warn("recoverAsNewMainDevice: verifier mismatch", { uid, deviceId });
            throw new Error("BACKUP_PROOF_INVALID");
        }
        backupVerified = true;
    } else {
        // NO BACKUP EXISTS. Blocking here would be security theatre with a
        // permanent cost: firestore.rules gates chats/messages/groups/expenses
        // on the authenticated uid, NOT on a live device session (Phase 1
        // narrowed `hasLiveDeviceSession()` to three single-document
        // collections precisely because a broader rule breaks list queries).
        // So an attacker holding these same credentials can already read that
        // data through the API whether or not this call succeeds — refusing
        // buys nothing and strands a legitimate user out of their own account
        // forever. Mirrors §3.7 point 5's rule that an escape hatch must
        // exist; the client makes it effortful with a typed phrase.
        if (input.acknowledgedNoBackup !== true) {
            throw new Error("NO_BACKUP_ACKNOWLEDGEMENT_REQUIRED");
        }
        logger.warn("recoverAsNewMainDevice: proceeding with NO backup to verify", { uid, deviceId });
    }

    const userRef = db.collection(USERS_COLLECTION).doc(uid);
    const devicesSnap = await userRef.collection(PAIRED_DEVICES_SUBCOLLECTION).get();
    const otherDeviceIds = devicesSnap.docs
        .map((doc) => doc.id)
        .filter((id) => id !== deviceId);

    // One atomic batch: a partial apply could leave the account with two mains
    // or with this device promoted while a revoked one still holds prekeys,
    // and peers would then encrypt to a device that can never read it.
    const batch = db.batch();

    batch.set(
        userRef.collection(PAIRED_DEVICES_SUBCOLLECTION).doc(deviceId),
        {
            deviceId,
            isMainDevice: true,
            pairingStatus: "confirmed",
            recoveredAt: FieldValue.serverTimestamp(),
            recoveredWithBackup: backupVerified,
            selfRegistered: FieldValue.delete(),
            confirmationCode: FieldValue.delete(),
            confirmationExpiresAt: FieldValue.delete(),
            lastSeenAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
    );

    for (const otherId of otherDeviceIds) {
        if (input.keepOtherDevices) {
            // Demote, don't remove. The device keeps its session, its keys and
            // its history; it simply stops being the one that backs up, which
            // is exactly what "I still have my old phone" means.
            batch.set(
                userRef.collection(PAIRED_DEVICES_SUBCOLLECTION).doc(otherId),
                { isMainDevice: false, demotedAt: FieldValue.serverTimestamp() },
                { merge: true },
            );
            continue;
        }
        batch.delete(userRef.collection(PAIRED_DEVICES_SUBCOLLECTION).doc(otherId));
        batch.delete(userRef.collection(NOTIFICATION_DEVICES_SUBCOLLECTION).doc(otherId));
        // Prekeys must go too, or peers keep encrypting to a revoked device's
        // published bundle and the all-or-nothing send rule in
        // messageEnvelope.ts fails every message to this account.
        batch.delete(userRef.collection(SIGNAL_PREKEYS_SUBCOLLECTION).doc(otherId));
    }

    await batch.commit();

    logger.info("recoverAsNewMainDevice: recovered", {
        uid,
        deviceId,
        backupVerified,
        revokedCount: otherDeviceIds.length,
    });

    return {
        status: "recovered",
        revokedDeviceIds: input.keepOtherDevices ? [] : otherDeviceIds,
        demotedDeviceIds: input.keepOtherDevices ? otherDeviceIds : [],
        backupVerified,
    };
}
