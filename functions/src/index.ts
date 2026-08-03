import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { onValueCreated } from "firebase-functions/v2/database";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentDeleted, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { AccessToken } from "livekit-server-sdk";
import { processAllDueRecurringBills, processGroupDueRecurringBills } from "./recurringBills";
import {
    processPendingNotificationReceipts,
    sendPushToUsers,
    sendSilentRevokePush,
    syncNotificationDeviceRecord,
    unregisterNotificationDeviceRecord,
    type NotificationPermissionState,
} from "./notifications";
import { diffRemovedGroupEntities } from "./revoke";
import {
    sendCallVoipPush,
    upsertVoipTokenForDevice,
    voipPushSecrets,
} from "./voipPush";
import {
    materializeDebtFriendships,
    materializeGroupFriendships,
    touchFriendInteraction,
} from "./friends";
import { verifyGroupEntityExists } from "./entityGuards";
import { deleteAccountCascade, findDeletionBlockers } from "./accountDeletion";
import { joinGroupByInviteCode as joinGroupByInviteCodeImpl } from "./groupJoin";
import { repairChatAudience as repairChatAudienceImpl } from "./chatAudienceRepair";
import {
    createPairingCode as createPairingCodeImpl,
    redeemPairingCode as redeemPairingCodeImpl,
    confirmPairing as confirmPairingImpl,
    revokeDevice as revokeDeviceImpl,
    authorizeScannedDevice as authorizeScannedDeviceImpl,
} from "./pairing";
import {
    publishSignalPrekeys as publishSignalPrekeysImpl,
    claimSignalPreKey as claimSignalPreKeyImpl,
    type PublishablePrekeyBundle,
} from "./signalKeys";
import {
    setBackupRecoveryVerifier as setBackupRecoveryVerifierImpl,
    hasBackupRecoveryVerifier as hasBackupRecoveryVerifierImpl,
    recoverAsNewMainDevice as recoverAsNewMainDeviceImpl,
} from "./accountRecovery";
import { backfillMissingDisplayNames } from "./displayNameBackfill";
export { cleanupOldRtdbData, reapStaleRingingCalls } from "./cleanup";
// Consolidated AI-layer ingestion fan-out (gated by AI_LAYER_ENABLED; no-op until
// activated — see aiLayer.ts and ai_layer/docs/08_self_review.md).
export { onGroupWritten } from "./aiLayer";
// App-facing AI assistant callable (gated the same way; the app never holds the
// RAG shared secret — this proxies with the uid from the verified token).
export { askExpenseAi } from "./askExpenseAi";

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
    type?: string;
    initiatorId?: string;
    groupId?: string;
    startedAt?: number;
    allowedUserIds?: Record<string, boolean>;
    participants?: Record<string, MaybeCallParticipant> | MaybeCallParticipant[];
};

type MaybeCallParticipant = {
    userId?: string;
    displayName?: string;
    photoURL?: string;
    muted?: boolean;
    cameraEnabled?: boolean;
};

type SafeErrorPayload = {
    errorMessage?: string;
    errorName?: string;
    errorStack?: string;
};

const getStringValue = (input: unknown): string => {
    return typeof input === "string" ? input.trim() : "";
};

const truncate = (input: string, maxLength: number): string => {
    const compact = input.replace(/\s+/g, " ").trim();
    if (compact.length <= maxLength) {
        return compact;
    }
    return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const getAllowedUserIds = (allowedUserIds: Record<string, boolean> | undefined): string[] =>
    Object.entries(allowedUserIds ?? {})
        .filter(([, allowed]) => allowed === true)
        .map(([userId]) => userId);

const normalizeCallParticipants = (
    input: Record<string, MaybeCallParticipant> | MaybeCallParticipant[] | undefined,
): MaybeCallParticipant[] => {
    if (!input) {
        return [];
    }

    if (Array.isArray(input)) {
        return input;
    }

    return Object.values(input);
};

const sanitizeParticipantName = (rawName: string, fallback: string): string => {
    const cleaned = rawName.replace(/[\u0000-\u001F\u007F]/g, "").trim();
    if (!cleaned) return fallback;
    return cleaned.slice(0, 64);
};

const isSafeIdentifier = (value: string): boolean => {
    return /^[A-Za-z0-9_-]{1,128}$/.test(value);
};

/**
 * Keys are `errorName`/`errorMessage`, NOT `name`/`message`, and that matters.
 *
 * firebase-functions' logger builds its own entry with a top-level `message`
 * field, so spreading a payload that also has `message` silently OVERWRITES the
 * real cause with the wrapper's text. Every `logger.error("X failed", {
 * ...toSafeError(e) })` in this file — 45 call sites — was therefore throwing
 * away the one piece of information it existed to capture. It cost a full
 * debugging cycle on redeemPairingCode: the logs showed only "redeemPairingCode
 * failed" with no cause, for an error that had already been caught and
 * formatted.
 */
const toSafeError = (error: unknown): SafeErrorPayload => {
    if (error instanceof Error) {
        return {
            errorName: error.name,
            errorMessage: error.message,
            // Truncated: enough to locate the throw, not enough to bloat every
            // error log line in the project.
            errorStack: error.stack?.split("\n").slice(0, 4).join(" | "),
        };
    }
    return { errorMessage: String(error) };
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

/*
 * `describeMessagePreview` / `buildMessageNotificationCopy` REMOVED alongside
 * `onChatUpdated` (doc 36 §1). Both existed solely to turn message plaintext
 * into notification copy server-side. The equivalent now runs ON THE DEVICE,
 * in `src/services/notificationPreview.ts`, against a blob only that device can
 * open — same wording, no plaintext.
 */

const buildExpenseNotificationCopy = (params: {
    groupName: string;
    payerName: string;
    description: string;
    currency: string;
    amount: number;
}): { title: string; subtitle: string; body: string } => ({
    title: params.groupName,
    subtitle: `${params.currency} ${params.amount.toFixed(2)}`,
    body: `${params.payerName} added "${truncate(params.description || "New expense", 60)}"`,
});

const buildSettlementNotificationCopy = (params: {
    groupName: string;
    fromName: string;
    currency: string;
    amount: number;
}): { title: string; subtitle: string; body: string } => ({
    title: params.groupName,
    subtitle: "Settlement update",
    body: `${params.fromName} settled ${params.currency} ${params.amount.toFixed(2)} with you`,
});

const buildGroupJoinNotificationCopy = (params: {
    groupName: string;
    memberName: string;
}): { title: string; subtitle: string; body: string } => ({
    title: params.groupName,
    subtitle: "Group update",
    body: `${params.memberName} joined the group`,
});

const buildIncomingCallNotificationCopy = (params: {
    callerName: string;
    callType: "audio" | "video";
    conversationName?: string;
    participantCount: number;
}): { title: string; subtitle: string; body: string } => {
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
        // Doc 36 §6 — stored now, sent with later. An older client that does
        // not send this field simply keeps its stored value.
        nativePushToken: getStringValue(request.data?.nativePushToken) || null,
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
            "ManaSplit test notification",
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

/**
 * REMOVED 2026-08-03 — the plaintext notification path (doc 36 §1).
 *
 * `onChatUpdated` triggered on `chats/{chatId}` and built every message
 * notification from `lastMessage.content`, which is the message PLAINTEXT. That
 * meant this server, Expo's relay and APNs/FCM could all read every message —
 * the end-to-end claim was false for the most recent message in every chat,
 * and the plaintext sat in Firestore indefinitely, against this project's own
 * first architectural rule ("Never store messages in Firestore").
 *
 * Message pushes now originate from `fanOutQueuedMessage` (messageFanout.ts),
 * which triggers on the RTDB queue write and forwards a SEALED per-device
 * preview it cannot read. That path is per-recipient-device, is deleted after
 * delivery, and needs no plaintext anywhere.
 *
 * Nothing replaces this trigger: it existed only to send those notifications.
 * The chat document is still written (participants, timestamps, unread counts);
 * it simply no longer carries message text, and nothing server-side reads it.
 */

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

        // ─── Detect removed expenses/settlements → silent revoke ───
        // The deleting device tidies its own tray locally; every other
        // member gets a silent push so their background handler can
        // withdraw the now-dead notification even if the app is killed.
        // Best-effort — must never block the visible notification path.
        const removedEntities = diffRemovedGroupEntities(before, after);
        if (memberIds.length > 0) {
            for (const expenseId of removedEntities.expenseIds) {
                try {
                    await sendSilentRevokePush(memberIds, { expenseId });
                } catch (error) {
                    logger.error("Failed to send expense revoke push", {
                        groupId,
                        expenseId,
                        error: toSafeError(error),
                    });
                }
            }
            for (const settlementId of removedEntities.settlementIds) {
                try {
                    await sendSilentRevokePush(memberIds, { settlementId });
                } catch (error) {
                    logger.error("Failed to send settlement revoke push", {
                        groupId,
                        settlementId,
                        error: toSafeError(error),
                    });
                }
            }
        }

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

                // Debt-derived friend fan-out — pair the payer with every
                // participant in the split. Best-effort, never blocks the
                // notification path below.
                const expenseParticipants = Array.isArray(expense.participants)
                    ? (expense.participants as Array<{ userId?: string }>)
                          .map((p) => p?.userId)
                          .filter((id): id is string => typeof id === "string")
                    : [];
                if (paidBy && expenseParticipants.length > 0) {
                    void materializeDebtFriendships(paidBy, expenseParticipants);
                }

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
                    // The group or expense may have been deleted between the
                    // trigger event and now — never notify about a dead link.
                    const guard = await verifyGroupEntityExists(groupId, {
                        expenseId: expense.expenseId as string,
                    });
                    if (!guard.ok) {
                        logger.info("Skipping expense notification for deleted entity", {
                            groupId,
                            expenseId: expense.expenseId,
                            reason: guard.reason,
                        });
                        continue;
                    }
                    try {
                        const notificationCopy = buildExpenseNotificationCopy({
                            groupName,
                            payerName,
                            description,
                            currency,
                            amount,
                        });
                        const dispatch = await sendPushToUsers(
                            recipientIds,
                            notificationCopy.title,
                            notificationCopy.body,
                            {
                                type: "expense",
                                groupId,
                                expenseId: expense.expenseId as string,
                            },
                            "expenses",
                            undefined,
                            "expenses",
                            { subtitle: notificationCopy.subtitle },
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

                // Bump lastInteractionAt for both sides — keeps "active friends"
                // sortable in the Friends tab.
                if (fromUserId && toUserId) {
                    void touchFriendInteraction(fromUserId, toUserId);
                }
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

                // The group or settlement may have been deleted between the
                // trigger event and now — never notify about a dead link.
                const guard = await verifyGroupEntityExists(groupId, {
                    settlementId: settlement.settlementId as string,
                });
                if (!guard.ok) {
                    logger.info("Skipping settlement notification for deleted entity", {
                        groupId,
                        settlementId: settlement.settlementId,
                        reason: guard.reason,
                    });
                    continue;
                }

                // Notify the person being paid
                try {
                    const notificationCopy = buildSettlementNotificationCopy({
                        groupName,
                        fromName,
                        currency,
                        amount,
                    });
                    const dispatch = await sendPushToUsers(
                        [toUserId],
                        notificationCopy.title,
                        notificationCopy.body,
                        {
                            type: "settlement",
                            groupId,
                            settlementId: settlement.settlementId as string,
                        },
                        "settlements",
                        undefined,
                        "expenses",
                        { subtitle: notificationCopy.subtitle },
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
            // Group-derived friend fan-out: pair every new member with every
            // *existing* member. We pass the full member set; the helper is
            // idempotent so existing edges are kept and only new edges get
            // written. Fire-and-forget — must not block the notification path.
            void materializeGroupFriendships(memberIds);

            // If the group was deleted right after the join was recorded,
            // skip the whole member fan-out — the deep link is already dead.
            const groupGuard = await verifyGroupEntityExists(groupId);
            if (!groupGuard.ok) {
                logger.info("Skipping group-join notifications for deleted group", {
                    groupId,
                    reason: groupGuard.reason,
                });
                return;
            }

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
                        const notificationCopy = buildGroupJoinNotificationCopy({
                            groupName,
                            memberName,
                        });
                        const dispatch = await sendPushToUsers(
                            existingMembers,
                            notificationCopy.title,
                            notificationCopy.body,
                            {
                                type: "group_join",
                                groupId,
                            },
                            "groupUpdates",
                            undefined,
                            "groups",
                            { subtitle: notificationCopy.subtitle },
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
// Silent Revoke — Group Deleted
// ─────────────────────────────────────────────────────────────
// When a group document is deleted, every delivered notification that
// deep-links into it (expenses, settlements, joins, group-chat messages —
// they all carry groupId) is now a dead end on members' devices. The
// deleting device tidies its own tray locally; everyone else gets a silent
// push so their background handler can withdraw those notifications even
// when the app is killed or backgrounded.

export const onGroupDeleted = onDocumentDeleted(
    "groups/{groupId}",
    async (event) => {
        const groupId = event.params.groupId;
        const data = event.data?.data();
        if (!data) {
            return;
        }

        const memberIds = Array.isArray(data.memberIds)
            ? (data.memberIds as unknown[]).filter(
                (id): id is string => typeof id === "string" && id.length > 0,
            )
            : [];

        if (memberIds.length === 0) {
            return;
        }

        try {
            const result = await sendSilentRevokePush(memberIds, { groupId });
            logger.info("Queued group revoke push", {
                groupId,
                memberCount: memberIds.length,
                targetedDeviceCount: result.targetedDeviceCount,
                acceptedCount: result.acceptedCount,
            });
        } catch (error) {
            logger.error("Failed to send group revoke push", {
                groupId,
                error: toSafeError(error),
            });
        }
    },
);

// ─────────────────────────────────────────────────────────────
// Per-device message fan-out (ai_layer/docs/31_multi_device_icloud_sync.md §3.1)
// ─────────────────────────────────────────────────────────────

export { fanOutQueuedMessage } from "./messageFanout";

// ─────────────────────────────────────────────────────────────
// Push Notifications — Incoming Calls
// ─────────────────────────────────────────────────────────────

export const onCallCreated = onValueCreated(
    {
        ref: "/calls/{callId}",
        secrets: voipPushSecrets,
    },
    async (event) => {
        const callId = event.params.callId;
        const callData = event.data?.val() as MaybeCall | null;

        if (!callId || !callData) {
            return;
        }

        if (callData.status !== "ringing") {
            return;
        }

        // Never ring for a node that's already stale by the time this fires.
        // onValueCreated is normally near-instant, so an old startedAt means a
        // replay/backfill or a badly delayed event — don't wake a device for it.
        const startedAtRaw = typeof callData.startedAt === "number" ? callData.startedAt : 0;
        if (startedAtRaw > 0 && Date.now() - startedAtRaw > 60_000) {
            logger.warn("Skipping call push for stale node", { callId, ageMs: Date.now() - startedAtRaw });
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
        let callerName = sanitizeParticipantName(
            getStringValue(initiatorParticipant?.displayName),
            "Someone",
        );

        if (!callerName || callerName === "Someone") {
            try {
                const initiatorDoc = await getFirestore().collection("users").doc(initiatorId).get();
                if (initiatorDoc.exists) {
                    callerName = sanitizeParticipantName(
                        getStringValue(initiatorDoc.data()?.displayName),
                        "Someone",
                    );
                }
            } catch {
                // Use best-effort caller name from session.
            }
        }

        let conversationName: string | undefined;
        if (groupId) {
            try {
                const groupDoc = await getFirestore().collection("groups").doc(groupId).get();
                if (groupDoc.exists) {
                    const rawName = getStringValue(groupDoc.data()?.name);
                    conversationName = rawName || undefined;
                }
            } catch {
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
            const dispatch = await sendPushToUsers(
                recipientIds,
                notificationCopy.title,
                notificationCopy.body,
                {
                    type: "call",
                    chatId,
                    callId,
                    callType,
                    senderId: initiatorId,
                    senderName: callerName,
                    ...(groupId ? { groupId } : {}),
                },
                "calls",
                undefined,
                "calls",
                { subtitle: notificationCopy.subtitle },
            );

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
        } catch (error) {
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
            const voipResult = await sendCallVoipPush({
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

            // NOTE: deliveryState is intentionally NOT written here. APNs
            // "accepted" only means the push was queued — it accepts pushes
            // for offline devices too, which made the caller see "Ringing"
            // for unreachable callees. The callee's DEVICE now writes
            // calls/{callId}/deliveryState = 'ringing' itself when it has
            // actually presented the incoming call (see callService
            // ackCallRinging + the deliveryState rule in database.rules.json).
        } catch (error) {
            logger.error("VoIP call push failed", {
                callId,
                error: toSafeError(error),
            });
        }
    },
);

// ─────────────────────────────────────────────────────────────
// VoIP Push Token Registration (callable)
// ─────────────────────────────────────────────────────────────

export const registerVoipPushToken = onCall(
    {
        cors: true,
    },
    async (request) => {
        const uid = request.auth?.uid;
        if (!uid) {
            throw new HttpsError("unauthenticated", "Sign-in required.");
        }

        const data = (request.data ?? {}) as Record<string, unknown>;
        const deviceId = getStringValue(data.deviceId);
        const voipPushToken = getStringValue(data.voipPushToken);
        const bundleId = getStringValue(data.bundleId) || undefined;
        const platform = getStringValue(data.platform) || "ios";

        if (!deviceId || !voipPushToken) {
            throw new HttpsError("invalid-argument", "deviceId and voipPushToken are required.");
        }
        if (voipPushToken.length > 256 || !/^[A-Fa-f0-9]+$/.test(voipPushToken)) {
            throw new HttpsError("invalid-argument", "voipPushToken must be a hex device token.");
        }

        await upsertVoipTokenForDevice({
            userId: uid,
            deviceId,
            voipPushToken,
            bundleId,
            platform,
        });

        return { ok: true };
    },
);

// ─────────────────────────────────────────────────────────────
// Missed-call notification (callable)
// ─────────────────────────────────────────────────────────────
// The caller invokes this when an outgoing call is never answered (ring
// timeout or manual cancel before connect). It notifies the CALLEE(s) with a
// "Missed voice/video call" push. Idempotent via a `missedNotified` flag so a
// retry (or the server reaper) can't double-notify.

export const reportMissedCall = onCall({ cors: true }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Sign-in required.");
    }
    const callId = getStringValue((request.data as Record<string, unknown> | undefined)?.callId);
    if (!callId) {
        throw new HttpsError("invalid-argument", "callId is required.");
    }

    const callRef = getDatabase().ref(`calls/${callId}`);
    const snap = await callRef.get();
    if (!snap.exists()) return { ok: false, reason: "not-found" };

    const call = snap.val() as MaybeCall;
    const initiatorId = getStringValue(call?.initiatorId);
    // Only the caller can report a missed call, and never for a connected one.
    if (initiatorId !== uid) return { ok: false, reason: "not-initiator" };
    if (snap.child("missedNotified").val() === true) return { ok: false, reason: "already-notified" };

    const recipientIds = getAllowedUserIds(call?.allowedUserIds).filter((u) => u !== initiatorId);
    if (recipientIds.length === 0) return { ok: false, reason: "no-recipients" };

    // Claim the flag first (idempotency) before sending.
    await callRef.child("missedNotified").set(true);

    const callType = call?.type === "video" ? "video" : "audio";
    const chatId = getStringValue(call?.chatId);
    const groupId = getStringValue(call?.groupId);
    let callerName = "Someone";
    try {
        const doc = await getFirestore().collection("users").doc(initiatorId).get();
        callerName = sanitizeParticipantName(getStringValue(doc.data()?.displayName), "Someone");
    } catch {
        // best-effort caller name
    }

    const body = callType === "video" ? "📹 Missed video call" : "📞 Missed voice call";
    try {
        await sendPushToUsers(
            recipientIds,
            callerName,
            body,
            {
                type: "missed_call",
                chatId,
                callId,
                callType,
                senderId: initiatorId,
                senderName: callerName,
                ...(groupId ? { groupId } : {}),
            },
            "calls",
            undefined,
            "calls",
            // Attach the quick-reply category: on iOS, long-pressing (or pulling
            // down) the missed-call notification reveals a "Reply" text field
            // that sends an in-app chat message back to the caller.
            { categoryId: "missed_call" },
        );
    } catch (error) {
        logger.error("Failed to send missed-call notification", { callId, error: toSafeError(error) });
        throw new HttpsError("internal", "Failed to notify.");
    }

    return { ok: true };
});

// ─────────────────────────────────────────────────────────────
// Scheduler — Recurring Bills
// ─────────────────────────────────────────────────────────────

export const runRecurringBillsScheduler = onSchedule(
    "every 6 hours",
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
    "every 60 minutes",
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
            // Doc 31 §3.9/§5 Phase 2: per-device LiveKit room identity, so two
            // of this user's own devices can hold distinct room participant
            // identities instead of colliding under a shared `identity: uid`.
            // Falls back to the old bare-uid identity if a caller doesn't
            // send deviceId yet (defensive only — the app client always
            // sends it as of this change).
            const deviceId = getStringValue(requestBody.deviceId ?? req.query.deviceId);
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
                identity: deviceId ? `${uid}:${deviceId}` : uid,
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
        } catch (error) {
            logger.error("Error generating LiveKit token", toSafeError(error));
            res.status(500).json({ error: "Internal server error" });
        }
    }
);

// ─────────────────────────────────────────────────────────────
// Account Deletion (App Store Guideline 5.1.1(v))
// ─────────────────────────────────────────────────────────────
// Cloud-Function-only: Firestore rules hard-deny client deletes on
// users/{uid} and its notificationDevices subcollection, so this must run
// server-side via the Admin SDK. See ai_layer/docs/28_account_deletion.md.

export const checkAccountDeletionBlockers = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    try {
        const blockers = await findDeletionBlockers(uid);
        return { blockers };
    } catch (error) {
        if (error instanceof HttpsError) {
            throw error;
        }
        logger.error("Failed to check account deletion blockers", { uid, ...toSafeError(error) });
        throw new HttpsError("internal", "Failed to check account deletion eligibility.");
    }
});

export const deleteAccount = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    try {
        // Re-checked here (not just trusted from the client's earlier pre-check)
        // to close the race where group state changes between the check and
        // the confirm tap — do not skip this as an "optimization".
        const blockers = await findDeletionBlockers(uid);
        if (blockers.length > 0) {
            throw new HttpsError("failed-precondition", "Transfer ownership of your groups first.", { blockers });
        }

        await deleteAccountCascade(uid);
        logger.info("Account deleted", { uid });
        return { success: true };
    } catch (error) {
        if (error instanceof HttpsError) {
            throw error;
        }
        logger.error("Account deletion failed", { uid, ...toSafeError(error) });
        throw new HttpsError("internal", "Failed to delete account. Please try again.");
    }
});

// ─────────────────────────────────────────────────────────────
// Group Join (by invite code)
// ─────────────────────────────────────────────────────────────
// Cloud-Function-only: the invite-code lookup is a where('inviteCode', '==',
// code) query against groups, whose read rule requires pre-existing
// membership — Firestore evaluates rules against a query's potential result
// set, so it rejects the query outright for a non-member regardless of what
// the data contains. No client-side rule tweak fixes this; only a
// privileged server-side read does. See the CLAUDE.md gotcha.

export const joinGroupByInviteCode = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const inviteCode = getStringValue(request.data?.inviteCode).toUpperCase();
    if (!inviteCode) {
        throw new HttpsError("invalid-argument", "Missing required field: inviteCode");
    }
    const requestId = getStringValue(request.data?.requestId) || undefined;

    try {
        const result = await joinGroupByInviteCodeImpl(uid, inviteCode, requestId);
        logger.info("User joined group via invite code", { uid, ...result });
        return result;
    } catch (error) {
        if (error instanceof HttpsError) {
            throw error;
        }
        if (error instanceof Error && error.message === "Invite code not found") {
            throw new HttpsError("not-found", "Invite code not found.");
        }
        logger.error("joinGroupByInviteCode failed", { uid, inviteCode, ...toSafeError(error) });
        throw new HttpsError("internal", "Failed to join group. Please try again.");
    }
});

/**
 * Reconciles a chat whose `participantIds`/`participants` arrays have drifted
 * (ai_layer/docs/32 §5d). Cloud-Function-only because firestore.rules forbids
 * clients from writing either field — see chatAudienceRepair.ts for why
 * loosening that rule would be a read-access escalation.
 */
export const repairChatAudience = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const chatId = getStringValue(request.data?.chatId);
    if (!chatId) {
        throw new HttpsError("invalid-argument", "Missing required field: chatId");
    }

    try {
        return await repairChatAudienceImpl(uid, chatId);
    } catch (error) {
        if (error instanceof Error && error.message === "Chat not found") {
            throw new HttpsError("not-found", "Chat not found.");
        }
        if (error instanceof Error && error.message === "Not a participant of this chat") {
            throw new HttpsError("permission-denied", "Not a participant of this chat.");
        }
        logger.error("repairChatAudience failed", { uid, chatId, ...toSafeError(error) });
        throw new HttpsError("internal", "Failed to repair chat membership.");
    }
});

// ─────────────────────────────────────────────────────────────
// Device pairing (ai_layer/docs/31_multi_device_icloud_sync.md §3.4)
// ─────────────────────────────────────────────────────────────
// Cloud-Function-only, same reasoning as joinGroupByInviteCode above:
// pairedDevices/notificationDevices/signalPrekeys are all client-write-locked
// in firestore.rules, so every mutation goes through here via the Admin SDK.

export const createPairingCode = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    try {
        const result = await createPairingCodeImpl(uid);
        logger.info("Pairing code created", { uid });
        return result;
    } catch (error) {
        logger.error("createPairingCode failed", { uid, ...toSafeError(error) });
        throw new HttpsError("internal", "Failed to create a pairing code. Please try again.");
    }
});

// Deliberately UNAUTHENTICATED: a device redeeming a pairing code has no
// credentials yet — that is what pairing is for. The code is the credential and
// the uid is derived from it server-side. Requiring auth here made the QR flow
// impossible ("Authentication required" on every scan) because the token this
// returns is what the device signs in WITH.
export const redeemPairingCode = onCall(async (request) => {
    const code = getStringValue(request.data?.code).toUpperCase();
    const deviceId = getStringValue(request.data?.deviceId);
    const platform = request.data?.platform === "android" ? "android" : "ios";
    const deviceName = getStringValue(request.data?.deviceName) || null;
    const modelName = getStringValue(request.data?.modelName) || null;

    if (!code) {
        throw new HttpsError("invalid-argument", "Missing required field: code");
    }
    if (!deviceId || !isSafeIdentifier(deviceId)) {
        throw new HttpsError("invalid-argument", "Missing or invalid field: deviceId");
    }

    try {
        const result = await redeemPairingCodeImpl({ code, deviceId, platform, deviceName, modelName });
        logger.info("Pairing code redeemed", { deviceId });
        return result;
    } catch (error) {
        if (error instanceof Error) {
            if (error.message === "Pairing code not found") {
                throw new HttpsError("not-found", "Pairing code not found.");
            }
            if (error.message === "Pairing code already used") {
                throw new HttpsError("failed-precondition", "This pairing code has already been used.");
            }
            if (error.message === "Pairing code expired") {
                throw new HttpsError("deadline-exceeded", "This pairing code has expired.");
            }
            if (error.message === "Could not issue a sign-in token for this device") {
                // Surfaced distinctly so this never again looks like a generic
                // network blip — it is a server misconfiguration, and the code
                // has been released for a clean retry.
                throw new HttpsError("internal", "Couldn't finish linking (server couldn't issue a sign-in token). Try again.");
            }
            if (error.message === "Device limit reached") {
                throw new HttpsError("resource-exhausted", "You've reached the maximum number of linked devices.");
            }
        }
        logger.error("redeemPairingCode failed", { deviceId, ...toSafeError(error) });
        throw new HttpsError("internal", "Failed to link this device. Please try again.");
    }
});

export const confirmPairing = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const callerDeviceId = getStringValue(request.data?.callerDeviceId);
    const targetDeviceId = getStringValue(request.data?.targetDeviceId);
    const confirm = request.data?.confirm === true;

    if (!callerDeviceId || !targetDeviceId) {
        throw new HttpsError("invalid-argument", "Missing required device id fields.");
    }

    try {
        const result = await confirmPairingImpl(uid, callerDeviceId, targetDeviceId, confirm);
        logger.info("Pairing confirmation resolved", { uid, targetDeviceId, status: result.status });
        return result;
    } catch (error) {
        if (error instanceof Error) {
            if (error.message === "Only the main device can confirm a new device") {
                throw new HttpsError("permission-denied", error.message);
            }
            if (error.message === "Pending device not found") {
                throw new HttpsError("not-found", error.message);
            }
            if (error.message === "Device is not awaiting confirmation") {
                throw new HttpsError("failed-precondition", error.message);
            }
        }
        logger.error("confirmPairing failed", { uid, targetDeviceId, ...toSafeError(error) });
        throw new HttpsError("internal", "Failed to resolve device confirmation. Please try again.");
    }
});

export const revokeDevice = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const callerDeviceId = getStringValue(request.data?.callerDeviceId);
    const targetDeviceId = getStringValue(request.data?.targetDeviceId);

    if (!callerDeviceId || !targetDeviceId) {
        throw new HttpsError("invalid-argument", "Missing required device id fields.");
    }

    try {
        await revokeDeviceImpl(uid, callerDeviceId, targetDeviceId);
        logger.info("Device revoked", { uid, targetDeviceId });
        return { success: true };
    } catch (error) {
        if (error instanceof Error) {
            if (error.message === "Only the main device can remove a different device") {
                throw new HttpsError("permission-denied", error.message);
            }
            if (error.message === "Cannot remove the main device this way — use device retirement instead") {
                throw new HttpsError("failed-precondition", error.message);
            }
        }
        logger.error("revokeDevice failed", { uid, targetDeviceId, ...toSafeError(error) });
        throw new HttpsError("internal", "Failed to remove device. Please try again.");
    }
});

// ─────────────────────────────────────────────────────────────
// Display Name Backfill (ai_layer/docs/30_display_name_completeness.md §6)
// ─────────────────────────────────────────────────────────────
// One-time historical-data repair, NOT wired into any client UI (see
// displayNameBackfill.ts's own header comment) — meant to be invoked
// manually by a trusted operator (Firebase Console's function tester,
// `firebase functions:shell`, or a one-off authenticated httpsCallable
// call), not on a recurring schedule (the AuthContext.tsx capture-race fix,
// doc 30 §1, is what stops NEW accounts from breaking this way going
// forward — there's nothing new for a scheduled re-run to catch). Unlike
// every other callable in this file, this one has no per-caller scoping at
// all (no uid/groupId of the caller's own to check against) — it scans and
// rewrites the entire users collection. Gated on a custom claim rather than
// plain auth for that reason; set it once for the operator's own account
// via the Admin SDK before invoking, e.g.:
//   admin.auth().setCustomUserClaims('<operator-uid>', { admin: true })
export const runDisplayNameBackfill = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }
    if (request.auth?.token?.admin !== true) {
        throw new HttpsError("permission-denied", "This operation requires admin privileges.");
    }

    try {
        const result = await backfillMissingDisplayNames();
        logger.info("Display name backfill run completed", { uid, ...result });
        return result;
    } catch (error) {
        if (error instanceof HttpsError) {
            throw error;
        }
        logger.error("Display name backfill run failed", { uid, ...toSafeError(error) });
        throw new HttpsError("internal", "Failed to run display name backfill.");
    }
});

// ── Signal prekey publishing / claiming (doc 31 §3.3, Phase 3) ─────────────

export const publishSignalPrekeys = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const deviceId = getStringValue(request.data?.deviceId);
    const bundle = request.data?.bundle;
    if (!deviceId || !bundle || typeof bundle !== "object") {
        throw new HttpsError("invalid-argument", "Missing deviceId or bundle.");
    }

    try {
        return await publishSignalPrekeysImpl(uid, deviceId, bundle as PublishablePrekeyBundle);
    } catch (error) {
        if (error instanceof Error && (
            error.message === "This device is not registered on your account" ||
            error.message === "This device is not confirmed yet"
        )) {
            throw new HttpsError("failed-precondition", error.message);
        }
        logger.error("publishSignalPrekeys failed", { uid, deviceId, ...toSafeError(error) });
        throw new HttpsError("internal", "Failed to publish encryption keys.");
    }
});

export const claimSignalPreKey = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const targetUserId = getStringValue(request.data?.targetUserId);
    const targetDeviceId = getStringValue(request.data?.targetDeviceId);
    if (!targetUserId || !targetDeviceId) {
        throw new HttpsError("invalid-argument", "Missing target user or device id.");
    }

    try {
        return await claimSignalPreKeyImpl(targetUserId, targetDeviceId);
    } catch (error) {
        if (error instanceof Error && error.message === "That device has not published encryption keys yet") {
            throw new HttpsError("failed-precondition", error.message);
        }
        logger.error("claimSignalPreKey failed", { uid, targetUserId, targetDeviceId, ...toSafeError(error) });
        throw new HttpsError("internal", "Failed to fetch encryption keys.");
    }
});

/**
 * Publishes the backup recovery verifier (doc 31 §3.12). Called after every
 * successful backup so the server's copy always describes the backup that
 * actually exists — see accountRecovery.ts for why re-publishing matters.
 */
export const setBackupRecoveryVerifier = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const verifier = getStringValue(request.data?.verifier);
    if (!verifier) {
        throw new HttpsError("invalid-argument", "Missing verifier.");
    }
    try {
        await setBackupRecoveryVerifierImpl(uid, verifier);
        return { status: "ok" };
    } catch (error) {
        if (error instanceof Error && error.message === "Malformed recovery verifier") {
            throw new HttpsError("invalid-argument", error.message);
        }
        logger.error("setBackupRecoveryVerifier failed", { uid, ...toSafeError(error) });
        throw new HttpsError("internal", "Failed to publish the recovery verifier.");
    }
});

/**
 * Whether this account has a recoverable backup. Returns a BOOLEAN only —
 * never the verifier itself, which stays Cloud-Function-readable so stolen
 * credentials can't read the expected value back and replay it.
 */
export const hasBackupRecovery = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    try {
        return await hasBackupRecoveryVerifierImpl(uid);
    } catch (error) {
        logger.error("hasBackupRecovery failed", { uid, ...toSafeError(error) });
        throw new HttpsError("internal", "Failed to check for a backup.");
    }
});

/**
 * Promotes the calling device to main without any existing device's help
 * (doc 31 §3.12) — the escape from the lockout described in
 * accountRecovery.ts's header. Revokes every other device by design.
 */
export const recoverAsNewMainDevice = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const deviceId = getStringValue(request.data?.deviceId);
    if (!deviceId) {
        throw new HttpsError("invalid-argument", "Missing deviceId.");
    }

    try {
        return await recoverAsNewMainDeviceImpl(uid, {
            deviceId,
            verifier: getStringValue(request.data?.verifier) || undefined,
            acknowledgedNoBackup: request.data?.acknowledgedNoBackup === true,
            keepOtherDevices: request.data?.keepOtherDevices === true,
        });
    } catch (error) {
        if (error instanceof Error) {
            // These are user-actionable states, not faults — the client
            // branches its copy on them, so they must survive as codes.
            if (error.message === "BACKUP_PROOF_REQUIRED" ||
                error.message === "BACKUP_PROOF_INVALID" ||
                error.message === "NO_BACKUP_ACKNOWLEDGEMENT_REQUIRED") {
                throw new HttpsError("failed-precondition", error.message);
            }
            if (error.message === "A device id is required") {
                throw new HttpsError("invalid-argument", error.message);
            }
        }
        logger.error("recoverAsNewMainDevice failed", { uid, deviceId, ...toSafeError(error) });
        throw new HttpsError("internal", "Recovery failed.");
    }
});

/**
 * Reverse pairing (doc 31 §3.4, extended 2026-07-25): the MAIN device scanned
 * a code displayed by a new device. Authorizes that specific device to redeem
 * the nonce it is showing. See authorizeScannedDevice for why this binding
 * makes the flow stronger than the forward one, not merely equivalent.
 */
export const authorizeScannedDevice = onCall(async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const code = getStringValue(request.data?.code);
    const deviceId = getStringValue(request.data?.deviceId);
    const platform = getStringValue(request.data?.platform);
    if (!code || !deviceId || (platform !== "ios" && platform !== "android")) {
        throw new HttpsError("invalid-argument", "That QR code isn't a SplitCircle device code.");
    }
    // Both come from a scanned QR, i.e. attacker-controllable input that is
    // about to be stored and later rendered in Linked devices.
    if (!isSafeIdentifier(deviceId) || !isSafeIdentifier(code)) {
        throw new HttpsError("invalid-argument", "That QR code isn't a SplitCircle device code.");
    }

    try {
        return await authorizeScannedDeviceImpl(uid, {
            code,
            deviceId,
            platform,
            deviceName: truncate(getStringValue(request.data?.deviceName), 64) || null,
            modelName: truncate(getStringValue(request.data?.modelName), 64) || null,
        });
    } catch (error) {
        if (error instanceof Error && (
            error.message === "Only a confirmed device can link a new device" ||
            error.message.startsWith("That code is no longer valid")
        )) {
            throw new HttpsError("failed-precondition", error.message);
        }
        logger.error("authorizeScannedDevice failed", { uid, deviceId, ...toSafeError(error) });
        throw new HttpsError("internal", "Couldn't link that device. Please try again.");
    }
});

