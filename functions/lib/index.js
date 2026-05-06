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
exports.generateLiveKitToken = exports.triggerRecurringBillsForGroup = exports.processNotificationReceipts = exports.runRecurringBillsScheduler = exports.registerVoipPushToken = exports.onCallCreated = exports.onGroupUpdated = exports.onChatUpdated = exports.sendTestPushNotification = exports.unregisterNotificationDevice = exports.syncNotificationDevice = exports.cleanupOldRtdbData = exports.parseReceiptWithLLM = void 0;
const app_1 = require("firebase-admin/app");
const auth_1 = require("firebase-admin/auth");
const database_1 = require("firebase-admin/database");
const firestore_1 = require("firebase-admin/firestore");
const logger = __importStar(require("firebase-functions/logger"));
const params_1 = require("firebase-functions/params");
const https_1 = require("firebase-functions/v2/https");
const database_2 = require("firebase-functions/v2/database");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firestore_2 = require("firebase-functions/v2/firestore");
const livekit_server_sdk_1 = require("livekit-server-sdk");
const recurringBills_1 = require("./recurringBills");
const notifications_1 = require("./notifications");
const voipPush_1 = require("./voipPush");
const friends_1 = require("./friends");
var parseReceiptWithLLM_1 = require("./parseReceiptWithLLM");
Object.defineProperty(exports, "parseReceiptWithLLM", { enumerable: true, get: function () { return parseReceiptWithLLM_1.parseReceiptWithLLM; } });
var cleanup_1 = require("./cleanup");
Object.defineProperty(exports, "cleanupOldRtdbData", { enumerable: true, get: function () { return cleanup_1.cleanupOldRtdbData; } });
(0, app_1.initializeApp)();
const livekitUrlSecret = (0, params_1.defineSecret)("LIVEKIT_URL");
const livekitApiKeySecret = (0, params_1.defineSecret)("LIVEKIT_API_KEY");
const livekitApiSecretSecret = (0, params_1.defineSecret)("LIVEKIT_API_SECRET");
const getStringValue = (input) => {
    return typeof input === "string" ? input.trim() : "";
};
const truncate = (input, maxLength) => {
    const compact = input.replace(/\s+/g, " ").trim();
    if (compact.length <= maxLength) {
        return compact;
    }
    return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};
const getAllowedUserIds = (allowedUserIds) => Object.entries(allowedUserIds !== null && allowedUserIds !== void 0 ? allowedUserIds : {})
    .filter(([, allowed]) => allowed === true)
    .map(([userId]) => userId);
const normalizeCallParticipants = (input) => {
    if (!input) {
        return [];
    }
    if (Array.isArray(input)) {
        return input;
    }
    return Object.values(input);
};
const sanitizeParticipantName = (rawName, fallback) => {
    const cleaned = rawName.replace(/[\u0000-\u001F\u007F]/g, "").trim();
    if (!cleaned)
        return fallback;
    return cleaned.slice(0, 64);
};
const isSafeIdentifier = (value) => {
    return /^[A-Za-z0-9_-]{1,128}$/.test(value);
};
const toSafeError = (error) => {
    if (error instanceof Error) {
        return { name: error.name, message: error.message };
    }
    return { message: "Unknown error" };
};
const getSecretOrEnv = (secret, envName) => {
    var _a, _b;
    try {
        const secretValue = secret.value().trim();
        if (secretValue.length > 0)
            return secretValue;
    }
    catch (_c) {
        // Fall back to env vars in local emulator/dev contexts.
    }
    return (_b = (_a = process.env[envName]) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
};
const getBearerToken = (authorizationHeader) => {
    if (!authorizationHeader)
        return null;
    const [scheme, token] = authorizationHeader.trim().split(" ");
    if (scheme !== "Bearer" || !token)
        return null;
    return token;
};
const getAuthenticatedUid = async (authorizationHeader) => {
    var _a;
    const bearerToken = getBearerToken(authorizationHeader);
    if (!bearerToken)
        return null;
    try {
        const decoded = await (0, auth_1.getAuth)().verifyIdToken(bearerToken);
        return (_a = decoded.uid) !== null && _a !== void 0 ? _a : null;
    }
    catch (_b) {
        return null;
    }
};
const describeMessagePreview = (messageType, content) => {
    switch (messageType) {
        case "image":
            return "sent a photo";
        case "video":
            return "sent a video";
        case "audio":
            return "sent an audio message";
        case "file":
            return "shared a file";
        case "location":
            return "shared a location";
        default:
            return truncate(content || "sent a message", 110);
    }
};
const buildMessageNotificationCopy = (params) => {
    const preview = describeMessagePreview(params.messageType, params.content);
    if (params.groupName) {
        return {
            title: params.groupName,
            subtitle: params.senderName,
            body: preview,
        };
    }
    return {
        title: params.senderName,
        body: preview,
    };
};
const buildExpenseNotificationCopy = (params) => ({
    title: params.groupName,
    subtitle: `${params.currency} ${params.amount.toFixed(2)}`,
    body: `${params.payerName} added "${truncate(params.description || "New expense", 60)}"`,
});
const buildSettlementNotificationCopy = (params) => ({
    title: params.groupName,
    subtitle: "Settlement update",
    body: `${params.fromName} settled ${params.currency} ${params.amount.toFixed(2)} with you`,
});
const buildGroupJoinNotificationCopy = (params) => ({
    title: params.groupName,
    subtitle: "Group update",
    body: `${params.memberName} joined the group`,
});
const buildIncomingCallNotificationCopy = (params) => {
    const typeLabel = params.callType === "video" ? "Video call" : "Audio call";
    const isGroup = params.participantCount > 2 || Boolean(params.conversationName);
    if (isGroup && params.conversationName) {
        return {
            title: `Incoming ${typeLabel.toLowerCase()}`,
            subtitle: params.conversationName,
            body: `${params.callerName} started a group ${params.callType} call`,
        };
    }
    return {
        title: `${params.callerName} is calling`,
        subtitle: typeLabel,
        body: `Tap to join the ${params.callType} call in ManaSplit.`,
    };
};
// ─────────────────────────────────────────────────────────────
// Push Notifications — Device Registration and Diagnostics
// ─────────────────────────────────────────────────────────────
exports.syncNotificationDevice = (0, https_1.onCall)(async (request) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!uid) {
        throw new https_1.HttpsError("unauthenticated", "Authentication required.");
    }
    const deviceId = getStringValue((_b = request.data) === null || _b === void 0 ? void 0 : _b.deviceId);
    const platform = ((_c = request.data) === null || _c === void 0 ? void 0 : _c.platform) === "android" ? "android" : "ios";
    const rawPermissionState = getStringValue((_d = request.data) === null || _d === void 0 ? void 0 : _d.permissionState);
    const permissionState = rawPermissionState === "granted" ||
        rawPermissionState === "provisional" ||
        rawPermissionState === "ephemeral" ||
        rawPermissionState === "denied"
        ? rawPermissionState
        : "undetermined";
    if (!deviceId) {
        throw new https_1.HttpsError("invalid-argument", "Missing required field: deviceId");
    }
    const result = await (0, notifications_1.syncNotificationDeviceRecord)(uid, {
        deviceId,
        platform,
        expoPushToken: getStringValue((_e = request.data) === null || _e === void 0 ? void 0 : _e.expoPushToken) || null,
        permissionState,
        projectId: getStringValue((_f = request.data) === null || _f === void 0 ? void 0 : _f.projectId) || null,
        appVersion: getStringValue((_g = request.data) === null || _g === void 0 ? void 0 : _g.appVersion) || null,
        deviceName: getStringValue((_h = request.data) === null || _h === void 0 ? void 0 : _h.deviceName) || null,
        modelName: getStringValue((_j = request.data) === null || _j === void 0 ? void 0 : _j.modelName) || null,
        isPhysicalDevice: ((_k = request.data) === null || _k === void 0 ? void 0 : _k.isPhysicalDevice) === true,
        lastRegistrationError: getStringValue((_l = request.data) === null || _l === void 0 ? void 0 : _l.lastRegistrationError) || null,
    });
    logger.info("Synced notification device", {
        uid,
        deviceId,
        registrationStatus: result.registrationStatus,
        platform,
        permissionState,
    });
    return result;
});
exports.unregisterNotificationDevice = (0, https_1.onCall)(async (request) => {
    var _a, _b;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!uid) {
        throw new https_1.HttpsError("unauthenticated", "Authentication required.");
    }
    const deviceId = getStringValue((_b = request.data) === null || _b === void 0 ? void 0 : _b.deviceId);
    if (!deviceId) {
        throw new https_1.HttpsError("invalid-argument", "Missing required field: deviceId");
    }
    await (0, notifications_1.unregisterNotificationDeviceRecord)(uid, deviceId);
    logger.info("Unregistered notification device", { uid, deviceId });
    return { success: true };
});
exports.sendTestPushNotification = (0, https_1.onCall)(async (request) => {
    var _a;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!uid) {
        throw new https_1.HttpsError("unauthenticated", "Authentication required.");
    }
    try {
        const result = await (0, notifications_1.sendPushToUsers)([uid], "ManaSplit test notification", "Remote push is flowing through the backend, Expo, and your device registration.", {
            type: "general",
            source: "settings_test",
        }, "general", undefined, "general");
        if (result.acceptedCount === 0) {
            throw new https_1.HttpsError("failed-precondition", "No eligible devices are currently registered for remote push delivery.", {
                deliveryId: result.deliveryId,
                status: result.status,
                droppedCount: result.droppedCount,
            });
        }
        return result;
    }
    catch (error) {
        if (error instanceof https_1.HttpsError) {
            throw error;
        }
        logger.error("Failed to send test push notification", {
            uid,
            error: toSafeError(error),
        });
        throw new https_1.HttpsError("internal", error instanceof Error
            ? error.message
            : "Unexpected notification delivery failure.");
    }
});
// ─────────────────────────────────────────────────────────────
// Push Notifications — Chat Messages
// ─────────────────────────────────────────────────────────────
exports.onChatUpdated = (0, firestore_2.onDocumentUpdated)("chats/{chatId}", async (event) => {
    var _a, _b, _c, _d, _e, _f, _g;
    const before = (_a = event.data) === null || _a === void 0 ? void 0 : _a.before.data();
    const after = (_b = event.data) === null || _b === void 0 ? void 0 : _b.after.data();
    if (!before || !after) {
        return;
    }
    const chatId = event.params.chatId;
    // Detect new lastMessage
    const beforeMsg = before.lastMessage;
    const afterMsg = after.lastMessage;
    if (!afterMsg) {
        return;
    }
    // Skip if lastMessage hasn't changed
    const beforeMsgId = (_c = beforeMsg === null || beforeMsg === void 0 ? void 0 : beforeMsg.messageId) !== null && _c !== void 0 ? _c : beforeMsg === null || beforeMsg === void 0 ? void 0 : beforeMsg.id;
    const afterMsgId = (_d = afterMsg.messageId) !== null && _d !== void 0 ? _d : afterMsg.id;
    if (beforeMsgId === afterMsgId) {
        return;
    }
    // Skip system messages
    if (afterMsg.type === "system") {
        return;
    }
    const senderId = afterMsg.senderId;
    const content = afterMsg.content;
    const msgType = afterMsg.type;
    const participantIds = ((_e = after.participantIds) !== null && _e !== void 0 ? _e : []);
    // Get sender name
    let senderName = "Someone";
    try {
        const senderDoc = await (0, firestore_1.getFirestore)().collection("users").doc(senderId).get();
        if (senderDoc.exists) {
            senderName = ((_f = senderDoc.data()) === null || _f === void 0 ? void 0 : _f.displayName) || "Someone";
        }
    }
    catch (_h) {
        // Use fallback name
    }
    const groupId = after.groupId;
    let groupName;
    if (groupId) {
        try {
            const groupDoc = await (0, firestore_1.getFirestore)().collection("groups").doc(groupId).get();
            if (groupDoc.exists) {
                groupName = getStringValue((_g = groupDoc.data()) === null || _g === void 0 ? void 0 : _g.name);
            }
        }
        catch (_j) {
            // Keep direct-chat fallback styling
        }
    }
    const notificationCopy = buildMessageNotificationCopy({
        senderName,
        groupName,
        messageType: msgType,
        content,
    });
    // Send to all participants except the sender
    const recipientIds = participantIds.filter((id) => id !== senderId);
    if (recipientIds.length === 0) {
        return;
    }
    try {
        const dispatch = await (0, notifications_1.sendPushToUsers)(recipientIds, notificationCopy.title, notificationCopy.body, Object.assign(Object.assign({ type: "message", chatId }, (groupId ? { groupId } : {})), { senderId,
            senderName }), "messages", chatId, "messages", { subtitle: notificationCopy.subtitle });
        logger.info("Queued message notifications", {
            chatId,
            deliveryId: dispatch.deliveryId,
            acceptedCount: dispatch.acceptedCount,
            targetedDeviceCount: dispatch.targetedDeviceCount,
        });
    }
    catch (error) {
        logger.error("Failed to send message notifications", toSafeError(error));
    }
});
// ─────────────────────────────────────────────────────────────
// Push Notifications — Group Updates (Expenses, Settlements, Members)
// ─────────────────────────────────────────────────────────────
exports.onGroupUpdated = (0, firestore_2.onDocumentUpdated)("groups/{groupId}", async (event) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const before = (_a = event.data) === null || _a === void 0 ? void 0 : _a.before.data();
    const after = (_b = event.data) === null || _b === void 0 ? void 0 : _b.after.data();
    if (!before || !after) {
        return;
    }
    const groupId = event.params.groupId;
    const groupName = after.name || "Group";
    const memberIds = ((_c = after.memberIds) !== null && _c !== void 0 ? _c : []);
    // ─── Detect new expenses ────────────────────────────
    const beforeExpenses = ((_d = before.expenses) !== null && _d !== void 0 ? _d : []);
    const afterExpenses = ((_e = after.expenses) !== null && _e !== void 0 ? _e : []);
    if (afterExpenses.length > beforeExpenses.length) {
        const beforeIds = new Set(beforeExpenses.map((e) => e.expenseId));
        const newExpenses = afterExpenses.filter((e) => !beforeIds.has(e.expenseId));
        for (const expense of newExpenses) {
            const paidBy = expense.paidBy;
            const description = expense.description || "New expense";
            const amount = expense.amount;
            const currency = after.currency || "USD";
            // Debt-derived friend fan-out — pair the payer with every
            // participant in the split. Best-effort, never blocks the
            // notification path below.
            const expenseParticipants = Array.isArray(expense.participants)
                ? expense.participants
                    .map((p) => p === null || p === void 0 ? void 0 : p.userId)
                    .filter((id) => typeof id === "string")
                : [];
            if (paidBy && expenseParticipants.length > 0) {
                void (0, friends_1.materializeDebtFriendships)(paidBy, expenseParticipants);
            }
            let payerName = "Someone";
            try {
                const payerDoc = await (0, firestore_1.getFirestore)().collection("users").doc(paidBy).get();
                if (payerDoc.exists) {
                    payerName = ((_f = payerDoc.data()) === null || _f === void 0 ? void 0 : _f.displayName) || "Someone";
                }
            }
            catch (_m) {
                // Use fallback
            }
            const recipientIds = memberIds.filter((id) => id !== paidBy);
            if (recipientIds.length > 0) {
                try {
                    const notificationCopy = buildExpenseNotificationCopy({
                        groupName,
                        payerName,
                        description,
                        currency,
                        amount,
                    });
                    const dispatch = await (0, notifications_1.sendPushToUsers)(recipientIds, notificationCopy.title, notificationCopy.body, {
                        type: "expense",
                        groupId,
                        expenseId: expense.expenseId,
                    }, "expenses", undefined, "expenses", { subtitle: notificationCopy.subtitle });
                    logger.info("Queued expense notifications", {
                        groupId,
                        deliveryId: dispatch.deliveryId,
                        acceptedCount: dispatch.acceptedCount,
                        targetedDeviceCount: dispatch.targetedDeviceCount,
                    });
                }
                catch (error) {
                    logger.error("Failed to send expense notification", toSafeError(error));
                }
            }
        }
    }
    // ─── Detect new settlements ─────────────────────────
    const beforeSettlements = ((_g = before.settlements) !== null && _g !== void 0 ? _g : []);
    const afterSettlements = ((_h = after.settlements) !== null && _h !== void 0 ? _h : []);
    if (afterSettlements.length > beforeSettlements.length) {
        const beforeSettlementIds = new Set(beforeSettlements.map((s) => s.settlementId));
        const newSettlements = afterSettlements.filter((s) => !beforeSettlementIds.has(s.settlementId));
        for (const settlement of newSettlements) {
            const fromUserId = settlement.fromUserId;
            const toUserId = settlement.toUserId;
            const amount = settlement.amount;
            // Bump lastInteractionAt for both sides — keeps "active friends"
            // sortable in the Friends tab.
            if (fromUserId && toUserId) {
                void (0, friends_1.touchFriendInteraction)(fromUserId, toUserId);
            }
            const currency = after.currency || "USD";
            let fromName = "Someone";
            try {
                const fromDoc = await (0, firestore_1.getFirestore)().collection("users").doc(fromUserId).get();
                if (fromDoc.exists) {
                    fromName = ((_j = fromDoc.data()) === null || _j === void 0 ? void 0 : _j.displayName) || "Someone";
                }
            }
            catch (_o) {
                // Use fallback
            }
            // Notify the person being paid
            try {
                const notificationCopy = buildSettlementNotificationCopy({
                    groupName,
                    fromName,
                    currency,
                    amount,
                });
                const dispatch = await (0, notifications_1.sendPushToUsers)([toUserId], notificationCopy.title, notificationCopy.body, {
                    type: "settlement",
                    groupId,
                    settlementId: settlement.settlementId,
                }, "settlements", undefined, "expenses", { subtitle: notificationCopy.subtitle });
                logger.info("Queued settlement notifications", {
                    groupId,
                    deliveryId: dispatch.deliveryId,
                    acceptedCount: dispatch.acceptedCount,
                    targetedDeviceCount: dispatch.targetedDeviceCount,
                });
            }
            catch (error) {
                logger.error("Failed to send settlement notification", toSafeError(error));
            }
        }
    }
    // ─── Detect new members ─────────────────────────────
    const beforeMemberIds = ((_k = before.memberIds) !== null && _k !== void 0 ? _k : []);
    const newMemberIds = memberIds.filter((id) => !beforeMemberIds.includes(id));
    if (newMemberIds.length > 0) {
        // Group-derived friend fan-out: pair every new member with every
        // *existing* member. We pass the full member set; the helper is
        // idempotent so existing edges are kept and only new edges get
        // written. Fire-and-forget — must not block the notification path.
        void (0, friends_1.materializeGroupFriendships)(memberIds);
        for (const newMemberId of newMemberIds) {
            let memberName = "Someone";
            try {
                const memberDoc = await (0, firestore_1.getFirestore)().collection("users").doc(newMemberId).get();
                if (memberDoc.exists) {
                    memberName = ((_l = memberDoc.data()) === null || _l === void 0 ? void 0 : _l.displayName) || "Someone";
                }
            }
            catch (_p) {
                // Use fallback
            }
            const existingMembers = beforeMemberIds;
            if (existingMembers.length > 0) {
                try {
                    const notificationCopy = buildGroupJoinNotificationCopy({
                        groupName,
                        memberName,
                    });
                    const dispatch = await (0, notifications_1.sendPushToUsers)(existingMembers, notificationCopy.title, notificationCopy.body, {
                        type: "group_join",
                        groupId,
                    }, "groupUpdates", undefined, "groups", { subtitle: notificationCopy.subtitle });
                    logger.info("Queued group-join notifications", {
                        groupId,
                        deliveryId: dispatch.deliveryId,
                        acceptedCount: dispatch.acceptedCount,
                        targetedDeviceCount: dispatch.targetedDeviceCount,
                    });
                }
                catch (error) {
                    logger.error("Failed to send group join notification", toSafeError(error));
                }
            }
        }
    }
});
// ─────────────────────────────────────────────────────────────
// Push Notifications — Incoming Calls
// ─────────────────────────────────────────────────────────────
exports.onCallCreated = (0, database_2.onValueCreated)({
    ref: "/calls/{callId}",
    secrets: voipPush_1.voipPushSecrets,
}, async (event) => {
    var _a, _b, _c;
    const callId = event.params.callId;
    const callData = (_a = event.data) === null || _a === void 0 ? void 0 : _a.val();
    if (!callId || !callData) {
        return;
    }
    if (callData.status !== "ringing") {
        return;
    }
    const chatId = getStringValue(callData.chatId);
    const initiatorId = getStringValue(callData.initiatorId);
    const groupId = getStringValue(callData.groupId);
    const callType = callData.type === "video" ? "video" : "audio";
    const recipientIds = getAllowedUserIds(callData.allowedUserIds).filter((userId) => userId !== initiatorId);
    if (!chatId || !initiatorId || recipientIds.length === 0) {
        return;
    }
    const participants = normalizeCallParticipants(callData.participants);
    const initiatorParticipant = participants.find((participant) => getStringValue(participant.userId) === initiatorId);
    let callerName = sanitizeParticipantName(getStringValue(initiatorParticipant === null || initiatorParticipant === void 0 ? void 0 : initiatorParticipant.displayName), "Someone");
    if (!callerName || callerName === "Someone") {
        try {
            const initiatorDoc = await (0, firestore_1.getFirestore)().collection("users").doc(initiatorId).get();
            if (initiatorDoc.exists) {
                callerName = sanitizeParticipantName(getStringValue((_b = initiatorDoc.data()) === null || _b === void 0 ? void 0 : _b.displayName), "Someone");
            }
        }
        catch (_d) {
            // Use best-effort caller name from session.
        }
    }
    let conversationName;
    if (groupId) {
        try {
            const groupDoc = await (0, firestore_1.getFirestore)().collection("groups").doc(groupId).get();
            if (groupDoc.exists) {
                const rawName = getStringValue((_c = groupDoc.data()) === null || _c === void 0 ? void 0 : _c.name);
                conversationName = rawName || undefined;
            }
        }
        catch (_e) {
            // Best-effort only.
        }
    }
    const notificationCopy = buildIncomingCallNotificationCopy({
        callerName,
        callType,
        conversationName,
        participantCount: getAllowedUserIds(callData.allowedUserIds).length,
    });
    try {
        const dispatch = await (0, notifications_1.sendPushToUsers)(recipientIds, notificationCopy.title, notificationCopy.body, Object.assign({ type: "call", chatId,
            callId,
            callType, senderId: initiatorId, senderName: callerName }, (groupId ? { groupId } : {})), "calls", undefined, "calls", { subtitle: notificationCopy.subtitle });
        logger.info("Queued incoming call notifications", {
            callId,
            chatId,
            groupId: groupId || null,
            initiatorId,
            callType,
            deliveryId: dispatch.deliveryId,
            acceptedCount: dispatch.acceptedCount,
            targetedDeviceCount: dispatch.targetedDeviceCount,
        });
    }
    catch (error) {
        logger.error("Failed to send incoming call notification", {
            callId,
            chatId,
            initiatorId,
            error: toSafeError(error),
        });
    }
    // Fire VoIP push in parallel — this is what wakes the system CallKit
    // ringing UI on iOS even when the app is killed. The Expo push above
    // remains as a fallback for Android (which uses ConnectionService) and
    // for iOS devices that haven't yet registered a VoIP token.
    try {
        const voipResult = await (0, voipPush_1.sendCallVoipPush)({
            callId,
            chatId,
            groupId: groupId || undefined,
            initiatorId,
            initiatorName: callerName,
            callType,
            recipientUserIds: recipientIds,
            handle: chatId,
        });
        logger.info("VoIP call push dispatched", {
            callId,
            accepted: voipResult.accepted,
            failed: voipResult.failed,
        });
    }
    catch (error) {
        logger.error("VoIP call push failed", {
            callId,
            error: toSafeError(error),
        });
    }
});
// ─────────────────────────────────────────────────────────────
// VoIP Push Token Registration (callable)
// ─────────────────────────────────────────────────────────────
exports.registerVoipPushToken = (0, https_1.onCall)({
    cors: true,
}, async (request) => {
    var _a, _b;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!uid) {
        throw new https_1.HttpsError("unauthenticated", "Sign-in required.");
    }
    const data = ((_b = request.data) !== null && _b !== void 0 ? _b : {});
    const deviceId = getStringValue(data.deviceId);
    const voipPushToken = getStringValue(data.voipPushToken);
    const bundleId = getStringValue(data.bundleId) || undefined;
    const platform = getStringValue(data.platform) || "ios";
    if (!deviceId || !voipPushToken) {
        throw new https_1.HttpsError("invalid-argument", "deviceId and voipPushToken are required.");
    }
    if (voipPushToken.length > 256 || !/^[A-Fa-f0-9]+$/.test(voipPushToken)) {
        throw new https_1.HttpsError("invalid-argument", "voipPushToken must be a hex device token.");
    }
    await (0, voipPush_1.upsertVoipTokenForDevice)({
        userId: uid,
        deviceId,
        voipPushToken,
        bundleId,
        platform,
    });
    return { ok: true };
});
// ─────────────────────────────────────────────────────────────
// Scheduler — Recurring Bills
// ─────────────────────────────────────────────────────────────
exports.runRecurringBillsScheduler = (0, scheduler_1.onSchedule)("every 15 minutes", async () => {
    try {
        const result = await (0, recurringBills_1.processAllDueRecurringBills)();
        logger.info("Recurring bills scheduler completed", result);
    }
    catch (error) {
        logger.error("Recurring bills scheduler failed", toSafeError(error));
        throw error;
    }
});
exports.processNotificationReceipts = (0, scheduler_1.onSchedule)("every 10 minutes", async () => {
    try {
        const result = await (0, notifications_1.processPendingNotificationReceipts)();
        logger.info("Processed pending notification receipts", result);
    }
    catch (error) {
        logger.error("Failed to process notification receipts", toSafeError(error));
        throw error;
    }
});
exports.triggerRecurringBillsForGroup = (0, https_1.onCall)(async (request) => {
    var _a, _b, _c;
    const uid = (_a = request.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!uid) {
        throw new https_1.HttpsError("unauthenticated", "Authentication required.");
    }
    const groupId = getStringValue((_b = request.data) === null || _b === void 0 ? void 0 : _b.groupId);
    if (!groupId) {
        throw new https_1.HttpsError("invalid-argument", "Missing required field: groupId");
    }
    const groupDoc = await (0, firestore_1.getFirestore)().collection("groups").doc(groupId).get();
    if (!groupDoc.exists) {
        throw new https_1.HttpsError("not-found", "Group not found.");
    }
    const memberIds = Array.isArray((_c = groupDoc.data()) === null || _c === void 0 ? void 0 : _c.memberIds)
        ? groupDoc.data().memberIds
        : [];
    if (!memberIds.includes(uid)) {
        throw new https_1.HttpsError("permission-denied", "User is not a member of this group.");
    }
    try {
        const result = await (0, recurringBills_1.processGroupDueRecurringBills)(groupId);
        logger.info("Recurring bills sync completed for group", Object.assign({ groupId,
            uid }, result));
        return {
            generatedCount: result.generatedExpenses,
            processedBills: result.processedBills,
            scannedBills: result.scannedBills,
        };
    }
    catch (error) {
        logger.error("Recurring bills sync failed for group", Object.assign({ groupId,
            uid }, toSafeError(error)));
        throw new https_1.HttpsError("internal", "Failed to sync recurring bills.");
    }
});
// ─────────────────────────────────────────────────────────────
// LiveKit Token Generation
// ─────────────────────────────────────────────────────────────
exports.generateLiveKitToken = (0, https_1.onRequest)({
    cors: true,
    secrets: [livekitUrlSecret, livekitApiKeySecret, livekitApiSecretSecret],
}, async (req, res) => {
    var _a, _b, _c, _d, _e;
    res.set("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
    }
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed. Use POST." });
        return;
    }
    try {
        const uid = await getAuthenticatedUid((_a = req.get("Authorization")) !== null && _a !== void 0 ? _a : undefined);
        if (!uid) {
            res.status(401).json({ error: "Unauthorized. Missing or invalid Firebase ID token." });
            return;
        }
        const requestBody = (typeof req.body === "object" && req.body !== null)
            ? req.body
            : {};
        const roomName = getStringValue((_b = requestBody.roomName) !== null && _b !== void 0 ? _b : req.query.roomName);
        const chatId = getStringValue((_c = requestBody.chatId) !== null && _c !== void 0 ? _c : req.query.chatId);
        const participantName = sanitizeParticipantName(getStringValue((_d = requestBody.name) !== null && _d !== void 0 ? _d : req.query.name), uid);
        if (!roomName || !chatId) {
            res.status(400).json({ error: "Missing required parameters: roomName, chatId" });
            return;
        }
        if (!isSafeIdentifier(roomName) || !isSafeIdentifier(chatId)) {
            res.status(400).json({ error: "Invalid roomName or chatId format." });
            return;
        }
        const chatDoc = await (0, firestore_1.getFirestore)().collection("chats").doc(chatId).get();
        if (!chatDoc.exists) {
            res.status(404).json({ error: "Chat not found." });
            return;
        }
        const participantIds = Array.isArray((_e = chatDoc.data()) === null || _e === void 0 ? void 0 : _e.participantIds)
            ? chatDoc.data().participantIds
            : [];
        if (!participantIds.includes(uid)) {
            res.status(403).json({ error: "Forbidden. User is not a participant in this chat." });
            return;
        }
        const callSnapshot = await (0, database_1.getDatabase)().ref(`calls/${roomName}`).get();
        if (!callSnapshot.exists()) {
            res.status(404).json({ error: "Call session not found or expired." });
            return;
        }
        const callData = callSnapshot.val();
        if (callData.chatId !== chatId) {
            res.status(403).json({ error: "Forbidden. Call does not belong to this chat." });
            return;
        }
        if (callData.status !== "ringing" && callData.status !== "connected") {
            res.status(409).json({ error: "Call is not active." });
            return;
        }
        if (callData.allowedUserIds && callData.allowedUserIds[uid] !== true) {
            res.status(403).json({ error: "Forbidden. User is not allowed to join this call." });
            return;
        }
        const livekitUrl = getSecretOrEnv(livekitUrlSecret, "LIVEKIT_URL");
        const livekitApiKey = getSecretOrEnv(livekitApiKeySecret, "LIVEKIT_API_KEY");
        const livekitApiSecret = getSecretOrEnv(livekitApiSecretSecret, "LIVEKIT_API_SECRET");
        if (!livekitUrl || !livekitApiKey || !livekitApiSecret) {
            logger.error("LiveKit function misconfigured: missing runtime secrets.");
            res.status(500).json({ error: "Server misconfiguration." });
            return;
        }
        const accessToken = new livekit_server_sdk_1.AccessToken(livekitApiKey, livekitApiSecret, {
            identity: uid,
            name: participantName,
        });
        accessToken.addGrant({
            roomJoin: true,
            room: roomName,
            canPublish: true,
            canSubscribe: true,
        });
        const token = await accessToken.toJwt();
        logger.info("livekit: token issued", {
            uid,
            roomName,
            chatId,
            url: livekitUrl,
            tokenPreview: token.slice(0, 16) + "...",
        });
        res.status(200).json({ token, url: livekitUrl });
    }
    catch (error) {
        logger.error("Error generating LiveKit token", toSafeError(error));
        res.status(500).json({ error: "Internal server error" });
    }
});
//# sourceMappingURL=index.js.map