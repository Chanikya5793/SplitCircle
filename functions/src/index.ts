import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { AccessToken } from "livekit-server-sdk";
import { processAllDueRecurringBills, processGroupDueRecurringBills } from "./recurringBills";
import {
    processPendingNotificationReceipts,
    sendPushToUsers,
    syncNotificationDeviceRecord,
    unregisterNotificationDeviceRecord,
    type NotificationPermissionState,
} from "./notifications";
export { parseReceiptWithLLM } from "./parseReceiptWithLLM";

initializeApp();

const livekitUrlSecret = defineSecret("LIVEKIT_URL");
const livekitApiKeySecret = defineSecret("LIVEKIT_API_KEY");
const livekitApiSecretSecret = defineSecret("LIVEKIT_API_SECRET");

type SecretLike = {
    value: () => string;
};

type MaybeCall = {
    chatId?: string;
    status?: string;
    allowedUserIds?: Record<string, boolean>;
};

type SafeErrorPayload = {
    message?: string;
    name?: string;
};

const getStringValue = (input: unknown): string => {
    return typeof input === "string" ? input.trim() : "";
};

const sanitizeParticipantName = (rawName: string, fallback: string): string => {
    const cleaned = rawName.replace(/[\u0000-\u001F\u007F]/g, "").trim();
    if (!cleaned) return fallback;
    return cleaned.slice(0, 64);
};

const isSafeIdentifier = (value: string): boolean => {
    return /^[A-Za-z0-9_-]{1,128}$/.test(value);
};

const toSafeError = (error: unknown): SafeErrorPayload => {
    if (error instanceof Error) {
        return { name: error.name, message: error.message };
    }
    return { message: "Unknown error" };
};

const getSecretOrEnv = (secret: SecretLike, envName: string): string => {
    try {
        const secretValue = secret.value().trim();
        if (secretValue.length > 0) return secretValue;
    } catch {
        // Fall back to env vars in local emulator/dev contexts.
    }
    return process.env[envName]?.trim() ?? "";
};

const getBearerToken = (authorizationHeader: string | undefined): string | null => {
    if (!authorizationHeader) return null;
    const [scheme, token] = authorizationHeader.trim().split(" ");
    if (scheme !== "Bearer" || !token) return null;
    return token;
};

const getAuthenticatedUid = async (authorizationHeader: string | undefined): Promise<string | null> => {
    const bearerToken = getBearerToken(authorizationHeader);
    if (!bearerToken) return null;
    try {
        const decoded = await getAuth().verifyIdToken(bearerToken);
        return decoded.uid ?? null;
    } catch {
        return null;
    }
};

// ─────────────────────────────────────────────────────────────
// Push Notifications — Device Registration and Diagnostics
// ─────────────────────────────────────────────────────────────

export const syncNotificationDevice = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const deviceId = getStringValue(request.data?.deviceId);
    const platform = request.data?.platform === "android" ? "android" : "ios";
    const rawPermissionState = getStringValue(request.data?.permissionState) as NotificationPermissionState;
    const permissionState: NotificationPermissionState =
        rawPermissionState === "granted" ||
            rawPermissionState === "provisional" ||
            rawPermissionState === "ephemeral" ||
            rawPermissionState === "denied"
            ? rawPermissionState
            : "undetermined";

    if (!deviceId) {
        throw new HttpsError("invalid-argument", "Missing required field: deviceId");
    }

    const result = await syncNotificationDeviceRecord(uid, {
        deviceId,
        platform,
        expoPushToken: getStringValue(request.data?.expoPushToken) || null,
        permissionState,
        projectId: getStringValue(request.data?.projectId) || null,
        appVersion: getStringValue(request.data?.appVersion) || null,
        deviceName: getStringValue(request.data?.deviceName) || null,
        modelName: getStringValue(request.data?.modelName) || null,
        isPhysicalDevice: request.data?.isPhysicalDevice === true,
        lastRegistrationError: getStringValue(request.data?.lastRegistrationError) || null,
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

export const unregisterNotificationDevice = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const deviceId = getStringValue(request.data?.deviceId);
    if (!deviceId) {
        throw new HttpsError("invalid-argument", "Missing required field: deviceId");
    }

    await unregisterNotificationDeviceRecord(uid, deviceId);
    logger.info("Unregistered notification device", { uid, deviceId });
    return { success: true };
});

export const sendTestPushNotification = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    try {
        const result = await sendPushToUsers(
            [uid],
            "SplitCircle test notification",
            "Remote push is flowing through the backend, Expo, and your device registration.",
            {
                type: "general",
                source: "settings_test",
            },
            "general",
            undefined,
            "general",
        );

        if (result.acceptedCount === 0) {
            throw new HttpsError(
                "failed-precondition",
                "No eligible devices are currently registered for remote push delivery.",
                {
                    deliveryId: result.deliveryId,
                    status: result.status,
                    droppedCount: result.droppedCount,
                },
            );
        }

        return result;
    } catch (error) {
        if (error instanceof HttpsError) {
            throw error;
        }

        logger.error("Failed to send test push notification", {
            uid,
            error: toSafeError(error),
        });

        throw new HttpsError(
            "internal",
            error instanceof Error
                ? error.message
                : "Unexpected notification delivery failure.",
        );
    }
});

// ─────────────────────────────────────────────────────────────
// Push Notifications — Chat Messages
// ─────────────────────────────────────────────────────────────

export const onChatUpdated = onDocumentUpdated(
    "chats/{chatId}",
    async (event) => {
        const before = event.data?.before.data();
        const after = event.data?.after.data();

        if (!before || !after) {
            return;
        }

        const chatId = event.params.chatId;

        // Detect new lastMessage
        const beforeMsg = before.lastMessage as Record<string, unknown> | undefined;
        const afterMsg = after.lastMessage as Record<string, unknown> | undefined;

        if (!afterMsg) {
            return;
        }

        // Skip if lastMessage hasn't changed
        const beforeMsgId = beforeMsg?.messageId ?? beforeMsg?.id;
        const afterMsgId = afterMsg.messageId ?? afterMsg.id;

        if (beforeMsgId === afterMsgId) {
            return;
        }

        // Skip system messages
        if (afterMsg.type === "system") {
            return;
        }

        const senderId = afterMsg.senderId as string;
        const content = afterMsg.content as string;
        const msgType = afterMsg.type as string;
        const participantIds = (after.participantIds ?? []) as string[];

        // Get sender name
        let senderName = "Someone";
        try {
            const senderDoc = await getFirestore().collection("users").doc(senderId).get();
            if (senderDoc.exists) {
                senderName = (senderDoc.data()?.displayName as string) || "Someone";
            }
        } catch {
            // Use fallback name
        }

        // Get group name if group chat
        let title = senderName;
        const groupId = after.groupId as string | undefined;
        if (groupId) {
            try {
                const groupDoc = await getFirestore().collection("groups").doc(groupId).get();
                if (groupDoc.exists) {
                    const groupName = groupDoc.data()?.name as string;
                    title = `${senderName} in ${groupName}`;
                }
            } catch {
                // Use sender name as title
            }
        }

        // Build body based on message type
        let body: string;
        switch (msgType) {
            case "image":
                body = "📷 Sent a photo";
                break;
            case "video":
                body = "🎥 Sent a video";
                break;
            case "audio":
                body = "🎵 Sent an audio message";
                break;
            case "file":
                body = "📎 Sent a file";
                break;
            case "location":
                body = "📍 Shared a location";
                break;
            default:
                body = content.length > 100 ? `${content.substring(0, 100)}…` : content;
        }

        // Send to all participants except the sender
        const recipientIds = participantIds.filter((id) => id !== senderId);

        if (recipientIds.length === 0) {
            return;
        }

        try {
            const dispatch = await sendPushToUsers(
                recipientIds,
                title,
                body,
                {
                    type: "message",
                    chatId,
                    ...(groupId ? { groupId } : {}),
                    senderId,
                    senderName,
                },
                "messages",
                chatId,
                "messages",
            );
            logger.info("Queued message notifications", {
                chatId,
                deliveryId: dispatch.deliveryId,
                acceptedCount: dispatch.acceptedCount,
                targetedDeviceCount: dispatch.targetedDeviceCount,
            });
        } catch (error) {
            logger.error("Failed to send message notifications", toSafeError(error));
        }
    },
);

// ─────────────────────────────────────────────────────────────
// Push Notifications — Group Updates (Expenses, Settlements, Members)
// ─────────────────────────────────────────────────────────────

export const onGroupUpdated = onDocumentUpdated(
    "groups/{groupId}",
    async (event) => {
        const before = event.data?.before.data();
        const after = event.data?.after.data();

        if (!before || !after) {
            return;
        }

        const groupId = event.params.groupId;
        const groupName = (after.name as string) || "Group";
        const memberIds = (after.memberIds ?? []) as string[];

        // ─── Detect new expenses ────────────────────────────
        const beforeExpenses = (before.expenses ?? []) as Array<Record<string, unknown>>;
        const afterExpenses = (after.expenses ?? []) as Array<Record<string, unknown>>;

        if (afterExpenses.length > beforeExpenses.length) {
            const beforeIds = new Set(beforeExpenses.map((e) => e.expenseId as string));
            const newExpenses = afterExpenses.filter(
                (e) => !beforeIds.has(e.expenseId as string),
            );

            for (const expense of newExpenses) {
                const paidBy = expense.paidBy as string;
                const description = (expense.description as string) || "New expense";
                const amount = expense.amount as number;
                const currency = (after.currency as string) || "USD";

                let payerName = "Someone";
                try {
                    const payerDoc = await getFirestore().collection("users").doc(paidBy).get();
                    if (payerDoc.exists) {
                        payerName = (payerDoc.data()?.displayName as string) || "Someone";
                    }
                } catch {
                    // Use fallback
                }

                const recipientIds = memberIds.filter((id) => id !== paidBy);
                if (recipientIds.length > 0) {
                    try {
                        const dispatch = await sendPushToUsers(
                            recipientIds,
                            `💰 ${groupName}`,
                            `${payerName} added "${description}" — ${currency} ${amount.toFixed(2)}`,
                            {
                                type: "expense",
                                groupId,
                                expenseId: expense.expenseId as string,
                            },
                            "expenses",
                            undefined,
                            "expenses",
                        );
                        logger.info("Queued expense notifications", {
                            groupId,
                            deliveryId: dispatch.deliveryId,
                            acceptedCount: dispatch.acceptedCount,
                            targetedDeviceCount: dispatch.targetedDeviceCount,
                        });
                    } catch (error) {
                        logger.error("Failed to send expense notification", toSafeError(error));
                    }
                }
            }
        }

        // ─── Detect new settlements ─────────────────────────
        const beforeSettlements = (before.settlements ?? []) as Array<Record<string, unknown>>;
        const afterSettlements = (after.settlements ?? []) as Array<Record<string, unknown>>;

        if (afterSettlements.length > beforeSettlements.length) {
            const beforeSettlementIds = new Set(
                beforeSettlements.map((s) => s.settlementId as string),
            );
            const newSettlements = afterSettlements.filter(
                (s) => !beforeSettlementIds.has(s.settlementId as string),
            );

            for (const settlement of newSettlements) {
                const fromUserId = settlement.fromUserId as string;
                const toUserId = settlement.toUserId as string;
                const amount = settlement.amount as number;
                const currency = (after.currency as string) || "USD";

                let fromName = "Someone";
                try {
                    const fromDoc = await getFirestore().collection("users").doc(fromUserId).get();
                    if (fromDoc.exists) {
                        fromName = (fromDoc.data()?.displayName as string) || "Someone";
                    }
                } catch {
                    // Use fallback
                }

                // Notify the person being paid
                try {
                    const dispatch = await sendPushToUsers(
                        [toUserId],
                        `🤝 ${groupName}`,
                        `${fromName} settled ${currency} ${amount.toFixed(2)} with you`,
                        {
                            type: "settlement",
                            groupId,
                            settlementId: settlement.settlementId as string,
                        },
                        "settlements",
                        undefined,
                        "expenses",
                    );
                    logger.info("Queued settlement notifications", {
                        groupId,
                        deliveryId: dispatch.deliveryId,
                        acceptedCount: dispatch.acceptedCount,
                        targetedDeviceCount: dispatch.targetedDeviceCount,
                    });
                } catch (error) {
                    logger.error("Failed to send settlement notification", toSafeError(error));
                }
            }
        }

        // ─── Detect new members ─────────────────────────────
        const beforeMemberIds = (before.memberIds ?? []) as string[];
        const newMemberIds = memberIds.filter((id) => !beforeMemberIds.includes(id));

        if (newMemberIds.length > 0) {
            for (const newMemberId of newMemberIds) {
                let memberName = "Someone";
                try {
                    const memberDoc = await getFirestore().collection("users").doc(newMemberId).get();
                    if (memberDoc.exists) {
                        memberName = (memberDoc.data()?.displayName as string) || "Someone";
                    }
                } catch {
                    // Use fallback
                }

                const existingMembers = beforeMemberIds;
                if (existingMembers.length > 0) {
                    try {
                        const dispatch = await sendPushToUsers(
                            existingMembers,
                            `👋 ${groupName}`,
                            `${memberName} joined the group`,
                            {
                                type: "group_join",
                                groupId,
                            },
                            "groupUpdates",
                            undefined,
                            "groups",
                        );
                        logger.info("Queued group-join notifications", {
                            groupId,
                            deliveryId: dispatch.deliveryId,
                            acceptedCount: dispatch.acceptedCount,
                            targetedDeviceCount: dispatch.targetedDeviceCount,
                        });
                    } catch (error) {
                        logger.error("Failed to send group join notification", toSafeError(error));
                    }
                }
            }
        }
    },
);

// ─────────────────────────────────────────────────────────────
// Scheduler — Recurring Bills
// ─────────────────────────────────────────────────────────────

export const runRecurringBillsScheduler = onSchedule(
    "every 15 minutes",
    async () => {
        try {
            const result = await processAllDueRecurringBills();
            logger.info("Recurring bills scheduler completed", result);
        } catch (error) {
            logger.error("Recurring bills scheduler failed", toSafeError(error));
            throw error;
        }
    }
);

export const processNotificationReceipts = onSchedule(
    "every 10 minutes",
    async () => {
        try {
            const result = await processPendingNotificationReceipts();
            logger.info("Processed pending notification receipts", result);
        } catch (error) {
            logger.error("Failed to process notification receipts", toSafeError(error));
            throw error;
        }
    },
);

export const triggerRecurringBillsForGroup = onCall(
    async (request) => {
        const uid = request.auth?.uid;
        if (!uid) {
            throw new HttpsError("unauthenticated", "Authentication required.");
        }

        const groupId = getStringValue(request.data?.groupId);
        if (!groupId) {
            throw new HttpsError("invalid-argument", "Missing required field: groupId");
        }

        const groupDoc = await getFirestore().collection("groups").doc(groupId).get();
        if (!groupDoc.exists) {
            throw new HttpsError("not-found", "Group not found.");
        }

        const memberIds = Array.isArray(groupDoc.data()?.memberIds)
            ? groupDoc.data()!.memberIds as string[]
            : [];

        if (!memberIds.includes(uid)) {
            throw new HttpsError("permission-denied", "User is not a member of this group.");
        }

        try {
            const result = await processGroupDueRecurringBills(groupId);
            logger.info("Recurring bills sync completed for group", {
                groupId,
                uid,
                ...result,
            });
            return {
                generatedCount: result.generatedExpenses,
                processedBills: result.processedBills,
                scannedBills: result.scannedBills,
            };
        } catch (error) {
            logger.error("Recurring bills sync failed for group", {
                groupId,
                uid,
                ...toSafeError(error),
            });
            throw new HttpsError("internal", "Failed to sync recurring bills.");
        }
    }
);

// ─────────────────────────────────────────────────────────────
// LiveKit Token Generation
// ─────────────────────────────────────────────────────────────

export const generateLiveKitToken = onRequest(
    {
        cors: true,
        secrets: [livekitUrlSecret, livekitApiKeySecret, livekitApiSecretSecret],
    },
    async (req, res) => {
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
            const uid = await getAuthenticatedUid(req.get("Authorization") ?? undefined);
            if (!uid) {
                res.status(401).json({ error: "Unauthorized. Missing or invalid Firebase ID token." });
                return;
            }

            const requestBody = (typeof req.body === "object" && req.body !== null)
                ? req.body as Record<string, unknown>
                : {};

            const roomName = getStringValue(requestBody.roomName ?? req.query.roomName);
            const chatId = getStringValue(requestBody.chatId ?? req.query.chatId);
            const participantName = sanitizeParticipantName(
                getStringValue(requestBody.name ?? req.query.name),
                uid
            );

            if (!roomName || !chatId) {
                res.status(400).json({ error: "Missing required parameters: roomName, chatId" });
                return;
            }

            if (!isSafeIdentifier(roomName) || !isSafeIdentifier(chatId)) {
                res.status(400).json({ error: "Invalid roomName or chatId format." });
                return;
            }

            const chatDoc = await getFirestore().collection("chats").doc(chatId).get();
            if (!chatDoc.exists) {
                res.status(404).json({ error: "Chat not found." });
                return;
            }

            const participantIds = Array.isArray(chatDoc.data()?.participantIds)
                ? chatDoc.data()!.participantIds as string[]
                : [];

            if (!participantIds.includes(uid)) {
                res.status(403).json({ error: "Forbidden. User is not a participant in this chat." });
                return;
            }

            const callSnapshot = await getDatabase().ref(`calls/${roomName}`).get();
            if (!callSnapshot.exists()) {
                res.status(404).json({ error: "Call session not found or expired." });
                return;
            }

            const callData = callSnapshot.val() as MaybeCall;
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

            const accessToken = new AccessToken(livekitApiKey, livekitApiSecret, {
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
            res.status(200).json({ token, url: livekitUrl });
        } catch (error) {
            logger.error("Error generating LiveKit token", toSafeError(error));
            res.status(500).json({ error: "Internal server error" });
        }
    }
);
