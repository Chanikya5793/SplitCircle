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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertVoipTokenForDevice = exports.sendCallVoipPush = exports.voipPushSecrets = exports.apnsUseSandboxSecret = exports.apnsBundleIdSecret = exports.apnsTeamIdSecret = exports.apnsKeyIdSecret = exports.apnsAuthKeySecret = void 0;
const node_apn_1 = __importDefault(require("@parse/node-apn"));
const firestore_1 = require("firebase-admin/firestore");
const params_1 = require("firebase-functions/params");
const logger = __importStar(require("firebase-functions/logger"));
// Secrets — set via `firebase functions:secrets:set <name>` and bound on the
// functions that consume them. Never read .env or commit values to the repo.
exports.apnsAuthKeySecret = (0, params_1.defineSecret)("APNS_AUTH_KEY");
exports.apnsKeyIdSecret = (0, params_1.defineSecret)("APNS_KEY_ID");
exports.apnsTeamIdSecret = (0, params_1.defineSecret)("APNS_TEAM_ID");
exports.apnsBundleIdSecret = (0, params_1.defineSecret)("APNS_BUNDLE_ID");
// Set to "true" for sandbox (development builds), "false" or unset for production.
exports.apnsUseSandboxSecret = (0, params_1.defineSecret)("APNS_USE_SANDBOX");
exports.voipPushSecrets = [
    exports.apnsAuthKeySecret,
    exports.apnsKeyIdSecret,
    exports.apnsTeamIdSecret,
    exports.apnsBundleIdSecret,
    exports.apnsUseSandboxSecret,
];
const USER_COLLECTION = "users";
const DEVICE_COLLECTION = "notificationDevices";
let cachedProvider = null;
let cachedKey = null;
let cachedKeyId = null;
let cachedTeamId = null;
let cachedSandbox = null;
const getProvider = () => {
    const key = exports.apnsAuthKeySecret.value();
    const keyId = exports.apnsKeyIdSecret.value();
    const teamId = exports.apnsTeamIdSecret.value();
    const sandboxRaw = exports.apnsUseSandboxSecret.value();
    const sandbox = sandboxRaw === "true" || sandboxRaw === "1";
    if (!key || !keyId || !teamId) {
        logger.warn("voipPush: APNs secrets not configured; skipping VoIP push.");
        return null;
    }
    const sameConfig = cachedProvider !== null &&
        cachedKey === key &&
        cachedKeyId === keyId &&
        cachedTeamId === teamId &&
        cachedSandbox === sandbox;
    if (sameConfig) {
        return cachedProvider;
    }
    if (cachedProvider) {
        cachedProvider.shutdown();
    }
    cachedProvider = new node_apn_1.default.Provider({
        token: { key, keyId, teamId },
        production: !sandbox,
    });
    cachedKey = key;
    cachedKeyId = keyId;
    cachedTeamId = teamId;
    cachedSandbox = sandbox;
    return cachedProvider;
};
const collectVoipDevices = async (userIds) => {
    if (userIds.length === 0) {
        return [];
    }
    const db = (0, firestore_1.getFirestore)();
    const devices = [];
    await Promise.all(userIds.map(async (userId) => {
        const snapshot = await db
            .collection(USER_COLLECTION)
            .doc(userId)
            .collection(DEVICE_COLLECTION)
            .where("voipPushToken", "!=", null)
            .get();
        snapshot.forEach((doc) => {
            const data = doc.data();
            const token = typeof data.voipPushToken === "string" ? data.voipPushToken.trim() : "";
            if (token.length === 0)
                return;
            devices.push({
                deviceId: doc.id,
                voipPushToken: token,
                bundleId: typeof data.voipBundleId === "string" ? data.voipBundleId : undefined,
            });
        });
    }));
    return devices;
};
const sendCallVoipPush = async (args) => {
    const provider = getProvider();
    if (!provider) {
        return { accepted: 0, failed: 0 };
    }
    const devices = await collectVoipDevices(args.recipientUserIds);
    if (devices.length === 0) {
        logger.info("voipPush: no VoIP-registered devices for recipients", {
            callId: args.callId,
            recipientCount: args.recipientUserIds.length,
        });
        return { accepted: 0, failed: 0 };
    }
    const defaultBundleId = exports.apnsBundleIdSecret.value();
    if (!defaultBundleId) {
        logger.warn("voipPush: APNS_BUNDLE_ID secret not set; skipping VoIP push.");
        return { accepted: 0, failed: 0 };
    }
    let accepted = 0;
    let failed = 0;
    await Promise.all(devices.map(async (device) => {
        var _a, _b, _c, _d, _e, _f;
        // Topic for VoIP pushes is `<bundleId>.voip`.
        const topic = `${(_a = device.bundleId) !== null && _a !== void 0 ? _a : defaultBundleId}.voip`;
        const notification = new node_apn_1.default.Notification();
        notification.topic = topic;
        notification.expiry = Math.floor(Date.now() / 1000) + 30; // ringing window
        notification.priority = 10;
        notification.pushType = "voip";
        notification.payload = {
            // The AppDelegate handler reads these fields. Keep keys stable.
            uuid: args.callId,
            callId: args.callId,
            chatId: args.chatId,
            groupId: (_b = args.groupId) !== null && _b !== void 0 ? _b : null,
            callerName: args.initiatorName,
            initiatorId: args.initiatorId,
            initiatorName: args.initiatorName,
            callType: args.callType,
            hasVideo: args.callType === "video",
            handle: (_c = args.handle) !== null && _c !== void 0 ? _c : args.chatId,
        };
        try {
            const result = await provider.send(notification, device.voipPushToken);
            accepted += result.sent.length;
            failed += result.failed.length;
            if (result.failed.length > 0) {
                for (const failure of result.failed) {
                    logger.warn("voipPush: APNs rejected token", {
                        callId: args.callId,
                        deviceId: device.deviceId,
                        status: failure.status,
                        response: failure.response,
                        error: (_d = failure.error) === null || _d === void 0 ? void 0 : _d.message,
                    });
                    // 410 Gone or BadDeviceToken => token is dead, scrub it.
                    const isGone = String(failure.status) === "410" ||
                        ((_e = failure.response) === null || _e === void 0 ? void 0 : _e.reason) === "BadDeviceToken" ||
                        ((_f = failure.response) === null || _f === void 0 ? void 0 : _f.reason) === "Unregistered";
                    if (isGone) {
                        await scrubDeadVoipToken(args.recipientUserIds, device.deviceId, device.voipPushToken);
                    }
                }
            }
        }
        catch (error) {
            failed += 1;
            logger.error("voipPush: send failed", {
                callId: args.callId,
                deviceId: device.deviceId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }));
    logger.info("voipPush: dispatch complete", {
        callId: args.callId,
        accepted,
        failed,
        deviceCount: devices.length,
    });
    return { accepted, failed };
};
exports.sendCallVoipPush = sendCallVoipPush;
const scrubDeadVoipToken = async (userIds, deviceId, token) => {
    const db = (0, firestore_1.getFirestore)();
    await Promise.all(userIds.map(async (userId) => {
        var _a;
        const ref = db
            .collection(USER_COLLECTION)
            .doc(userId)
            .collection(DEVICE_COLLECTION)
            .doc(deviceId);
        const snap = await ref.get();
        if (!snap.exists)
            return;
        if (((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.voipPushToken) === token) {
            await ref.update({ voipPushToken: null, voipPushTokenInvalidatedAt: Date.now() });
        }
    }));
};
const upsertVoipTokenForDevice = async (args) => {
    var _a, _b;
    const db = (0, firestore_1.getFirestore)();
    const ref = db
        .collection(USER_COLLECTION)
        .doc(args.userId)
        .collection(DEVICE_COLLECTION)
        .doc(args.deviceId);
    await ref.set({
        voipPushToken: args.voipPushToken,
        voipBundleId: (_a = args.bundleId) !== null && _a !== void 0 ? _a : null,
        voipPlatform: (_b = args.platform) !== null && _b !== void 0 ? _b : "ios",
        voipPushTokenUpdatedAt: Date.now(),
    }, { merge: true });
};
exports.upsertVoipTokenForDevice = upsertVoipTokenForDevice;
//# sourceMappingURL=voipPush.js.map