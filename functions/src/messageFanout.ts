import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { onValueCreated } from "firebase-functions/v2/database";

/**
 * Per-device message fan-out (ai_layer/docs/31_multi_device_icloud_sync.md
 * §3.1, §5 Phase 2). The CLIENT still writes exactly as it always has —
 * one entry at messageQueue/{recipientId}/{messageId}, via
 * messageQueueService.ts's queueMessage, completely unchanged — because a
 * client can never enumerate another user's pairedDevices to fan a message
 * out itself: firestore.rules only grants isSelf(userId) read access to
 * that collection, the same query-provability wall CLAUDE.md already
 * documents from the invite-code-join bug. This trigger does the fan-out
 * server-side via the Admin SDK instead, exactly like collectVoipDevices/
 * sendPushToUsers already do for push notification fan-out.
 */

const USER_COLLECTION = "users";
const PAIRED_DEVICES_SUBCOLLECTION = "pairedDevices";
const MAX_DEVICES = 4; // mirrors pairing.ts's MAX_ACTIVE_DEVICES (doc 31 decision #21)

/**
 * Keys are `errorName`/`errorMessage`, NOT `name`/`message`.
 *
 * firebase-functions' logger puts its OWN `message` at the top level of the
 * entry, so spreading a `{ message }` payload into a `logger.error` call
 * silently OVERWRITES the cause with the log line's text — the exact defect
 * that made the pairing failure in doc 31 §5f #2 undiagnosable, fixed across
 * index.ts's 45 call sites but missed here, in the one function most directly
 * responsible for delivering messages to a user's linked devices.
 */
const toSafeError = (
    error: unknown,
): { errorName?: string; errorMessage?: string; errorStack?: string } => {
    if (error instanceof Error) {
        return {
            errorName: error.name,
            errorMessage: error.message,
            errorStack: error.stack?.split("\n").slice(0, 4).join(" | "),
        };
    }
    return { errorMessage: String(error) };
};

export const fanOutQueuedMessage = onValueCreated(
    { ref: "/messageQueue/{recipientId}/{messageId}" },
    async (event) => {
        const recipientId = event.params.recipientId;
        const messageId = event.params.messageId;
        const payload = event.data.val();

        if (!recipientId || !messageId || !payload) {
            return;
        }

        try {
            const devicesSnap = await getFirestore()
                .collection(USER_COLLECTION)
                .doc(recipientId)
                .collection(PAIRED_DEVICES_SUBCOLLECTION)
                .where("pairingStatus", "==", "confirmed")
                .limit(MAX_DEVICES)
                .get();

            if (devicesSnap.empty) {
                // No confirmed pairedDevices row yet for this recipient — most
                // likely an account that hasn't opened the app since this
                // feature shipped (syncNotificationDeviceRecord backfills one
                // on next sync, see notifications.ts). Leave the legacy node
                // in place rather than dropping the message; the recipient's
                // still-active legacy listenForMessages subscription (kept
                // as a dual-listen fallback in ChatContext.tsx) will pick it
                // up exactly as it always has.
                logger.info("fanOutQueuedMessage: no confirmed paired devices, leaving legacy node", {
                    recipientId,
                    messageId,
                });
                return;
            }

            // E2E (doc 31 §3.3): the sender encrypts once per recipient device
            // and ships a { deviceId -> envelope } map, because each device is
            // its own Signal endpoint with its own session. Hand each device
            // ONLY its own envelope and strip the map — forwarding the whole
            // thing would hand every device every other device's ciphertext.
            const envelopes = (payload as Record<string, unknown>).envelopes as
                | Record<string, unknown>
                | undefined;

            // Self-sync (doc 31 §3.3): when a user mirrors their own sent
            // message to their other devices, the sending device must be
            // skipped — it already has the message locally, and delivering it
            // back would re-save it and, worse, hand it a ciphertext encrypted
            // to a session it does not hold.
            const originDeviceId = (payload as Record<string, unknown>).originDeviceId;

            const updates: Record<string, unknown> = {};
            for (const deviceDoc of devicesSnap.docs) {
                if (originDeviceId && deviceDoc.id === originDeviceId) {
                    continue;
                }
                let devicePayload = payload;
                if (envelopes) {
                    const envelope = envelopes[deviceDoc.id];
                    if (!envelope) {
                        // No envelope for this device: it published keys after
                        // the sender enumerated them. Skip rather than deliver
                        // an unopenable message — the sender's all-or-nothing
                        // rule means a genuinely undeliverable device should be
                        // covered by the next message once it has keys.
                        logger.warn("fanOutQueuedMessage: no envelope for device", {
                            recipientId,
                            messageId,
                            deviceId: deviceDoc.id,
                        });
                        continue;
                    }
                    devicePayload = { ...payload, envelope, envelopes: null };
                }
                updates[`messageQueueDevices/${recipientId}/${deviceDoc.id}/${messageId}`] = devicePayload;
            }
            // This function is the sole deleter of the relay node — avoids a
            // multi-device race where each device's own listener tries to
            // delete the shared per-user node out from under a slower sibling.
            updates[`messageQueue/${recipientId}/${messageId}`] = null;

            await getDatabase().ref().update(updates);
            // Count actual per-device writes, not devicesSnap.size: the query
            // size includes devices we skipped (the self-sync origin device,
            // or one with no envelope), so logging it claimed a fan-out wider
            // than what really happened — misleading exactly when diagnosing
            // "why didn't my other device get this".
            logger.info("fanOutQueuedMessage: fanned out", {
                recipientId,
                messageId,
                deviceCount: Object.keys(updates).length - 1,
                encrypted: Boolean(envelopes),
                skippedOrigin: Boolean(originDeviceId),
            });
        } catch (error) {
            // Best-effort by design, matching the reaper/relay pattern
            // elsewhere in this codebase: if fan-out fails, the legacy node
            // is left untouched (we never got to the delete), so the
            // dual-listen fallback still delivers the message — just not
            // fanned out to every device this one time.
            logger.error("fanOutQueuedMessage failed", { recipientId, messageId, ...toSafeError(error) });
        }
    },
);
