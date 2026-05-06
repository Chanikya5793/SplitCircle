import { getDatabase } from "firebase-admin/database";
import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Scheduled function to sweep Firebase Realtime Database and delete
 * receipts and queued messages that are older than 7 days.
 */
export const cleanupOldRtdbData = onSchedule("every 24 hours", async (event) => {
    const db = getDatabase();
    const now = Date.now();
    const cutoffTime = now - SEVEN_DAYS_MS;

    try {
        let deletedReceipts = 0;
        let deletedMessages = 0;

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

            // Update in chunks to avoid max payload limits if there are huge amounts of data
            if (Object.keys(updates).length > 0) {
                await db.ref().update(updates);
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
                await db.ref().update(queueUpdates);
                logger.info(`Deleted ${deletedMessages} old queued messages.`);
            }
        }

        logger.info(`RTDB cleanup completed. Wiped ${deletedReceipts} receipts and ${deletedMessages} queued messages.`);
    } catch (error) {
        logger.error("Failed to run RTDB cleanup", error);
    }
});
