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
exports.mapCategoryToChannel = exports.processPendingNotificationReceipts = exports.sendPushToUsers = exports.unregisterNotificationDeviceRecord = exports.syncNotificationDeviceRecord = void 0;
const firestore_1 = require("firebase-admin/firestore");
const logger = __importStar(require("firebase-functions/logger"));
const USER_COLLECTION = "users";
const DEVICE_COLLECTION = "notificationDevices";
const DELIVERY_COLLECTION = "notificationDeliveries";
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const EXPO_MAX_BATCH_SIZE = 100;
const EXPO_MAX_RECEIPT_IDS = 300;
const MAX_RECEIPT_ATTEMPTS = 6;
const isExpoPushToken = (value) => {
    return /^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/.test(value);
};
const normalizeString = (value) => {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : null;
};
const chunkArray = (input, size) => {
    if (input.length === 0)
        return [];
    const result = [];
    for (let index = 0; index < input.length; index += size) {
        result.push(input.slice(index, index + size));
    }
    return result;
};
const maskPushToken = (token) => {
    if (!token)
        return null;
    if (token.length <= 16)
        return token;
    return `${token.slice(0, 8)}…${token.slice(-6)}`;
};
const isPermissionCapable = (state) => {
    return state === "granted" || state === "provisional" || state === "ephemeral";
};
const toStringRecord = (data) => {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
        if (typeof value === "string" && value.length > 0) {
            result[key] = value;
        }
    }
    return result;
};
const toRegistrationStatus = (permissionState, expoPushToken, lastRegistrationError) => {
    if (permissionState === "denied") {
        return "permission_blocked";
    }
    if (lastRegistrationError) {
        return "error";
    }
    if (expoPushToken) {
        return "active";
    }
    return "token_missing";
};
const summarizeBody = (body) => {
    const compact = body.replace(/\s+/g, " ").trim();
    return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
};
const getDeviceDocRef = (userId, deviceId) => (0, firestore_1.getFirestore)().collection(USER_COLLECTION).doc(userId).collection(DEVICE_COLLECTION).doc(deviceId);
const listUserDeviceRecords = async (db, userId) => {
    const snapshot = await db
        .collection(USER_COLLECTION)
        .doc(userId)
        .collection(DEVICE_COLLECTION)
        .get();
    return snapshot.docs.map((docSnap) => {
        const data = docSnap.data();
        return normalizeDeviceRecord(userId, docSnap.id, docSnap.ref.path, data);
    });
};
const normalizeDeviceRecord = (userId, deviceId, path, data) => ({
    userId,
    deviceId,
    path,
    platform: data.platform === "android" ? "android" : "ios",
    expoPushToken: normalizeString(data.expoPushToken),
    permissionState: data.permissionState === "granted" ||
        data.permissionState === "provisional" ||
        data.permissionState === "ephemeral" ||
        data.permissionState === "denied"
        ? data.permissionState
        : "undetermined",
    registrationStatus: data.registrationStatus === "active" ||
        data.registrationStatus === "permission_blocked" ||
        data.registrationStatus === "token_missing" ||
        data.registrationStatus === "invalid_token" ||
        data.registrationStatus === "signed_out"
        ? data.registrationStatus
        : "error",
    projectId: normalizeString(data.projectId),
    lastRegistrationError: normalizeString(data.lastRegistrationError),
    isLegacy: false,
});
const buildLegacyDevice = (userId, token) => ({
    userId,
    deviceId: `legacy-${userId}`,
    path: `${USER_COLLECTION}/${userId}`,
    platform: "ios",
    expoPushToken: token,
    permissionState: "granted",
    registrationStatus: "active",
    projectId: null,
    lastRegistrationError: null,
    isLegacy: true,
});
const sendExpoPush = async (messages) => {
    var _a;
    const results = [];
    for (const batch of chunkArray(messages, EXPO_MAX_BATCH_SIZE)) {
        try {
            const response = await fetch(EXPO_PUSH_URL, {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(batch),
            });
            if (!response.ok) {
                const message = `Expo push API returned HTTP ${response.status}`;
                logger.error(message, {
                    statusText: response.statusText,
                    batchSize: batch.length,
                });
                results.push(...batch.map((item) => ({
                    message: item,
                    ticket: {
                        status: "error",
                        message,
                        details: { status: response.status, statusText: response.statusText },
                    },
                })));
                continue;
            }
            const payload = await response.json();
            const tickets = Array.isArray(payload.data) ? payload.data : [];
            for (let index = 0; index < batch.length; index += 1) {
                results.push({
                    message: batch[index],
                    ticket: (_a = tickets[index]) !== null && _a !== void 0 ? _a : {
                        status: "error",
                        message: "Expo push API returned an incomplete ticket response.",
                    },
                });
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown Expo push send error";
            logger.error("Failed to call Expo push API", {
                message,
                batchSize: batch.length,
            });
            results.push(...batch.map((item) => ({
                message: item,
                ticket: {
                    status: "error",
                    message,
                },
            })));
        }
    }
    return results;
};
const fetchExpoReceipts = async (receiptIds) => {
    var _a;
    const receipts = {};
    for (const batch of chunkArray(receiptIds, EXPO_MAX_RECEIPT_IDS)) {
        try {
            const response = await fetch(EXPO_RECEIPTS_URL, {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ ids: batch }),
            });
            if (!response.ok) {
                logger.error("Expo receipt API returned error status", {
                    status: response.status,
                    statusText: response.statusText,
                    receiptCount: batch.length,
                });
                continue;
            }
            const payload = await response.json();
            Object.assign(receipts, (_a = payload.data) !== null && _a !== void 0 ? _a : {});
        }
        catch (error) {
            logger.error("Failed to call Expo receipt API", {
                message: error instanceof Error ? error.message : "Unknown error",
                receiptCount: batch.length,
            });
        }
    }
    return receipts;
};
const updateDeviceStatus = async (device, updates) => {
    if (device.isLegacy) {
        return;
    }
    await (0, firestore_1.getFirestore)().doc(device.path).set(Object.assign(Object.assign({}, updates), { updatedAt: firestore_1.FieldValue.serverTimestamp() }), { merge: true });
};
const invalidateDeviceToken = async (device, reason) => {
    if (device.isLegacy) {
        await (0, firestore_1.getFirestore)().collection(USER_COLLECTION).doc(device.userId).set({
            pushToken: firestore_1.FieldValue.delete(),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
        return;
    }
    await (0, firestore_1.getFirestore)().doc(device.path).set({
        expoPushToken: null,
        registrationStatus: "invalid_token",
        invalidatedAt: firestore_1.FieldValue.serverTimestamp(),
        invalidationReason: reason,
        lastReceiptStatus: "error",
        lastReceiptError: reason,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
};
const resolveNotificationTargets = async (userIds, category, chatId) => {
    var _a, _b, _c;
    if (userIds.length === 0) {
        return { users: [], devices: [], dropped: [] };
    }
    const db = (0, firestore_1.getFirestore)();
    const users = [];
    const dropped = [];
    const devicesByUserId = new Map();
    for (const chunk of chunkArray(userIds, 100)) {
        const refs = chunk.map((userId) => db.collection(USER_COLLECTION).doc(userId));
        const docs = await db.getAll(...refs);
        for (let index = 0; index < docs.length; index += 1) {
            const requestedUserId = chunk[index];
            const userDoc = docs[index];
            if (!userDoc.exists) {
                dropped.push({ userId: requestedUserId, reason: "user_missing" });
                continue;
            }
            const data = (_a = userDoc.data()) !== null && _a !== void 0 ? _a : {};
            const preferences = ((_b = data.preferences) !== null && _b !== void 0 ? _b : {});
            const mutedChatIdsRaw = preferences.muteChatIds;
            const mutedChatIds = Array.isArray(mutedChatIdsRaw)
                ? mutedChatIdsRaw.filter((value) => typeof value === "string")
                : [];
            users.push({
                userId: requestedUserId,
                pushEnabled: preferences.pushEnabled === true,
                categoryEnabled: preferences[category] !== false,
                isMuted: chatId ? mutedChatIds.includes(chatId) : false,
                legacyPushToken: (() => {
                    const legacyToken = normalizeString(data.pushToken);
                    return legacyToken && isExpoPushToken(legacyToken) ? legacyToken : null;
                })(),
            });
        }
    }
    for (const chunk of chunkArray(userIds, 20)) {
        const deviceLists = await Promise.all(chunk.map(async (userId) => ({
            userId,
            devices: await listUserDeviceRecords(db, userId),
        })));
        deviceLists.forEach(({ userId, devices }) => {
            var _a;
            if (devices.length === 0) {
                return;
            }
            const existing = (_a = devicesByUserId.get(userId)) !== null && _a !== void 0 ? _a : [];
            existing.push(...devices);
            devicesByUserId.set(userId, existing);
        });
    }
    const devices = [];
    for (const user of users) {
        if (!user.pushEnabled) {
            dropped.push({ userId: user.userId, reason: "push_disabled" });
            continue;
        }
        if (!user.categoryEnabled) {
            dropped.push({ userId: user.userId, reason: "category_disabled", detail: category });
            continue;
        }
        if (user.isMuted) {
            dropped.push({ userId: user.userId, reason: "muted" });
            continue;
        }
        const candidateDevices = ((_c = devicesByUserId.get(user.userId)) !== null && _c !== void 0 ? _c : []).filter((device) => device.registrationStatus === "active" &&
            Boolean(device.expoPushToken) &&
            isPermissionCapable(device.permissionState) &&
            isExpoPushToken(device.expoPushToken));
        if (candidateDevices.length > 0) {
            devices.push(...candidateDevices);
            continue;
        }
        if (user.legacyPushToken) {
            devices.push(buildLegacyDevice(user.userId, user.legacyPushToken));
            continue;
        }
        dropped.push({ userId: user.userId, reason: "no_registered_device" });
    }
    return { users, devices, dropped };
};
const syncNotificationDeviceRecord = async (userId, input) => {
    var _a, _b, _c;
    const deviceId = normalizeString(input.deviceId);
    if (!deviceId) {
        throw new Error("deviceId is required");
    }
    const expoPushToken = normalizeString(input.expoPushToken);
    const safeToken = expoPushToken && isExpoPushToken(expoPushToken) ? expoPushToken : null;
    const lastRegistrationError = normalizeString(input.lastRegistrationError);
    const permissionState = input.permissionState;
    const nextStatus = safeToken
        ? "active"
        : toRegistrationStatus(permissionState, null, lastRegistrationError);
    const docRef = getDeviceDocRef(userId, deviceId);
    const existingSnap = await docRef.get();
    const existing = existingSnap.exists ? (_a = existingSnap.data()) !== null && _a !== void 0 ? _a : {} : {};
    const previousToken = normalizeString(existing.expoPushToken);
    const payload = {
        userId,
        deviceId,
        platform: input.platform,
        permissionState,
        registrationStatus: nextStatus,
        expoPushToken: safeToken,
        projectId: normalizeString(input.projectId),
        appVersion: normalizeString(input.appVersion),
        deviceName: normalizeString(input.deviceName),
        modelName: normalizeString(input.modelName),
        isPhysicalDevice: input.isPhysicalDevice === true,
        lastRegistrationError,
        lastRegisteredAt: firestore_1.FieldValue.serverTimestamp(),
        lastSeenAt: firestore_1.FieldValue.serverTimestamp(),
        invalidatedAt: nextStatus === "active" ? null : (_b = existing.invalidatedAt) !== null && _b !== void 0 ? _b : null,
        invalidationReason: nextStatus === "active" ? null : (_c = existing.invalidationReason) !== null && _c !== void 0 ? _c : null,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    };
    if (!existingSnap.exists) {
        payload.createdAt = firestore_1.FieldValue.serverTimestamp();
    }
    if (safeToken && previousToken !== safeToken) {
        payload.lastTokenRefreshAt = firestore_1.FieldValue.serverTimestamp();
        payload.lastReceiptStatus = null;
        payload.lastReceiptError = null;
        payload.invalidatedAt = null;
        payload.invalidationReason = null;
    }
    await docRef.set(payload, { merge: true });
    return {
        deviceId,
        registrationStatus: nextStatus,
    };
};
exports.syncNotificationDeviceRecord = syncNotificationDeviceRecord;
const unregisterNotificationDeviceRecord = async (userId, deviceId) => {
    const normalizedDeviceId = normalizeString(deviceId);
    if (!normalizedDeviceId) {
        throw new Error("deviceId is required");
    }
    await getDeviceDocRef(userId, normalizedDeviceId).set({
        userId,
        deviceId: normalizedDeviceId,
        expoPushToken: null,
        registrationStatus: "signed_out",
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
        signedOutAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
};
exports.unregisterNotificationDeviceRecord = unregisterNotificationDeviceRecord;
const sendPushToUsers = async (userIds, title, body, data, category, chatId, channelId) => {
    var _a, _b, _c, _d;
    const db = (0, firestore_1.getFirestore)();
    const deliveryRef = db.collection(DELIVERY_COLLECTION).doc();
    const deliveryId = deliveryRef.id;
    const resolved = await resolveNotificationTargets(userIds, category, chatId);
    const targetDevices = resolved.devices.filter((device) => Boolean(device.expoPushToken) && isExpoPushToken(device.expoPushToken));
    const baseRecord = {
        deliveryId,
        category,
        title,
        bodyPreview: summarizeBody(body),
        data: toStringRecord(Object.assign(Object.assign({}, data), { deliveryId })),
        requestedUserIds: userIds,
        requestedUserCount: userIds.length,
        targetedDeviceCount: targetDevices.length,
        droppedTargets: resolved.dropped,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    };
    if (targetDevices.length === 0) {
        await deliveryRef.set(Object.assign(Object.assign({}, baseRecord), { createdAt: firestore_1.FieldValue.serverTimestamp(), status: "no_targets", acceptedCount: 0, pendingReceipts: [], expoTickets: [] }));
        return {
            deliveryId,
            acceptedCount: 0,
            requestedUserCount: userIds.length,
            targetedDeviceCount: 0,
            droppedCount: resolved.dropped.length,
            pendingReceiptCount: 0,
            status: "no_targets",
        };
    }
    const dispatchTargets = [...targetDevices];
    const messages = dispatchTargets.map((device) => {
        return {
            to: device.expoPushToken,
            title,
            body,
            data: toStringRecord(Object.assign(Object.assign({}, data), { deliveryId })),
            sound: "default",
            priority: "high",
            channelId: channelId !== null && channelId !== void 0 ? channelId : (0, exports.mapCategoryToChannel)(category),
        };
    });
    await deliveryRef.set(Object.assign(Object.assign({}, baseRecord), { createdAt: firestore_1.FieldValue.serverTimestamp(), status: "sending", targetDevices: targetDevices.map((device) => ({
            userId: device.userId,
            deviceId: device.deviceId,
            platform: device.platform,
            tokenPreview: maskPushToken(device.expoPushToken),
            isLegacy: device.isLegacy,
            registrationStatus: device.registrationStatus,
        })) }));
    logger.info("Sending push notifications", {
        deliveryId,
        category,
        requestedUserCount: userIds.length,
        targetedDeviceCount: messages.length,
    });
    const ticketResults = await sendExpoPush(messages);
    const expoTickets = [];
    const pendingReceipts = [];
    let acceptedCount = 0;
    for (let index = 0; index < ticketResults.length; index += 1) {
        const result = ticketResults[index];
        const device = dispatchTargets[index];
        if (!device) {
            continue;
        }
        if (result.ticket.status === "ok" && result.ticket.id) {
            acceptedCount += 1;
            pendingReceipts.push({
                receiptId: result.ticket.id,
                userId: device.userId,
                deviceId: device.deviceId,
                devicePath: device.isLegacy ? undefined : device.path,
                isLegacy: device.isLegacy,
            });
            expoTickets.push({
                userId: device.userId,
                deviceId: device.deviceId,
                status: "ok",
                ticketId: result.ticket.id,
                tokenPreview: maskPushToken(device.expoPushToken),
            });
            await updateDeviceStatus(device, {
                lastDeliveryId: deliveryId,
                lastDeliveryAt: firestore_1.FieldValue.serverTimestamp(),
                lastReceiptStatus: "pending",
                lastReceiptError: null,
            });
            continue;
        }
        const ticketError = (_c = (_b = normalizeString((_a = result.ticket.details) === null || _a === void 0 ? void 0 : _a.error)) !== null && _b !== void 0 ? _b : normalizeString(result.ticket.message)) !== null && _c !== void 0 ? _c : "Unknown ticket error";
        expoTickets.push({
            userId: device.userId,
            deviceId: device.deviceId,
            status: "error",
            error: ticketError,
            details: (_d = result.ticket.details) !== null && _d !== void 0 ? _d : null,
            tokenPreview: maskPushToken(device.expoPushToken),
        });
        await updateDeviceStatus(device, {
            lastDeliveryId: deliveryId,
            lastDeliveryAt: firestore_1.FieldValue.serverTimestamp(),
            lastReceiptStatus: "error",
            lastReceiptError: ticketError,
        });
        if (ticketError === "DeviceNotRegistered") {
            await invalidateDeviceToken(device, ticketError);
        }
    }
    const finalStatus = pendingReceipts.length > 0
        ? "pending_receipts"
        : acceptedCount === targetDevices.length
            ? "completed"
            : "completed_with_errors";
    await deliveryRef.set(Object.assign(Object.assign({}, baseRecord), { status: finalStatus, acceptedCount,
        pendingReceipts, pendingReceiptCount: pendingReceipts.length, receiptAttempts: 0, expoTickets }), { merge: true });
    return {
        deliveryId,
        acceptedCount,
        requestedUserCount: userIds.length,
        targetedDeviceCount: targetDevices.length,
        droppedCount: resolved.dropped.length,
        pendingReceiptCount: pendingReceipts.length,
        status: finalStatus,
    };
};
exports.sendPushToUsers = sendPushToUsers;
const processPendingNotificationReceipts = async () => {
    var _a, _b, _c, _d;
    const db = (0, firestore_1.getFirestore)();
    const deliveriesSnapshot = await db.collection(DELIVERY_COLLECTION)
        .where("status", "==", "pending_receipts")
        .limit(20)
        .get();
    let processed = 0;
    let completed = 0;
    for (const deliveryDoc of deliveriesSnapshot.docs) {
        const payload = deliveryDoc.data();
        const pendingReceipts = Array.isArray(payload.pendingReceipts)
            ? payload.pendingReceipts.filter((value) => {
                return Boolean(value &&
                    typeof value === "object" &&
                    typeof value.receiptId === "string" &&
                    typeof value.userId === "string" &&
                    typeof value.deviceId === "string");
            })
            : [];
        if (pendingReceipts.length === 0) {
            await deliveryDoc.ref.set({
                status: "completed",
                pendingReceiptCount: 0,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            }, { merge: true });
            completed += 1;
            continue;
        }
        const receiptMap = await fetchExpoReceipts(pendingReceipts.map((item) => item.receiptId));
        const receiptAttemptsRaw = typeof payload.receiptAttempts === "number" ? payload.receiptAttempts : 0;
        const nextAttempt = receiptAttemptsRaw + 1;
        const remaining = [];
        let okCount = 0;
        let errorCount = 0;
        for (const pending of pendingReceipts) {
            const receipt = receiptMap[pending.receiptId];
            if (!receipt) {
                if (nextAttempt < MAX_RECEIPT_ATTEMPTS) {
                    remaining.push(pending);
                }
                continue;
            }
            processed += 1;
            const device = {
                userId: pending.userId,
                deviceId: pending.deviceId,
                path: (_a = pending.devicePath) !== null && _a !== void 0 ? _a : `${USER_COLLECTION}/${pending.userId}`,
                platform: "ios",
                expoPushToken: null,
                permissionState: "granted",
                registrationStatus: "active",
                projectId: null,
                lastRegistrationError: null,
                isLegacy: pending.isLegacy === true,
            };
            if (receipt.status === "ok") {
                okCount += 1;
                await updateDeviceStatus(device, {
                    lastReceiptStatus: "ok",
                    lastReceiptError: null,
                    lastReceiptAt: firestore_1.FieldValue.serverTimestamp(),
                });
                continue;
            }
            errorCount += 1;
            const receiptError = (_d = (_c = normalizeString((_b = receipt.details) === null || _b === void 0 ? void 0 : _b.error)) !== null && _c !== void 0 ? _c : normalizeString(receipt.message)) !== null && _d !== void 0 ? _d : "Unknown receipt error";
            await updateDeviceStatus(device, {
                lastReceiptStatus: "error",
                lastReceiptError: receiptError,
                lastReceiptAt: firestore_1.FieldValue.serverTimestamp(),
            });
            if (receiptError === "DeviceNotRegistered") {
                await invalidateDeviceToken(device, receiptError);
            }
        }
        const finalStatus = remaining.length > 0
            ? "pending_receipts"
            : errorCount > 0
                ? "completed_with_errors"
                : "completed";
        await deliveryDoc.ref.set({
            receiptAttempts: nextAttempt,
            lastReceiptCheckAt: firestore_1.FieldValue.serverTimestamp(),
            pendingReceipts: remaining,
            pendingReceiptCount: remaining.length,
            receiptSummary: {
                okCount,
                errorCount,
                remainingCount: remaining.length,
            },
            status: finalStatus,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        }, { merge: true });
        if (remaining.length === 0) {
            completed += 1;
        }
    }
    return { processed, completed };
};
exports.processPendingNotificationReceipts = processPendingNotificationReceipts;
const mapCategoryToChannel = (category) => {
    switch (category) {
        case "messages":
            return "messages";
        case "expenses":
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
exports.mapCategoryToChannel = mapCategoryToChannel;
//# sourceMappingURL=notifications.js.map