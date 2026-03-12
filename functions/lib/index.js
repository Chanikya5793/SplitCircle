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
exports.generateLiveKitToken = exports.triggerRecurringBillsForGroup = exports.runRecurringBillsScheduler = void 0;
const app_1 = require("firebase-admin/app");
const auth_1 = require("firebase-admin/auth");
const database_1 = require("firebase-admin/database");
const firestore_1 = require("firebase-admin/firestore");
const logger = __importStar(require("firebase-functions/logger"));
const params_1 = require("firebase-functions/params");
const https_1 = require("firebase-functions/v2/https");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const livekit_server_sdk_1 = require("livekit-server-sdk");
const recurringBills_1 = require("./recurringBills");
(0, app_1.initializeApp)();
const livekitUrlSecret = (0, params_1.defineSecret)("LIVEKIT_URL");
const livekitApiKeySecret = (0, params_1.defineSecret)("LIVEKIT_API_KEY");
const livekitApiSecretSecret = (0, params_1.defineSecret)("LIVEKIT_API_SECRET");
const getStringValue = (input) => {
    return typeof input === "string" ? input.trim() : "";
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
        res.status(200).json({ token, url: livekitUrl });
    }
    catch (error) {
        logger.error("Error generating LiveKit token", toSafeError(error));
        res.status(500).json({ error: "Internal server error" });
    }
});
//# sourceMappingURL=index.js.map