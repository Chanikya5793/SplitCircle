import { onRequest } from "firebase-functions/v2/https";
import { AccessToken } from "livekit-server-sdk";

// Credentials provided by user
// In a production environment, these should be set as environment variables using:
// firebase functions:config:set livekit.url="..." livekit.key="..." livekit.secret="..."
const LIVEKIT_URL = "wss://splitcircle-384jelrz.livekit.cloud";
const LIVEKIT_API_KEY = "APIbcH83GPmyiZJ";
const LIVEKIT_API_SECRET = "tLefQOporSrezRfJtOsiFK6LqFPkypGAhuGxBlkXfQpA";

export const generateLiveKitToken = onRequest({ cors: true }, async (req, res) => {
    // Gen 2 handles CORS automatically with { cors: true } above!

    try {
        const roomName = req.query.roomName as string || req.body.roomName;
        const participantName = req.query.name as string || req.body.name;
        const identity = req.query.identity as string || req.body.identity;

        if (!roomName || !identity) {
            res.status(400).json({ error: "Missing required parameters: roomName, identity" });
            return;
        }

        const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
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
    } catch (error) {
        console.error("Error generating token:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});
