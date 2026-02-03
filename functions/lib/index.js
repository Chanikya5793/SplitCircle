"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateLiveKitToken = void 0;
const https_1 = require("firebase-functions/v2/https");
const livekit_server_sdk_1 = require("livekit-server-sdk");
// Credentials provided by user
// In a production environment, these should be set as environment variables using:
// firebase functions:config:set livekit.url="..." livekit.key="..." livekit.secret="..."
const LIVEKIT_URL = "wss://splitcircle-384jelrz.livekit.cloud";
const LIVEKIT_API_KEY = "APIbcH83GPmyiZJ";
const LIVEKIT_API_SECRET = "tLefQOporSrezRfJtOsiFK6LqFPkypGAhuGxBlkXfQpA";
exports.generateLiveKitToken = (0, https_1.onRequest)({ cors: true }, async (req, res) => {
    // Gen 2 handles CORS automatically with { cors: true } above!
    try {
        const roomName = req.query.roomName || req.body.roomName;
        const participantName = req.query.name || req.body.name;
        const identity = req.query.identity || req.body.identity;
        if (!roomName || !identity) {
            res.status(400).json({ error: "Missing required parameters: roomName, identity" });
            return;
        }
        const at = new livekit_server_sdk_1.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity: identity,
            name: participantName || identity,
        });
        at.addGrant({
            roomJoin: true,
            room: roomName,
            canPublish: true,
            canSubscribe: true,
        });
        const token = await at.toJwt();
        res.json({
            token,
            url: LIVEKIT_URL,
        });
    }
    catch (error) {
        console.error("Error generating token:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});
//# sourceMappingURL=index.js.map