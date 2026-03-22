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

const sendExpoPush = async (messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> => {
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

        const result = await response.json() as { data: ExpoPushTicket[] };
        return result.data ?? [];
    } catch (error) {
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

    // Firestore `in` queries support max 30 items
    const chunks: string[][] = [];
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
            const pushToken = data.pushToken as string | undefined;
            const preferences = (data.preferences ?? {}) as Record<string, unknown>;

            const pushEnabled = preferences.pushEnabled === true;
            const categoryEnabled = preferences[category] !== false; // default true
            const mutedChatIds = (preferences.muteChatIds ?? []) as string[];
            const isMuted = chatId ? mutedChatIds.includes(chatId) : false;

            results.push({
                userId: data.userId as string,
                pushToken: pushToken ?? null,
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
