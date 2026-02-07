import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";
import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { AccessToken } from "livekit-server-sdk";

initializeApp();

const LIVEKIT_URL = defineSecret("LIVEKIT_URL");
const LIVEKIT_API_KEY = defineSecret("LIVEKIT_API_KEY");
const LIVEKIT_API_SECRET = defineSecret("LIVEKIT_API_SECRET");

type MaybeCall = {
    chatId?: string;
    status?: string;
    allowedUserIds?: Record<string, boolean>;
};

const getStringValue = (input: unknown): string => {
    return typeof input === "string" ? input.trim() : "";
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

export const generateLiveKitToken = onRequest(
    {
        cors: true,
        secrets: [LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET],
    },
    async (req, res) => {
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
            const participantName = getStringValue(requestBody.name ?? req.query.name) || uid;

            if (!roomName || !chatId) {
                res.status(400).json({ error: "Missing required parameters: roomName, chatId" });
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

            const livekitUrl = LIVEKIT_URL.value();
            const livekitApiKey = LIVEKIT_API_KEY.value();
            const livekitApiSecret = LIVEKIT_API_SECRET.value();

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
            logger.error("Error generating LiveKit token", error);
            res.status(500).json({ error: "Internal server error" });
        }
    }
);
