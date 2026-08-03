import {
    FieldValue,
    getFirestore,
} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { buildRevokeData, type RevokeFilter } from "./revoke";

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
    // Optional so silent/background pushes (revoke) can omit any visible
    // content — a message with no title/body is delivered as data-only on
    // Android and, with _contentAvailable, as a background push on iOS.
    title?: string;
    subtitle?: string;
    body?: string;
    data?: Record<string, string>;
    sound?: "default" | null;
    badge?: number;
    channelId?: string;
    priority?: "default" | "normal" | "high";
    categoryId?: string;
    // iOS: sets apns content-available:1 so the system wakes the app's
    // background notification task without presenting anything.
    _contentAvailable?: boolean;
    /**
     * iOS: sets apns `mutable-content:1`, which lets a Notification Service
     * Extension rewrite the body before it is shown (doc 36 §3.2).
     *
     * Required for the encrypted-preview flow: the visible copy ships generic
     * and the extension replaces it once it has opened the sealed blob. Without
     * this the extension is never invoked and every notification stays generic.
     */
    mutableContent?: boolean;
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
    /**
     * This recipient has locked THIS chat behind a biometric gate, so the tray
     * copy must stay generic (doc 36 §1.1).
     *
     * Read from the user document this function ALREADY fetches. The caller
     * used to re-read the very same documents one at a time purely to answer
     * this, doubling the per-recipient user reads on every single message —
     * `index.ts` did `users/{uid}.get()` per recipient immediately before
     * calling in here, where `db.getAll` had just batched them.
     */
    chatLocked: boolean;
    legacyPushToken: string | null;
}

interface NotificationDeviceState {
    userId: string;
    deviceId: string;
    path: string;
    platform: "ios" | "android";
    expoPushToken: string | null;
    /**
     * Native APNs/FCM token (doc 36 §6). Surfaced here so coverage can be
     * MEASURED before the sender switches — flipping to direct delivery while
     * a chunk of installs still have none would silently stop their pushes.
     */
    nativePushToken: string | null;
    permissionState: NotificationPermissionState;
    registrationStatus: NotificationRegistrationStatus;
    projectId: string | null;
    deviceName: string | null;
    modelName: string | null;
    lastRegistrationError: string | null;
    isPhysicalDevice: boolean;
    lastSeenAt: number | null;
    lastRegisteredAt: number | null;
    updatedAt: number | null;
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
    /** Native APNs/FCM token (doc 36 §6). Optional — older clients omit it. */
    nativePushToken?: string | null;
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

const toMillis = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "object" && value !== null) {
        const maybeTimestamp = value as { toMillis?: () => number; seconds?: number };
        if (typeof maybeTimestamp.toMillis === "function") {
            return maybeTimestamp.toMillis();
        }
        if (typeof maybeTimestamp.seconds === "number") {
            return maybeTimestamp.seconds * 1000;
        }
    }

    return null;
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

const isPermissionStateCapable = (state: NotificationPermissionState): boolean =>
    state === "granted" || state === "provisional" || state === "ephemeral";

const summarizeBody = (body: string): string => {
    const compact = body.replace(/\s+/g, " ").trim();
    return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
};

const getDeviceDocRef = (userId: string, deviceId: string) =>
    getFirestore().collection(USER_COLLECTION).doc(userId).collection(DEVICE_COLLECTION).doc(deviceId);

const listUserDeviceRecords = async (
    db: FirebaseFirestore.Firestore,
    userId: string,
): Promise<NotificationDeviceState[]> => {
    const snapshot = await db
        .collection(USER_COLLECTION)
        .doc(userId)
        .collection(DEVICE_COLLECTION)
        .get();

    return snapshot.docs.map((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        return normalizeDeviceRecord(
            userId,
            docSnap.id,
            docSnap.ref.path,
            data,
        );
    });
};

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
    nativePushToken: normalizeString(data.nativePushToken),
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
    deviceName: normalizeString(data.deviceName),
    modelName: normalizeString(data.modelName),
    lastRegistrationError: normalizeString(data.lastRegistrationError),
    isPhysicalDevice: data.isPhysicalDevice === true,
    lastSeenAt: toMillis(data.lastSeenAt),
    lastRegisteredAt: toMillis(data.lastRegisteredAt),
    updatedAt: toMillis(data.updatedAt),
    isLegacy: false,
});

const buildLegacyDevice = (userId: string, token: string): NotificationDeviceState => ({
    userId,
    deviceId: `legacy-${userId}`,
    path: `${USER_COLLECTION}/${userId}`,
    platform: "ios",
    expoPushToken: token,
    // Legacy per-user record, pre-dating per-device registration — it can
    // never carry a native token.
    nativePushToken: null,
    permissionState: "granted",
    registrationStatus: "active",
    projectId: null,
    deviceName: null,
    modelName: null,
    lastRegistrationError: null,
    isPhysicalDevice: true,
    lastSeenAt: null,
    lastRegisteredAt: null,
    updatedAt: null,
    isLegacy: true,
});

const getDeviceRecency = (device: NotificationDeviceState): number =>
    device.lastSeenAt ?? device.lastRegisteredAt ?? device.updatedAt ?? 0;

const getPhysicalDeviceKey = (device: NotificationDeviceState): string | null => {
    if (device.isLegacy || !device.isPhysicalDevice) {
        return null;
    }

    const deviceName = normalizeString(device.deviceName)?.toLowerCase();
    const modelName = normalizeString(device.modelName)?.toLowerCase();
    if (!deviceName || !modelName) {
        return null;
    }

    return [
        device.platform,
        normalizeString(device.projectId)?.toLowerCase() ?? "unknown-project",
        deviceName,
        modelName,
    ].join(":");
};

const dedupeDevicesForDelivery = (
    devices: NotificationDeviceState[],
): NotificationDeviceState[] => {
    const sorted = [...devices].sort((left, right) => getDeviceRecency(right) - getDeviceRecency(left));
    const seenTokens = new Set<string>();
    const seenPhysicalKeys = new Set<string>();
    const uniqueDevices: NotificationDeviceState[] = [];

    for (const device of sorted) {
        const token = normalizeString(device.expoPushToken);
        const physicalKey = getPhysicalDeviceKey(device);

        if (token && seenTokens.has(token)) {
            continue;
        }

        if (physicalKey && seenPhysicalKeys.has(physicalKey)) {
            continue;
        }

        uniqueDevices.push(device);

        if (token) {
            seenTokens.add(token);
        }

        if (physicalKey) {
            seenPhysicalKeys.add(physicalKey);
        }
    }

    return uniqueDevices;
};

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
        invalidatedTokenString: device.expoPushToken,
        lastReceiptStatus: "error",
        lastReceiptError: reason,
        updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
};

const retireSupersededDevices = async (
    userId: string,
    currentDeviceId: string,
): Promise<void> => {
    const db = getFirestore();
    const devices = await listUserDeviceRecords(db, userId);
    const currentDevice = devices.find((device) => device.deviceId === currentDeviceId && !device.isLegacy);
    if (!currentDevice || currentDevice.registrationStatus !== "active") {
        return;
    }

    const currentToken = normalizeString(currentDevice.expoPushToken);
    const currentPhysicalKey = getPhysicalDeviceKey(currentDevice);

    if (!currentToken && !currentPhysicalKey) {
        return;
    }

    const supersededDevices = devices.filter((device) => {
        if (device.isLegacy || device.deviceId === currentDeviceId || device.registrationStatus !== "active") {
            return false;
        }

        const sharesToken = Boolean(
            currentToken &&
            normalizeString(device.expoPushToken) === currentToken,
        );
        const sharesPhysicalDevice = Boolean(
            currentPhysicalKey &&
            getPhysicalDeviceKey(device) === currentPhysicalKey,
        );

        return sharesToken || sharesPhysicalDevice;
    });

    if (supersededDevices.length === 0) {
        return;
    }

    await Promise.all(
        supersededDevices.map((device) =>
            getFirestore().doc(device.path).set({
                expoPushToken: null,
                registrationStatus: "token_missing",
                lastRegistrationError: "Superseded by a newer registration for this device.",
                supersededAt: FieldValue.serverTimestamp(),
                supersededByDeviceId: currentDeviceId,
                updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true }),
        ),
    );

    logger.info("Retired superseded notification device registrations", {
        userId,
        currentDeviceId,
        retiredDeviceIds: supersededDevices.map((device) => device.deviceId),
    });
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

            const lockedChats = data.lockedChats as Record<string, unknown> | undefined;
            users.push({
                userId: requestedUserId,
                pushEnabled: preferences.pushEnabled === true,
                categoryEnabled: preferences[category] !== false,
                isMuted: chatId ? mutedChatIds.includes(chatId) : false,
                // Presence of the key is the signal, matching the client's own
                // `lockedChats[chatId] !== undefined` test.
                chatLocked: Boolean(chatId && lockedChats && lockedChats[chatId] !== undefined),
                legacyPushToken: (() => {
                    const legacyToken = normalizeString(data.pushToken);
                    return legacyToken && isExpoPushToken(legacyToken) ? legacyToken : null;
                })(),
            });
        }
    }

    for (const chunk of chunkArray(userIds, 20)) {
        const deviceLists = await Promise.all(
            chunk.map(async (userId) => ({
                userId,
                devices: await listUserDeviceRecords(db, userId),
            })),
        );

        deviceLists.forEach(({ userId, devices }) => {
            if (devices.length === 0) {
                return;
            }

            const existing = devicesByUserId.get(userId) ?? [];
            existing.push(...devices);
            devicesByUserId.set(userId, existing);
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
            devices.push(...dedupeDevicesForDelivery(candidateDevices));
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
    // Native APNs/FCM token (doc 36 §6). STORED ONLY — nothing sends with it
    // yet. Collecting first means that when the sender switches, existing
    // installs already have one on file; a device that has not checked in since
    // will simply keep using the Expo relay until it does.
    const nativePushToken = normalizeString(input.nativePushToken);
    const lastRegistrationError = normalizeString(input.lastRegistrationError);
    const permissionState = input.permissionState;

    const docRef = getDeviceDocRef(userId, deviceId);
    const existingSnap = await docRef.get();
    const existing = existingSnap.exists ? existingSnap.data() ?? {} : {};
    const previousToken = normalizeString(existing.expoPushToken);
    const existingRegistrationStatus =
        existing.registrationStatus === "active" ||
        existing.registrationStatus === "permission_blocked" ||
        existing.registrationStatus === "token_missing" ||
        existing.registrationStatus === "invalid_token" ||
        existing.registrationStatus === "signed_out"
            ? existing.registrationStatus
            : "error";
    const preserveExistingActiveToken = Boolean(
        !safeToken &&
        !lastRegistrationError &&
        existingRegistrationStatus === "active" &&
        isPermissionStateCapable(permissionState) &&
        previousToken &&
        isExpoPushToken(previousToken),
    );

    let nextStatus: NotificationRegistrationStatus = "token_missing";
    if (safeToken) {
        if (existing.registrationStatus === "invalid_token" && existing.invalidatedTokenString === safeToken) {
            nextStatus = "invalid_token";
        } else {
            nextStatus = "active";
        }
    } else if (preserveExistingActiveToken) {
        nextStatus = "active";
    } else {
        nextStatus = toRegistrationStatus(permissionState, null, lastRegistrationError);
    }

    const payload: Record<string, unknown> = {
        userId,
        deviceId,
        platform: input.platform,
        permissionState,
        registrationStatus: nextStatus,
        expoPushToken:
            nextStatus === "invalid_token"
                ? null
                : safeToken ?? (preserveExistingActiveToken ? previousToken : null),
        // Preserved rather than nulled when absent, for the same reason as the
        // Expo token above: a re-registration that fails to produce one must
        // not discard a working token already on file.
        nativePushToken:
            nativePushToken ?? normalizeString(existing.nativePushToken) ?? null,
        projectId: normalizeString(input.projectId),
        appVersion: normalizeString(input.appVersion),
        deviceName: normalizeString(input.deviceName),
        modelName: normalizeString(input.modelName),
        isPhysicalDevice: input.isPhysicalDevice === true,
        lastRegistrationError: preserveExistingActiveToken ? null : lastRegistrationError,
        lastRegisteredAt: FieldValue.serverTimestamp(),
        lastSeenAt: FieldValue.serverTimestamp(),
        invalidatedAt: nextStatus === "active" ? null : existing.invalidatedAt ?? null,
        invalidationReason: nextStatus === "active" ? null : existing.invalidationReason ?? null,
        updatedAt: FieldValue.serverTimestamp(),
    };

    if (!existingSnap.exists) {
        payload.createdAt = FieldValue.serverTimestamp();
    }

    // Doc 31 Phase 2 fix: this used to be gated on `!existingSnap.exists`
    // (the notificationDevices doc), which only ever fires for a device's
    // TRUE first-ever contact with this function. That silently orphaned
    // every device that registered before Phase 0/1 shipped — their
    // notificationDevices doc already existed, so they'd never get a
    // pairedDevices row created at all, and Phase 2's fanOutQueuedMessage
    // trigger (which fans a message out to a recipient's *confirmed*
    // pairedDevices rows) would find zero devices for them and messages
    // would silently stop delivering. Checking pairedDevices existence
    // independently instead means ANY device without one — whether it's
    // truly new, or an existing device syncing for the first time since
    // this feature shipped — gets backfilled as main here. A confirmed
    // companion (paired via redeemPairingCode, which always creates its
    // pairedDevices row transactionally BEFORE this function can ever run
    // for it) always has one already, so this branch correctly never
    // touches it or its `role` field.
    const pairedDeviceRef = getFirestore()
        .collection(USER_COLLECTION)
        .doc(userId)
        .collection("pairedDevices")
        .doc(deviceId);
    try {
        const pairedDeviceSnap = await pairedDeviceRef.get();
        if (!pairedDeviceSnap.exists) {
            // CRITICAL (fixed 2026-07-25): this used to unconditionally write
            // `isMainDevice: true, pairingStatus: "confirmed"` for ANY device
            // lacking a pairedDevices row. That silently defeated the entire
            // main/companion model: a second phone signing in with plain
            // email+password got auto-promoted to a CONFIRMED MAIN device, so
            // it never went through pairing, `PendingPairingGate` never fired
            // (nothing was ever `pending_confirmation`), the QR flow was
            // bypassed, and the 4-device cap — which is only enforced in
            // redeemPairingCode — never applied. Reproduced with two real
            // iPhones on one account, both landing as "main".
            //
            // The backfill intent was only ever about devices that predated
            // Phase 0/1 (see the comment above). Those users have ZERO
            // pairedDevices rows, so gating on "is this the user's first
            // device at all" preserves that migration path exactly while
            // closing the bypass for genuinely additional devices.
            const existingDevices = await getFirestore()
                .collection(USER_COLLECTION)
                .doc(userId)
                .collection("pairedDevices")
                .limit(1)
                .get();
            const isFirstDeviceEver = existingDevices.empty;

            if (isFirstDeviceEver) {
                payload.role = "main";
                await pairedDeviceRef.set({
                    deviceId,
                    platform: input.platform,
                    deviceName: normalizeString(input.deviceName),
                    modelName: normalizeString(input.modelName),
                    isMainDevice: true,
                    pairingStatus: "confirmed",
                    pairedAt: FieldValue.serverTimestamp(),
                    lastSeenAt: FieldValue.serverTimestamp(),
                }, { merge: true });
            } else {
                // An ADDITIONAL device that arrived without pairing. Register
                // it as pending so PendingPairingGate blocks it and an
                // existing device must explicitly approve it. Deliberately
                // still written (rather than left absent) so the new device
                // can show "waiting for confirmation" instead of looking
                // broken, and so it appears in Linked devices for approval.
                //
                // No confirmationCode here: that code is the pairing
                // channel's shared secret (§3.4), meaningful only when both
                // sides derived it from the same pairing session. A
                // self-registered device has no such session, so approval is
                // an explicit human decision on an existing device instead.
                payload.role = "companion";
                await pairedDeviceRef.set({
                    deviceId,
                    platform: input.platform,
                    deviceName: normalizeString(input.deviceName),
                    modelName: normalizeString(input.modelName),
                    isMainDevice: false,
                    pairingStatus: "pending_confirmation",
                    selfRegistered: true,
                    createdAt: FieldValue.serverTimestamp(),
                    lastSeenAt: FieldValue.serverTimestamp(),
                }, { merge: true });
                logger.info("syncNotificationDeviceRecord: additional device registered pending approval", {
                    userId,
                    deviceId,
                });
            }
        }
    } catch (error) {
        // Best-effort — the notificationDevices write below is the
        // primary record; a failure here just means the Linked Devices
        // screen won't show this device (and Phase 2's message fan-out
        // won't reach it) until the next successful sync.
        logger.warn("syncNotificationDeviceRecord: failed to backfill/write main pairedDevices record", {
            userId,
            deviceId,
            error: error instanceof Error ? { name: error.name, message: error.message } : { message: "Unknown error" },
        });
    }

    if (safeToken && previousToken !== safeToken) {
        payload.lastTokenRefreshAt = FieldValue.serverTimestamp();
        payload.lastReceiptStatus = null;
        payload.lastReceiptError = null;
        payload.invalidatedAt = null;
        payload.invalidationReason = null;
    }

    await docRef.set(payload, { merge: true });

    if (nextStatus === "active") {
        await retireSupersededDevices(userId, deviceId);
    }

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

/**
 * Whether this recipient gets the generic, locked-chat copy.
 *
 * Exported and pure because it is a PRIVACY decision, and the interesting case
 * is the one that is easy to get wrong: a recipient whose user document could
 * not be resolved. They are absent from `resolvedUserIds`, and they must be
 * treated as LOCKED — failing open would put a sender name and message preview
 * on the lock screen of a chat its owner deliberately gated.
 *
 * The previous implementation got this right via a try/catch around a
 * per-recipient read; that read is gone (doc 36 §1.1), so the fail-closed
 * property has to be re-established here explicitly rather than inherited from
 * an exception handler.
 */
export const shouldUseLockedCopy = (params: {
    userId: string;
    lockedUserIds: ReadonlySet<string>;
    resolvedUserIds: ReadonlySet<string>;
    hasLockedVariant: boolean;
}): boolean => {
    // With no generic variant to fall back to there is nothing to choose; the
    // caller simply is not using this feature.
    if (!params.hasLockedVariant) return false;
    if (params.lockedUserIds.has(params.userId)) return true;
    // Unresolved -> fail closed.
    return !params.resolvedUserIds.has(params.userId);
};

/**
 * Sends one message push per device, carrying a SEALED preview.
 *
 * The replacement for the Firestore-triggered notification (doc 36 §1). That
 * one read `lastMessage.content` — the message plaintext — and put it in the
 * notification body, so this server, Expo and APNs/FCM could all read every
 * message. This function never sees plaintext: it forwards an opaque blob the
 * recipient device opens locally.
 *
 * The visible title/body are deliberately GENERIC. They are what shows if the
 * device cannot open the preview — an old client, a failed decrypt, an iOS
 * extension that timed out. Putting anything real there would undo the whole
 * exercise, since the fallback is exactly what an attacker or a middleman sees.
 */
export const sendMessagePushes = async (params: {
    recipientId: string;
    chatId: string;
    messageId: string;
    /**
     * Sealed previews by device id, or undefined when the sender produced none.
     *
     * Matched against the notification devices resolved below rather than
     * against a caller-supplied device list. That is what lets BOTH fan-out
     * paths call this — including the one where a recipient has no confirmed
     * paired devices, which is 39% of real fan-outs (doc 34 §1) and which must
     * still receive a notification.
     */
    previews?: Record<string, string>;
}): Promise<{ sent: number }> => {
    if (!params.chatId) {
        return { sent: 0 };
    }

    const resolved = await resolveNotificationTargets(
        [params.recipientId],
        "messages",
        params.chatId,
    );
    if (resolved.devices.length === 0) {
        return { sent: 0 };
    }

    const messages: ExpoPushMessage[] = [];
    for (const device of resolved.devices) {
        if (!device.expoPushToken || !isExpoPushToken(device.expoPushToken)) continue;
        const preview = params.previews?.[device.deviceId] ?? null;

        messages.push({
            to: device.expoPushToken,
            // Generic, always. See the header.
            title: "ManaSplit",
            body: "New message",
            data: toStringRecord({
                type: "message",
                chatId: params.chatId,
                messageId: params.messageId,
                // Absent when the sender could not seal for this device; the
                // client then shows the generic copy above.
                ...(preview ? { preview } : {}),
            }),
            sound: "default",
            priority: "high",
            channelId: mapCategoryToChannel("messages"),
            // Lets an iOS Notification Service Extension rewrite the body once
            // it has opened the preview (doc 36 §3.2).
            mutableContent: true,
        });
    }

    if (messages.length === 0) return { sent: 0 };

    const ticketResults = await sendExpoPush(messages);
    const sent = ticketResults.filter((entry) => entry.ticket.status === "ok").length;
    logger.info("sendMessagePushes: dispatched", {
        chatId: params.chatId,
        deviceCount: messages.length,
        sent,
        // Diagnostic only — how many devices got a real preview vs generic
        // copy. A persistent zero here means sealing is failing on the sender.
        withPreview: messages.filter((m) => Boolean((m.data as Record<string, unknown>)?.preview)).length,
    });
    return { sent };
};

export const sendPushToUsers = async (
    userIds: string[],
    title: string,
    body: string,
    data: Record<string, string>,
    category: NotificationCategory,
    chatId?: string,
    channelId?: string,
    options?: {
        subtitle?: string;
        // iOS/Android notification category — enables action buttons (e.g. the
        // "missed_call" category carries a text-input quick-reply action that
        // the client registers at startup via setNotificationCategoryAsync).
        categoryId?: string;
        /**
         * Copy for recipients who have LOCKED this chat behind a biometric
         * gate — their tray must stay as opaque as the chat itself.
         *
         * Handled here rather than by the caller splitting the recipient list
         * itself. That split cost a `users/{uid}.get()` PER RECIPIENT, issued
         * immediately before calling in here — where `resolveNotificationTargets`
         * had already batch-read those exact documents. It doubled the
         * per-recipient user reads on every message sent (doc 36 §1.1), and on
         * a 4-person group that is 4 avoidable reads per message.
         *
         * Omitting `categoryId` here is deliberate and load-bearing: a locked
         * chat must never expose a lock-screen reply field.
         */
        lockedVariant?: {
            title: string;
            body: string;
            data: Record<string, string>;
        };
    },
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
        subtitle: normalizeString(options?.subtitle),
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

    // Which recipients locked this chat, from the user documents already read.
    const lockedUserIds = new Set(
        resolved.users.filter((entry) => entry.chatLocked).map((entry) => entry.userId),
    );
    const resolvedUserIds = new Set(resolved.users.map((entry) => entry.userId));
    const isLocked = (userId: string): boolean =>
        shouldUseLockedCopy({
            userId,
            lockedUserIds,
            resolvedUserIds,
            hasLockedVariant: Boolean(options?.lockedVariant),
        });

    const dispatchTargets = [...targetDevices];
    const messages: ExpoPushMessage[] = dispatchTargets.map((device) => {
        const locked = isLocked(device.userId);
        const variant = locked ? options!.lockedVariant! : { title, body, data };
        return {
            to: device.expoPushToken!,
            title: variant.title,
            // No subtitle for a locked chat: it carries the sender name.
            ...(!locked && options?.subtitle ? { subtitle: options.subtitle } : {}),
            body: variant.body,
            data: toStringRecord({ ...variant.data, deliveryId }),
            sound: "default",
            priority: "high",
            channelId: channelId ?? mapCategoryToChannel(category),
            // Never on a locked chat — a reply field would let anyone holding
            // the phone answer into a chat the owner gated.
            ...(!locked && options?.categoryId ? { categoryId: options.categoryId } : {}),
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

// ─────────────────────────────────────────────────────────────
// Silent revoke push — clear stale tray notifications remotely
// ─────────────────────────────────────────────────────────────
// When a group/expense/settlement is deleted, devices holding a visible push
// about it have a dead deep link in the tray. This sends a silent push
// (content-available on iOS, data-only on Android) so the client's background
// notification task can withdraw them even when the app is killed.
//
// Intentionally skips the preference/category/mute gating used for visible
// pushes: a user may have received the original notification before muting
// or disabling a category, and a revoke must always be able to clear it.

export interface SilentRevokeResult {
    targetedDeviceCount: number;
    acceptedCount: number;
    errorCount: number;
}

export const sendSilentRevokePush = async (
    userIds: string[],
    revoke: RevokeFilter,
): Promise<SilentRevokeResult> => {
    const data = buildRevokeData(revoke);
    if (!data || userIds.length === 0) {
        return { targetedDeviceCount: 0, acceptedCount: 0, errorCount: 0 };
    }

    const db = getFirestore();
    const devices: NotificationDeviceState[] = [];

    for (const chunk of chunkArray(userIds, 20)) {
        const deviceLists = await Promise.all(
            chunk.map(async (userId) => {
                try {
                    return await listUserDeviceRecords(db, userId);
                } catch (error) {
                    logger.warn("Revoke push: failed to list devices for user", {
                        userId,
                        error: error instanceof Error ? error.message : "unknown",
                    });
                    return [] as NotificationDeviceState[];
                }
            }),
        );

        for (const userDevices of deviceLists) {
            const candidates = userDevices.filter((device) =>
                device.registrationStatus === "active" &&
                Boolean(device.expoPushToken) &&
                isPermissionCapable(device.permissionState) &&
                isExpoPushToken(device.expoPushToken!),
            );
            devices.push(...dedupeDevicesForDelivery(candidates));
        }
    }

    if (devices.length === 0) {
        return { targetedDeviceCount: 0, acceptedCount: 0, errorCount: 0 };
    }

    const messages: ExpoPushMessage[] = devices.map((device) => ({
        to: device.expoPushToken!,
        data,
        priority: "high",
        _contentAvailable: true,
        sound: null,
    }));

    const ticketResults = await sendExpoPush(messages);
    let acceptedCount = 0;
    let errorCount = 0;

    for (let index = 0; index < ticketResults.length; index += 1) {
        const result = ticketResults[index];
        const device = devices[index];
        if (!device) {
            continue;
        }

        if (result.ticket.status === "ok") {
            acceptedCount += 1;
            continue;
        }

        errorCount += 1;
        const ticketError = normalizeString(result.ticket.details?.error)
            ?? normalizeString(result.ticket.message)
            ?? "Unknown ticket error";

        if (ticketError === "DeviceNotRegistered") {
            await invalidateDeviceToken(device, ticketError);
        }
    }

    logger.info("Sent silent revoke push", {
        revoke: data,
        requestedUserCount: userIds.length,
        targetedDeviceCount: devices.length,
        acceptedCount,
        errorCount,
    });

    return { targetedDeviceCount: devices.length, acceptedCount, errorCount };
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
                nativePushToken: null,
                permissionState: "granted",
                registrationStatus: "active",
                projectId: null,
                deviceName: null,
                modelName: null,
                lastRegistrationError: null,
                isPhysicalDevice: true,
                lastSeenAt: null,
                lastRegisteredAt: null,
                updatedAt: null,
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
