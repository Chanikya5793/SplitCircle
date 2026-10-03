import { initializeApp } from "firebase-admin/app";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
    authorizeChatAccessImpl,
    createAuthorizedCallImpl,
    mutateAuthorizedCallImpl,
    mutateGroupMemberImpl,
    queueChatMessageImpl,
    reportSafetyIssueImpl,
    setBlockedUserImpl,
} from "./safety";

initializeApp();

const callable = (
    operation: string,
    handler: (uid: string, data: Record<string, unknown>) => Promise<unknown>,
) => onCall({ cors: true, maxInstances: 20 }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
    try {
        return await handler(uid, (request.data ?? {}) as Record<string, unknown>);
    } catch (error) {
        const code = error instanceof Error ? error.message : "UNKNOWN";
        logger.warn(`${operation} rejected`, { uid, code });
        if (code === "RATE_LIMITED") throw new HttpsError("resource-exhausted", "Please slow down and try again.");
        if (code === "USER_BLOCKED") throw new HttpsError("permission-denied", "This interaction is blocked.");
        if (code.includes("REQUIRED") || code.startsWith("NOT_") || code.includes("PROTECTED")) {
            throw new HttpsError("permission-denied", "You do not have permission to do that.");
        }
        if (code.startsWith("INVALID") || code === "CANNOT_BLOCK_SELF" || code === "USE_LEAVE_GROUP") {
            throw new HttpsError("invalid-argument", "The request is invalid.");
        }
        if (code.endsWith("NOT_FOUND")) throw new HttpsError("not-found", "The requested item was not found.");
        logger.error(`${operation} failed`, { uid, code });
        throw new HttpsError("internal", "The request could not be completed.");
    }
});

export const queueChatMessage = callable("queueChatMessage", queueChatMessageImpl);
export const createAuthorizedCall = callable("createAuthorizedCall", createAuthorizedCallImpl);
export const mutateAuthorizedCall = callable("mutateAuthorizedCall", mutateAuthorizedCallImpl);
export const authorizeChatAccess = callable("authorizeChatAccess", authorizeChatAccessImpl);
export const setBlockedUser = callable("setBlockedUser", setBlockedUserImpl);
export const reportSafetyIssue = callable("reportSafetyIssue", reportSafetyIssueImpl);
export const mutateGroupMember = callable("mutateGroupMember", mutateGroupMemberImpl);
