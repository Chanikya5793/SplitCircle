import { getDatabase } from "firebase-admin/database";
import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const BATCH_SIZE = 500;
// A real ring never lasts this long — CallKit/ConnectionService time out well
// under a minute. Anything still "ringing" past this is an abandoned/orphaned
// call (client crashed, lost network, or was force-quit mid-ring) and must be
// reaped fast so it stops ghost-ringing recipients.
const STALE_RINGING_MS = 90 * 1000;

/**
 * Multi-update in chunks to stay under the RTDB payload limit (~16 MB).
 */
const applyInChunks = async (
    db: ReturnType<typeof getDatabase>,
    updates: Record<string, null>,
): Promise<void> => {
    const entries = Object.entries(updates);
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const chunk = Object.fromEntries(entries.slice(i, i + BATCH_SIZE));
        await db.ref().update(chunk);
    }
};

/**
 * Scheduled function to sweep Firebase Realtime Database and delete
 * receipts, queued messages, and stale call entries.
 */
export const cleanupOldRtdbData = onSchedule("every 24 hours", async (event) => {
    const db = getDatabase();
    const now = Date.now();
    const cutoffTime = now - SEVEN_DAYS_MS;
    const callCutoff = now - ONE_HOUR_MS;

    try {
        let deletedReceipts = 0;
        let deletedMessages = 0;
        let deletedCalls = 0;
        let deletedActiveCalls = 0;

        // 1. Cleanup old receipts
        // Path: receipts/{chatId}/{messageId}/{recipientId}
        const receiptsRef = db.ref("receipts");
        const receiptsSnapshot = await receiptsRef.get();

        if (receiptsSnapshot.exists()) {
            const updates: Record<string, null> = {};

            receiptsSnapshot.forEach((chatSnapshot) => {
                const chatId = chatSnapshot.key;
                chatSnapshot.forEach((messageSnapshot) => {
                    const messageId = messageSnapshot.key;
                    messageSnapshot.forEach((recipientSnapshot) => {
                        const recipientId = recipientSnapshot.key;
                        const data = recipientSnapshot.val();

                        if (data && typeof data.deliveredAt === "number" && data.deliveredAt < cutoffTime) {
                            updates[`receipts/${chatId}/${messageId}/${recipientId}`] = null;
                            deletedReceipts++;
                        }
                    });
                });
            });

            if (Object.keys(updates).length > 0) {
                await applyInChunks(db, updates);
                logger.info(`Deleted ${deletedReceipts} old receipts.`);
            }
        }

        // 2. Cleanup orphaned queued messages
        // Path: messageQueue/{userId}/{messageId}
        const queueRef = db.ref("messageQueue");
        const queueSnapshot = await queueRef.get();

        if (queueSnapshot.exists()) {
            const queueUpdates: Record<string, null> = {};

            queueSnapshot.forEach((userSnapshot) => {
                const userId = userSnapshot.key;
                userSnapshot.forEach((messageSnapshot) => {
                    const messageId = messageSnapshot.key;
                    const data = messageSnapshot.val();

                    if (data && typeof data.timestamp === "number" && data.timestamp < cutoffTime) {
                        queueUpdates[`messageQueue/${userId}/${messageId}`] = null;
                        deletedMessages++;
                    }
                });
            });

            if (Object.keys(queueUpdates).length > 0) {
                await applyInChunks(db, queueUpdates);
                logger.info(`Deleted ${deletedMessages} old queued messages.`);
            }
        }

        // 2b. Per-device fan-out queue (doc 31 Phase 2).
        // Path: messageQueueDevices/{userId}/{deviceId}/{messageId}
        //
        // ADDED because Phase 2 introduced this path and nothing reaped it,
        // breaking CLAUDE.md's "never let RTDB accumulate" rule for a node
        // that grows FASTER than the legacy one it replaced: fan-out writes a
        // copy per device, and a device only deletes its own copy when it
        // comes online to consume it. A revoked, switched-off, or uninstalled
        // device therefore left its copy of every message it never received
        // sitting in RTDB permanently, at N copies per message.
        const deviceQueueRef = db.ref("messageQueueDevices");
        const deviceQueueSnapshot = await deviceQueueRef.get();

        if (deviceQueueSnapshot.exists()) {
            const deviceUpdates: Record<string, null> = {};
            let deletedDeviceMessages = 0;

            deviceQueueSnapshot.forEach((userSnapshot) => {
                const userId = userSnapshot.key;
                userSnapshot.forEach((deviceSnapshot) => {
                    const deviceId = deviceSnapshot.key;
                    deviceSnapshot.forEach((messageSnapshot) => {
                        const messageId = messageSnapshot.key;
                        const data = messageSnapshot.val();
                        if (data && typeof data.timestamp === "number" && data.timestamp < cutoffTime) {
                            deviceUpdates[`messageQueueDevices/${userId}/${deviceId}/${messageId}`] = null;
                            deletedDeviceMessages++;
                        }
                    });
                });
            });

            if (Object.keys(deviceUpdates).length > 0) {
                await applyInChunks(db, deviceUpdates);
                logger.info(`Deleted ${deletedDeviceMessages} old per-device queued messages.`);
            }
        }

        // 2c. Pairing-confirm nudges (doc 31 §3.4).
        // Path: pairingConfirm/{uid}/{code}
        //
        // redeemPairingCode writes these as a low-latency hint to a main
        // device that already has the app open, and NOTHING has ever deleted
        // them — not the client that consumes one, not any reaper. Small, but
        // unbounded and permanent, and each one names a real pairing event.
        // Pairing codes live 5 minutes, so anything past the general cutoff is
        // long dead.
        const pairingConfirmRef = db.ref("pairingConfirm");
        const pairingConfirmSnapshot = await pairingConfirmRef.get();

        if (pairingConfirmSnapshot.exists()) {
            const pairingUpdates: Record<string, null> = {};
            let deletedNudges = 0;

            pairingConfirmSnapshot.forEach((userSnapshot) => {
                const uid = userSnapshot.key;
                userSnapshot.forEach((codeSnapshot) => {
                    const code = codeSnapshot.key;
                    const data = codeSnapshot.val();
                    if (data && typeof data.at === "number" && data.at < cutoffTime) {
                        pairingUpdates[`pairingConfirm/${uid}/${code}`] = null;
                        deletedNudges++;
                    }
                });
            });

            if (Object.keys(pairingUpdates).length > 0) {
                await applyInChunks(db, pairingUpdates);
                logger.info(`Deleted ${deletedNudges} stale pairing-confirm nudges.`);
            }
        }

        // 3. Cleanup stale call entries — any call older than 1 hour is dead.
        //    Calls stuck in "ringing" because the client crashed / lost network
        //    will linger forever without this, and the client may surface them
        //    as ghost calls when it next reads /calls or /userActiveCalls.
        // Path: calls/{callId}
        const callsRef = db.ref("calls");
        const callsSnapshot = await callsRef.get();

        if (callsSnapshot.exists()) {
            const callUpdates: Record<string, null> = {};

            callsSnapshot.forEach((callSnapshot) => {
                const callId = callSnapshot.key;
                const data = callSnapshot.val();
                if (!data || typeof data !== "object") return;

                const startedAt = typeof data.startedAt === "number" ? data.startedAt : 0;
                // Delete if: older than 1 hour, OR status is a terminal state
                // (ended/missed/declined) and older than 1 hour.
                if (startedAt > 0 && startedAt < callCutoff) {
                    callUpdates[`calls/${callId}`] = null;
                    deletedCalls++;
                }
            });

            if (Object.keys(callUpdates).length > 0) {
                await applyInChunks(db, callUpdates);
                logger.info(`Deleted ${deletedCalls} stale call entries.`);
            }
        }

        // 4. Cleanup stale userActiveCalls pointers — these reference /calls
        //    entries that we just deleted (or that were already dead).
        // Path: userActiveCalls/{userId}/{callId}
        const activeCallsRef = db.ref("userActiveCalls");
        const activeCallsSnapshot = await activeCallsRef.get();

        if (activeCallsSnapshot.exists()) {
            const acUpdates: Record<string, null> = {};

            activeCallsSnapshot.forEach((userSnapshot) => {
                const userId = userSnapshot.key;
                userSnapshot.forEach((callSnapshot) => {
                    const callId = callSnapshot.key;
                    const data = callSnapshot.val();
                    const ts = typeof data === "number" ? data
                        : (typeof data?.startedAt === "number" ? data.startedAt : 0);
                    if (ts > 0 && ts < callCutoff) {
                        acUpdates[`userActiveCalls/${userId}/${callId}`] = null;
                        deletedActiveCalls++;
                    }
                });
            });

            if (Object.keys(acUpdates).length > 0) {
                await applyInChunks(db, acUpdates);
                logger.info(`Deleted ${deletedActiveCalls} stale userActiveCalls entries.`);
            }
        }

        logger.info("RTDB cleanup completed", {
            deletedReceipts,
            deletedMessages,
            deletedCalls,
            deletedActiveCalls,
        });
    } catch (error) {
        logger.error("Failed to run RTDB cleanup", error);
    }
});

/**
 * Fast reaper for orphaned RINGING calls. The daily cleanup above only removes
 * calls older than an hour, so an abandoned ring could ghost recipients for up
 * to an hour (and the backlog only clears once a day). This runs every couple
 * of minutes and deletes any call stuck in "ringing" past STALE_RINGING_MS,
 * plus its userActiveCalls pointers. Connected calls are intentionally left
 * alone (they can legitimately last a long time and have no age-based expiry).
 */
export const reapStaleRingingCalls = onSchedule("every 2 minutes", async () => {
    const db = getDatabase();
    const now = Date.now();
    const cutoff = now - STALE_RINGING_MS;

    try {
        const callsSnapshot = await db.ref("calls").get();
        if (!callsSnapshot.exists()) return;

        const updates: Record<string, null> = {};
        const staleCallIds: string[] = [];

        callsSnapshot.forEach((callSnapshot) => {
            const callId = callSnapshot.key;
            const data = callSnapshot.val();
            if (!callId || !data || typeof data !== "object") return;
            const startedAt = typeof data.startedAt === "number" ? data.startedAt : 0;
            if (data.status === "ringing" && startedAt > 0 && startedAt < cutoff) {
                updates[`calls/${callId}`] = null;
                staleCallIds.push(callId);
            }
        });

        if (staleCallIds.length === 0) return;

        // Drop the matching userActiveCalls pointers so clients don't resurface
        // them from the index between the delete and the next daily sweep.
        const staleSet = new Set(staleCallIds);
        const activeSnapshot = await db.ref("userActiveCalls").get();
        if (activeSnapshot.exists()) {
            activeSnapshot.forEach((userSnapshot) => {
                const userId = userSnapshot.key;
                userSnapshot.forEach((callSnapshot) => {
                    const callId = callSnapshot.key;
                    if (callId && staleSet.has(callId)) {
                        updates[`userActiveCalls/${userId}/${callId}`] = null;
                    }
                });
            });
        }

        await applyInChunks(db, updates);
        logger.info("Reaped stale ringing calls", { count: staleCallIds.length });
    } catch (error) {
        logger.error("Failed to reap stale ringing calls", error);
    }
});
