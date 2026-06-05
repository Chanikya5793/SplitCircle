import { getDatabase } from "firebase-admin/database";
import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const BATCH_SIZE = 500;

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
