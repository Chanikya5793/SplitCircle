import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

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

type NotificationCategory =
    | "messages"
    | "expenses"
    | "settlements"
    | "groupUpdates"
    | "calls";

interface UserNotificationInfo {
    userId: string;
    pushToken: string | null;
    pushEnabled: boolean;
    categoryEnabled: boolean;
    isMuted: boolean;
}

// ─────────────────────────────────────────────────────────────
// Expo Push API
// ─────────────────────────────────────────────────────────────

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_MAX_BATCH_SIZE = 100;

const isExpoPushToken = (value: string): boolean => {
    return /^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/.test(value);
};

const chunkArray = <T>(input: T[], size: number): T[][] => {
    if (input.length === 0) return [];
    const result: T[][] = [];
    for (let i = 0; i < input.length; i += size) {
        result.push(input.slice(i, i + size));
    }
    return result;
};

const sendExpoPush = async (messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> => {
    if (messages.length === 0) {
        return [];
    }

    const tickets: ExpoPushTicket[] = [];
    const batches = chunkArray(messages, EXPO_MAX_BATCH_SIZE);

    for (const batch of batches) {
        try {
            const response = await fetch(EXPO_PUSH_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                body: JSON.stringify(batch),
            });

            if (!response.ok) {
                logger.error("Expo push API returned error status", {
                    status: response.status,
                    statusText: response.statusText,
                    batchSize: batch.length,
                });
                continue;
            }

            const result = await response.json() as { data: ExpoPushTicket[] };
            tickets.push(...(result.data ?? []));
        } catch (error) {
            logger.error("Failed to call Expo push API", {
                message: error instanceof Error ? error.message : "Unknown error",
                batchSize: batch.length,
            });
        }
    }

    return tickets;
};

// ─────────────────────────────────────────────────────────────
// User Token Lookup
// ─────────────────────────────────────────────────────────────

/**
 * Look up push tokens and notification preferences for a list of user IDs.
 * Filters out users who have push disabled or the specific category disabled,
 * and respects muted chat IDs.
 */
export const getEligibleRecipients = async (
    userIds: string[],
    category: NotificationCategory,
    chatId?: string,
): Promise<UserNotificationInfo[]> => {
    if (userIds.length === 0) {
        return [];
    }

    const db = getFirestore();
    const results: UserNotificationInfo[] = [];

    // getAll supports up to 100 document refs per call.
    const chunks = chunkArray(userIds, 100);

    for (const chunk of chunks) {
        const refs = chunk.map((userId) => db.collection("users").doc(userId));
        const docs = await db.getAll(...refs);

        for (let index = 0; index < docs.length; index += 1) {
            const userDoc = docs[index];
            if (!userDoc.exists) {
                continue;
            }

            const requestedUserId = chunk[index];
            const data = userDoc.data() ?? {};
            const preferences = (data.preferences ?? {}) as Record<string, unknown>;
            const tokenRaw = typeof data.pushToken === "string" ? data.pushToken.trim() : "";
            const mutedChatIdsRaw = preferences.muteChatIds;
            const mutedChatIds = Array.isArray(mutedChatIdsRaw)
                ? mutedChatIdsRaw.filter((value): value is string => typeof value === "string")
                : [];

            const pushEnabled = preferences.pushEnabled === true;
            const categoryEnabled = preferences[category] !== false; // default true
            const isMuted = chatId ? mutedChatIds.includes(chatId) : false;

            results.push({
                userId: requestedUserId,
                pushToken: isExpoPushToken(tokenRaw) ? tokenRaw : null,
                pushEnabled,
                categoryEnabled,
                isMuted,
            });
        }
    }

    return results;
};

// ─────────────────────────────────────────────────────────────
// High-Level Send Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Send push notifications to a list of user IDs, respecting their preferences.
 * Returns the number of notifications actually sent.
 */
export const sendPushToUsers = async (
    userIds: string[],
    title: string,
    body: string,
    data: Record<string, string>,
    category: NotificationCategory,
    chatId?: string,
    channelId?: string,
): Promise<number> => {
    const recipients = await getEligibleRecipients(userIds, category, chatId);

    const messages: ExpoPushMessage[] = recipients
        .filter((r) => r.pushToken && r.pushEnabled && r.categoryEnabled && !r.isMuted)
        .map((r) => ({
            to: r.pushToken!,
            title,
            body,
            data,
            sound: "default" as const,
            priority: "high" as const,
            channelId: channelId ?? mapCategoryToChannel(category),
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

/**
 * Map notification category to Android channel ID.
 */
const mapCategoryToChannel = (category: NotificationCategory): string => {
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
