import {
    FieldValue,
    getFirestore,
} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

export type NotificationCategory =
    | "messages"
    | "expenses"
    | "settlements"
    | "groupUpdates"
    | "calls"
    | "general";

export type NotificationPermissionState =
    | "granted"
    | "provisional"
    | "ephemeral"
    | "denied"
    | "undetermined";

export type NotificationRegistrationStatus =
    | "active"
    | "permission_blocked"
    | "token_missing"
    | "invalid_token"
    | "signed_out"
    | "error";

interface ExpoPushMessage {
    to: string;
    title: string;
    body: string;
    data?: Record<string, string>;
    sound?: "default" | null;
    badge?: number;
    channelId?: string;
    priority?: "default" | "normal" | "high";
    categoryId?: string;
}

interface ExpoPushTicket {
    status: "ok" | "error";
    id?: string;
    message?: string;
    details?: Record<string, unknown>;
}

interface ExpoReceipt {
    status: "ok" | "error";
    message?: string;
    details?: Record<string, unknown>;
}

interface NotificationUserState {
    userId: string;
    pushEnabled: boolean;
    categoryEnabled: boolean;
    isMuted: boolean;
    legacyPushToken: string | null;
}

interface NotificationDeviceState {
    userId: string;
    deviceId: string;
    path: string;
    platform: "ios" | "android";
    expoPushToken: string | null;
    permissionState: NotificationPermissionState;
    registrationStatus: NotificationRegistrationStatus;
    projectId: string | null;
    lastRegistrationError: string | null;
    isLegacy: boolean;
}

interface DroppedTarget {
    userId: string;
    reason: string;
    detail?: string;
}

interface ResolvedNotificationTargets {
    users: NotificationUserState[];
    devices: NotificationDeviceState[];
    dropped: DroppedTarget[];
}

interface PendingReceiptRecord {
    receiptId: string;
    userId: string;
    deviceId: string;
    devicePath?: string;
    isLegacy?: boolean;
}

interface NotificationDispatchResult {
    deliveryId: string;
    acceptedCount: number;
    requestedUserCount: number;
    targetedDeviceCount: number;
    droppedCount: number;
    pendingReceiptCount: number;
    status:
    | "no_targets"
    | "pending_receipts"
    | "completed"
    | "completed_with_errors";
}

interface SyncNotificationDeviceInput {
    deviceId: string;
    platform: "ios" | "android";
    expoPushToken: string | null;
    permissionState: NotificationPermissionState;
    projectId: string | null;
    appVersion: string | null;
    deviceName: string | null;
    modelName: string | null;
    isPhysicalDevice: boolean;
    lastRegistrationError: string | null;
}

const USER_COLLECTION = "users";
const DEVICE_COLLECTION = "notificationDevices";
const DELIVERY_COLLECTION = "notificationDeliveries";
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const EXPO_MAX_BATCH_SIZE = 100;
const EXPO_MAX_RECEIPT_IDS = 300;
const MAX_RECEIPT_ATTEMPTS = 6;

const isExpoPushToken = (value: string): boolean => {
    return /^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/.test(value);
};

const normalizeString = (value: unknown): string | null => {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : null;
};

const chunkArray = <T>(input: T[], size: number): T[][] => {
    if (input.length === 0) return [];
    const result: T[][] = [];
    for (let index = 0; index < input.length; index += size) {
        result.push(input.slice(index, index + size));
    }
    return result;
};

const maskPushToken = (token: string | null): string | null => {
    if (!token) return null;
    if (token.length <= 16) return token;
    return `${token.slice(0, 8)}…${token.slice(-6)}`;
};

const isPermissionCapable = (state: NotificationPermissionState): boolean => {
    return state === "granted" || state === "provisional" || state === "ephemeral";
};

const toStringRecord = (data: Record<string, string>): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
        if (typeof value === "string" && value.length > 0) {
            result[key] = value;
        }
    }
    return result;
};

const toRegistrationStatus = (
    permissionState: NotificationPermissionState,
    expoPushToken: string | null,
    lastRegistrationError: string | null,
): NotificationRegistrationStatus => {
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

const summarizeBody = (body: string): string => {
    const compact = body.replace(/\s+/g, " ").trim();
    return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
};

const getDeviceDocRef = (userId: string, deviceId: string) =>
    getFirestore().collection(USER_COLLECTION).doc(userId).collection(DEVICE_COLLECTION).doc(deviceId);

const normalizeDeviceRecord = (
    userId: string,
    deviceId: string,
    path: string,
    data: Record<string, unknown>,
): NotificationDeviceState => ({
    userId,
    deviceId,
    path,
    platform: data.platform === "android" ? "android" : "ios",
    expoPushToken: normalizeString(data.expoPushToken),
    permissionState:
        data.permissionState === "granted" ||
        data.permissionState === "provisional" ||
        data.permissionState === "ephemeral" ||
        data.permissionState === "denied"
            ? data.permissionState
            : "undetermined",
    registrationStatus:
        data.registrationStatus === "active" ||
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

const buildLegacyDevice = (userId: string, token: string): NotificationDeviceState => ({
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

const sendExpoPush = async (
    messages: ExpoPushMessage[],
): Promise<Array<{ message: ExpoPushMessage; ticket: ExpoPushTicket }>> => {
    const results: Array<{ message: ExpoPushMessage; ticket: ExpoPushTicket }> = [];

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
                results.push(
                    ...batch.map((item) => ({
                        message: item,
                        ticket: {
                            status: "error" as const,
                            message,
                            details: { status: response.status, statusText: response.statusText },
                        },
                    })),
                );
                continue;
            }

            const payload = await response.json() as { data?: ExpoPushTicket[] };
            const tickets = Array.isArray(payload.data) ? payload.data : [];

            for (let index = 0; index < batch.length; index += 1) {
                results.push({
                    message: batch[index],
                    ticket: tickets[index] ?? {
                        status: "error",
                        message: "Expo push API returned an incomplete ticket response.",
                    },
                });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown Expo push send error";
            logger.error("Failed to call Expo push API", {
                message,
                batchSize: batch.length,
            });
            results.push(
                ...batch.map((item) => ({
                    message: item,
                    ticket: {
                        status: "error" as const,
                        message,
                    },
                })),
            );
        }
    }

    return results;
};

const fetchExpoReceipts = async (
    receiptIds: string[],
): Promise<Record<string, ExpoReceipt>> => {
    const receipts: Record<string, ExpoReceipt> = {};

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

            const payload = await response.json() as { data?: Record<string, ExpoReceipt> };
            Object.assign(receipts, payload.data ?? {});
        } catch (error) {
            logger.error("Failed to call Expo receipt API", {
                message: error instanceof Error ? error.message : "Unknown error",
                receiptCount: batch.length,
            });
        }
    }

    return receipts;
};

const updateDeviceStatus = async (
    device: NotificationDeviceState,
    updates: Record<string, unknown>,
): Promise<void> => {
    if (device.isLegacy) {
        return;
    }

    await getFirestore().doc(device.path).set({
        ...updates,
        updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
};

const invalidateDeviceToken = async (
    device: NotificationDeviceState,
    reason: string,
): Promise<void> => {
    if (device.isLegacy) {
        await getFirestore().collection(USER_COLLECTION).doc(device.userId).set({
            pushToken: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return;
    }

    await getFirestore().doc(device.path).set({
        expoPushToken: null,
        registrationStatus: "invalid_token",
        invalidatedAt: FieldValue.serverTimestamp(),
        invalidationReason: reason,
        lastReceiptStatus: "error",
        lastReceiptError: reason,
        updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
};

const resolveNotificationTargets = async (
    userIds: string[],
    category: NotificationCategory,
    chatId?: string,
): Promise<ResolvedNotificationTargets> => {
    if (userIds.length === 0) {
        return { users: [], devices: [], dropped: [] };
    }

    const db = getFirestore();
    const users: NotificationUserState[] = [];
    const dropped: DroppedTarget[] = [];
    const devicesByUserId = new Map<string, NotificationDeviceState[]>();

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

            const data = userDoc.data() ?? {};
            const preferences = (data.preferences ?? {}) as Record<string, unknown>;
            const mutedChatIdsRaw = preferences.muteChatIds;
            const mutedChatIds = Array.isArray(mutedChatIdsRaw)
                ? mutedChatIdsRaw.filter((value): value is string => typeof value === "string")
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

    for (const chunk of chunkArray(userIds, 30)) {
        const deviceQuery = db.collectionGroup(DEVICE_COLLECTION)
            .where("userId", "in", chunk);
        const deviceSnapshot = await deviceQuery.get();

        deviceSnapshot.docs.forEach((docSnap) => {
            const data = docSnap.data() as Record<string, unknown>;
            const userId = normalizeString(data.userId);
            if (!userId) {
                return;
            }

            const normalized = normalizeDeviceRecord(
                userId,
                docSnap.id,
                docSnap.ref.path,
                data,
            );

            const devices = devicesByUserId.get(userId) ?? [];
            devices.push(normalized);
            devicesByUserId.set(userId, devices);
        });
    }

    const devices: NotificationDeviceState[] = [];

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

        const candidateDevices = (devicesByUserId.get(user.userId) ?? []).filter((device) =>
            device.registrationStatus === "active" &&
            Boolean(device.expoPushToken) &&
            isPermissionCapable(device.permissionState) &&
            isExpoPushToken(device.expoPushToken!),
        );

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

export const syncNotificationDeviceRecord = async (
    userId: string,
    input: SyncNotificationDeviceInput,
): Promise<{ deviceId: string; registrationStatus: NotificationRegistrationStatus }> => {
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
    const existing = existingSnap.exists ? existingSnap.data() ?? {} : {};
    const previousToken = normalizeString(existing.expoPushToken);

    const payload: Record<string, unknown> = {
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
        lastRegisteredAt: FieldValue.serverTimestamp(),
        lastSeenAt: FieldValue.serverTimestamp(),
        invalidatedAt: nextStatus === "active" ? null : existing.invalidatedAt ?? null,
        invalidationReason: nextStatus === "active" ? null : existing.invalidationReason ?? null,
        updatedAt: FieldValue.serverTimestamp(),
    };

    if (!existingSnap.exists) {
        payload.createdAt = FieldValue.serverTimestamp();
    }

    if (safeToken && previousToken !== safeToken) {
        payload.lastTokenRefreshAt = FieldValue.serverTimestamp();
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

export const unregisterNotificationDeviceRecord = async (
    userId: string,
    deviceId: string,
): Promise<void> => {
    const normalizedDeviceId = normalizeString(deviceId);
    if (!normalizedDeviceId) {
        throw new Error("deviceId is required");
    }

    await getDeviceDocRef(userId, normalizedDeviceId).set({
        userId,
        deviceId: normalizedDeviceId,
        expoPushToken: null,
        registrationStatus: "signed_out",
        updatedAt: FieldValue.serverTimestamp(),
        signedOutAt: FieldValue.serverTimestamp(),
    }, { merge: true });
};

export const sendPushToUsers = async (
    userIds: string[],
    title: string,
    body: string,
    data: Record<string, string>,
    category: NotificationCategory,
    chatId?: string,
    channelId?: string,
): Promise<NotificationDispatchResult> => {
    const db = getFirestore();
    const deliveryRef = db.collection(DELIVERY_COLLECTION).doc();
    const deliveryId = deliveryRef.id;
    const resolved = await resolveNotificationTargets(userIds, category, chatId);

    const targetDevices = resolved.devices.filter((device) =>
        Boolean(device.expoPushToken) && isExpoPushToken(device.expoPushToken!),
    );

    const baseRecord = {
        deliveryId,
        category,
        title,
        bodyPreview: summarizeBody(body),
        data: toStringRecord({ ...data, deliveryId }),
        requestedUserIds: userIds,
        requestedUserCount: userIds.length,
        targetedDeviceCount: targetDevices.length,
        droppedTargets: resolved.dropped,
        updatedAt: FieldValue.serverTimestamp(),
    };

    if (targetDevices.length === 0) {
        await deliveryRef.set({
            ...baseRecord,
            createdAt: FieldValue.serverTimestamp(),
            status: "no_targets",
            acceptedCount: 0,
            pendingReceipts: [],
            expoTickets: [],
        });

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

    const messageByToken = new Map<string, NotificationDeviceState>();
    const messages: ExpoPushMessage[] = targetDevices.map((device) => {
        messageByToken.set(device.expoPushToken!, device);
        return {
            to: device.expoPushToken!,
            title,
            body,
            data: toStringRecord({ ...data, deliveryId }),
            sound: "default",
            priority: "high",
            channelId: channelId ?? mapCategoryToChannel(category),
        };
    });

    await deliveryRef.set({
        ...baseRecord,
        createdAt: FieldValue.serverTimestamp(),
        status: "sending",
        targetDevices: targetDevices.map((device) => ({
            userId: device.userId,
            deviceId: device.deviceId,
            platform: device.platform,
            tokenPreview: maskPushToken(device.expoPushToken),
            isLegacy: device.isLegacy,
            registrationStatus: device.registrationStatus,
        })),
    });

    logger.info("Sending push notifications", {
        deliveryId,
        category,
        requestedUserCount: userIds.length,
        targetedDeviceCount: messages.length,
    });

    const ticketResults = await sendExpoPush(messages);
    const expoTickets: Array<Record<string, unknown>> = [];
    const pendingReceipts: PendingReceiptRecord[] = [];
    let acceptedCount = 0;

    for (const result of ticketResults) {
        const device = messageByToken.get(result.message.to);
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
                lastDeliveryAt: FieldValue.serverTimestamp(),
                lastReceiptStatus: "pending",
                lastReceiptError: null,
            });
            continue;
        }

        const ticketError = normalizeString(result.ticket.details?.error) ?? normalizeString(result.ticket.message) ?? "Unknown ticket error";
        expoTickets.push({
            userId: device.userId,
            deviceId: device.deviceId,
            status: "error",
            error: ticketError,
            details: result.ticket.details ?? null,
            tokenPreview: maskPushToken(device.expoPushToken),
        });

        await updateDeviceStatus(device, {
            lastDeliveryId: deliveryId,
            lastDeliveryAt: FieldValue.serverTimestamp(),
            lastReceiptStatus: "error",
            lastReceiptError: ticketError,
        });

        if (ticketError === "DeviceNotRegistered") {
            await invalidateDeviceToken(device, ticketError);
        }
    }

    const finalStatus: NotificationDispatchResult["status"] =
        pendingReceipts.length > 0
            ? "pending_receipts"
            : acceptedCount === targetDevices.length
                ? "completed"
                : "completed_with_errors";

    await deliveryRef.set({
        ...baseRecord,
        status: finalStatus,
        acceptedCount,
        pendingReceipts,
        pendingReceiptCount: pendingReceipts.length,
        receiptAttempts: 0,
        expoTickets,
    }, { merge: true });

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

export const processPendingNotificationReceipts = async (): Promise<{ processed: number; completed: number }> => {
    const db = getFirestore();
    const deliveriesSnapshot = await db.collection(DELIVERY_COLLECTION)
        .where("status", "==", "pending_receipts")
        .limit(20)
        .get();

    let processed = 0;
    let completed = 0;

    for (const deliveryDoc of deliveriesSnapshot.docs) {
        const payload = deliveryDoc.data() as Record<string, unknown>;
        const pendingReceipts = Array.isArray(payload.pendingReceipts)
            ? payload.pendingReceipts.filter((value): value is PendingReceiptRecord => {
                return Boolean(
                    value &&
                    typeof value === "object" &&
                    typeof (value as PendingReceiptRecord).receiptId === "string" &&
                    typeof (value as PendingReceiptRecord).userId === "string" &&
                    typeof (value as PendingReceiptRecord).deviceId === "string",
                );
            })
            : [];

        if (pendingReceipts.length === 0) {
            await deliveryDoc.ref.set({
                status: "completed",
                pendingReceiptCount: 0,
                updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            completed += 1;
            continue;
        }

        const receiptMap = await fetchExpoReceipts(pendingReceipts.map((item) => item.receiptId));
        const receiptAttemptsRaw = typeof payload.receiptAttempts === "number" ? payload.receiptAttempts : 0;
        const nextAttempt = receiptAttemptsRaw + 1;
        const remaining: PendingReceiptRecord[] = [];
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

            const device: NotificationDeviceState = {
                userId: pending.userId,
                deviceId: pending.deviceId,
                path: pending.devicePath ?? `${USER_COLLECTION}/${pending.userId}`,
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
                    lastReceiptAt: FieldValue.serverTimestamp(),
                });
                continue;
            }

            errorCount += 1;
            const receiptError = normalizeString(receipt.details?.error)
                ?? normalizeString(receipt.message)
                ?? "Unknown receipt error";

            await updateDeviceStatus(device, {
                lastReceiptStatus: "error",
                lastReceiptError: receiptError,
                lastReceiptAt: FieldValue.serverTimestamp(),
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
            lastReceiptCheckAt: FieldValue.serverTimestamp(),
            pendingReceipts: remaining,
            pendingReceiptCount: remaining.length,
            receiptSummary: {
                okCount,
                errorCount,
                remainingCount: remaining.length,
            },
            status: finalStatus,
            updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });

        if (remaining.length === 0) {
            completed += 1;
        }
    }

    return { processed, completed };
};

export const mapCategoryToChannel = (category: NotificationCategory): string => {
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
