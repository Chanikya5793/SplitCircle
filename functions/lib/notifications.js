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
exports.sendPushToUsers = exports.getEligibleRecipients = void 0;
const firestore_1 = require("firebase-admin/firestore");
const logger = __importStar(require("firebase-functions/logger"));
// ─────────────────────────────────────────────────────────────
// Expo Push API
// ─────────────────────────────────────────────────────────────
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const sendExpoPush = async (messages) => {
    var _a;
    if (messages.length === 0) {
        return [];
    }
    try {
        const response = await fetch(EXPO_PUSH_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            body: JSON.stringify(messages),
        });
        if (!response.ok) {
            logger.error("Expo push API returned error status", {
                status: response.status,
                statusText: response.statusText,
            });
            return [];
        }
        const result = await response.json();
        return (_a = result.data) !== null && _a !== void 0 ? _a : [];
    }
    catch (error) {
        logger.error("Failed to call Expo push API", {
            message: error instanceof Error ? error.message : "Unknown error",
        });
        return [];
    }
};
// ─────────────────────────────────────────────────────────────
// User Token Lookup
// ─────────────────────────────────────────────────────────────
/**
 * Look up push tokens and notification preferences for a list of user IDs.
 * Filters out users who have push disabled or the specific category disabled,
 * and respects muted chat IDs.
 */
const getEligibleRecipients = async (userIds, category, chatId) => {
    var _a, _b;
    if (userIds.length === 0) {
        return [];
    }
    const db = (0, firestore_1.getFirestore)();
    const results = [];
    // Firestore `in` queries support max 30 items
    const chunks = [];
    for (let i = 0; i < userIds.length; i += 30) {
        chunks.push(userIds.slice(i, i + 30));
    }
    for (const chunk of chunks) {
        const snapshot = await db
            .collection("users")
            .where("userId", "in", chunk)
            .get();
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const pushToken = data.pushToken;
            const preferences = ((_a = data.preferences) !== null && _a !== void 0 ? _a : {});
            const pushEnabled = preferences.pushEnabled === true;
            const categoryEnabled = preferences[category] !== false; // default true
            const mutedChatIds = ((_b = preferences.muteChatIds) !== null && _b !== void 0 ? _b : []);
            const isMuted = chatId ? mutedChatIds.includes(chatId) : false;
            results.push({
                userId: data.userId,
                pushToken: pushToken !== null && pushToken !== void 0 ? pushToken : null,
                pushEnabled,
                categoryEnabled,
                isMuted,
            });
        }
    }
    return results;
};
exports.getEligibleRecipients = getEligibleRecipients;
// ─────────────────────────────────────────────────────────────
// High-Level Send Helpers
// ─────────────────────────────────────────────────────────────
/**
 * Send push notifications to a list of user IDs, respecting their preferences.
 * Returns the number of notifications actually sent.
 */
const sendPushToUsers = async (userIds, title, body, data, category, chatId, channelId) => {
    const recipients = await (0, exports.getEligibleRecipients)(userIds, category, chatId);
    const messages = recipients
        .filter((r) => r.pushToken && r.pushEnabled && r.categoryEnabled && !r.isMuted)
        .map((r) => ({
        to: r.pushToken,
        title,
        body,
        data,
        sound: "default",
        priority: "high",
        channelId: channelId !== null && channelId !== void 0 ? channelId : mapCategoryToChannel(category),
    }));
    if (messages.length === 0) {
        return 0;
    }
    logger.info(`Sending ${messages.length} push notification(s)`, {
        category,
        title,
    });
    const tickets = await sendExpoPush(messages);
    // Log any individual errors
    for (const ticket of tickets) {
        if (ticket.status === "error") {
            logger.warn("Push ticket error", {
                message: ticket.message,
                details: ticket.details,
            });
        }
    }
    return messages.length;
};
exports.sendPushToUsers = sendPushToUsers;
/**
 * Map notification category to Android channel ID.
 */
const mapCategoryToChannel = (category) => {
    switch (category) {
        case "messages":
            return "messages";
        case "expenses":
            return "expenses";
        case "settlements":
            return "expenses";
        case "groupUpdates":
            return "groups";
        case "calls":
            return "calls";
        default:
            return "general";
    }
};
//# sourceMappingURL=notifications.js.map