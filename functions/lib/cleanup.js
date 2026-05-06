"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupOldRtdbData = void 0;
const database_1 = require("firebase-admin/database");
const logger = __importStar(require("firebase-functions/logger"));
const scheduler_1 = require("firebase-functions/v2/scheduler");
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Scheduled function to sweep Firebase Realtime Database and delete
 * receipts and queued messages that are older than 7 days.
 */
exports.cleanupOldRtdbData = (0, scheduler_1.onSchedule)("every 24 hours", async (event) => {
    const db = (0, database_1.getDatabase)();
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
            const updates = {};
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
            const queueUpdates = {};
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
    }
    catch (error) {
        logger.error("Failed to run RTDB cleanup", error);
    }
});
//# sourceMappingURL=cleanup.js.map