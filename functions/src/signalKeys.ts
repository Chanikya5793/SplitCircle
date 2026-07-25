/**
 * Signal prekey publishing + claiming (doc 31 §3.3, Phase 3 wiring).
 *
 * Why these are Cloud Functions rather than client writes:
 *
 * - `users/{uid}/signalPrekeys/{deviceId}` is `allow read: if isSignedIn()`
 *   but `create/update/delete: if false` — every device must be able to READ a
 *   peer's public bundle to start a session, but nobody may write one directly,
 *   or an attacker could publish their own identity key under someone else's
 *   device and silently become the endpoint for that device's messages.
 * - Claiming a one-time prekey must be ATOMIC. Two senders reaching for the
 *   same device concurrently must not receive the same one-time prekey —
 *   reuse degrades exactly the forward secrecy the one-time key exists to
 *   provide. A transaction is the only way to pop-and-persist safely.
 */

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

const USERS_COLLECTION = "users";
const PAIRED_DEVICES_SUBCOLLECTION = "pairedDevices";
const SIGNAL_PREKEYS_SUBCOLLECTION = "signalPrekeys";

/**
 * libsignal's DeviceId is Int8-backed (1-127) and is NOT this repo's UUID
 * installation id — see doc 31's Phase 3 protocol-design finding. This is the
 * ceiling for the small-integer id minted per user.
 */
const MAX_SIGNAL_DEVICE_ID = 127;

export interface PublishablePrekeyBundle {
    registrationId: number;
    identityKey: string;
    signedPreKeyId: number;
    signedPreKeyPublic: string;
    signedPreKeySignature: string;
    kyberPreKeyId: number;
    kyberPreKeyPublic: string;
    kyberPreKeySignature: string;
    oneTimePreKeys: { keyId: number; publicKey: string }[];
}

/**
 * Publishes this device's PUBLIC prekey material and returns the small-integer
 * libsignal device id, allocating one on first publish.
 *
 * Allocation happens here rather than at pairing time so there is exactly one
 * place that mints it — a device that never publishes keys never needs an id,
 * and both pairing paths (redeemPairingCode and the self-registration backfill
 * in syncNotificationDeviceRecord) converge here without either needing to
 * know about libsignal.
 */
export async function publishSignalPrekeys(
    uid: string,
    deviceId: string,
    bundle: PublishablePrekeyBundle,
): Promise<{ signalDeviceId: number }> {
    const db = getFirestore();
    const userRef = db.collection(USERS_COLLECTION).doc(uid);
    const pairedRef = userRef.collection(PAIRED_DEVICES_SUBCOLLECTION).doc(deviceId);
    const prekeyRef = userRef.collection(SIGNAL_PREKEYS_SUBCOLLECTION).doc(deviceId);

    const signalDeviceId = await db.runTransaction(async (tx) => {
        const pairedSnap = await tx.get(pairedRef);
        if (!pairedSnap.exists) {
            throw new Error("This device is not registered on your account");
        }
        const paired = pairedSnap.data() ?? {};
        // A device awaiting approval must not be able to publish keys: doing so
        // would let it be selected as a message recipient before anyone
        // approved it, defeating PendingPairingGate's entire purpose.
        if (paired.pairingStatus !== "confirmed") {
            throw new Error("This device is not confirmed yet");
        }

        const existing = paired.signalDeviceId;
        if (typeof existing === "number") {
            return existing;
        }

        // Smallest unused id in 1..127. Read inside the transaction so two
        // devices publishing concurrently cannot be handed the same id —
        // colliding ids would make two devices share one ProtocolAddress and
        // silently cross-decrypt each other's sessions.
        const siblingsSnap = await tx.get(userRef.collection(PAIRED_DEVICES_SUBCOLLECTION));
        const taken = new Set<number>();
        siblingsSnap.forEach((doc) => {
            const value = doc.data()?.signalDeviceId;
            if (typeof value === "number") taken.add(value);
        });
        let allocated = 0;
        for (let candidate = 1; candidate <= MAX_SIGNAL_DEVICE_ID; candidate += 1) {
            if (!taken.has(candidate)) {
                allocated = candidate;
                break;
            }
        }
        if (allocated === 0) {
            throw new Error("No libsignal device id available for this account");
        }
        tx.update(pairedRef, { signalDeviceId: allocated });
        return allocated;
    });

    // Written outside the transaction: the bundle is large (100 one-time
    // prekeys) and re-published on rotation, while the id allocation above
    // must stay a small, contended, fast transaction.
    await prekeyRef.set({
        deviceId,
        signalDeviceId,
        registrationId: bundle.registrationId,
        identityKey: bundle.identityKey,
        signedPreKeyId: bundle.signedPreKeyId,
        signedPreKeyPublic: bundle.signedPreKeyPublic,
        signedPreKeySignature: bundle.signedPreKeySignature,
        kyberPreKeyId: bundle.kyberPreKeyId,
        kyberPreKeyPublic: bundle.kyberPreKeyPublic,
        kyberPreKeySignature: bundle.kyberPreKeySignature,
        oneTimePreKeys: bundle.oneTimePreKeys ?? [],
        updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info("publishSignalPrekeys: published", {
        uid,
        deviceId,
        signalDeviceId,
        oneTimeCount: bundle.oneTimePreKeys?.length ?? 0,
    });
    return { signalDeviceId };
}

export interface ClaimedPeerBundle {
    deviceId: string;
    signalDeviceId: number;
    registrationId: number;
    identityKey: string;
    signedPreKeyId: number;
    signedPreKeyPublic: string;
    signedPreKeySignature: string;
    kyberPreKeyId: number;
    kyberPreKeyPublic: string;
    kyberPreKeySignature: string;
    oneTimePreKey?: { keyId: number; publicKey: string };
    /** True when the peer had no one-time prekeys left. */
    exhausted: boolean;
}

/**
 * Atomically claims one of a peer device's one-time prekeys and returns the
 * bundle needed to build a session with it.
 *
 * Running out is NOT an error: libsignal's PreKeyBundle has a
 * signed-prekey-only form, so the handshake still succeeds with weaker forward
 * secrecy for that one session. Failing instead would make a popular device
 * undeliverable, which is strictly worse. `exhausted` is surfaced so the peer
 * can be nudged to replenish.
 */
export async function claimSignalPreKey(
    targetUserId: string,
    targetDeviceId: string,
): Promise<ClaimedPeerBundle> {
    const db = getFirestore();
    const prekeyRef = db
        .collection(USERS_COLLECTION)
        .doc(targetUserId)
        .collection(SIGNAL_PREKEYS_SUBCOLLECTION)
        .doc(targetDeviceId);

    return db.runTransaction(async (tx) => {
        const snap = await tx.get(prekeyRef);
        if (!snap.exists) {
            throw new Error("That device has not published encryption keys yet");
        }
        const data = snap.data() ?? {};
        const oneTime: { keyId: number; publicKey: string }[] = Array.isArray(data.oneTimePreKeys)
            ? data.oneTimePreKeys
            : [];

        const claimed = oneTime.length > 0 ? oneTime[0] : undefined;
        if (claimed) {
            // Whole-array replace, never a nested merge: CLAUDE.md's
            // reaction-removal gotcha — `merge: true` cannot SHRINK a stored
            // array/map, so a merged write would leave the claimed prekey in
            // place and hand it to the next sender too.
            tx.update(prekeyRef, { oneTimePreKeys: oneTime.slice(1) });
        }

        return {
            deviceId: targetDeviceId,
            signalDeviceId: Number(data.signalDeviceId),
            registrationId: Number(data.registrationId),
            identityKey: String(data.identityKey),
            signedPreKeyId: Number(data.signedPreKeyId),
            signedPreKeyPublic: String(data.signedPreKeyPublic),
            signedPreKeySignature: String(data.signedPreKeySignature),
            kyberPreKeyId: Number(data.kyberPreKeyId),
            kyberPreKeyPublic: String(data.kyberPreKeyPublic),
            kyberPreKeySignature: String(data.kyberPreKeySignature),
            oneTimePreKey: claimed,
            exhausted: !claimed,
        };
    });
}
