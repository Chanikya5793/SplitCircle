import apn from "@parse/node-apn";
import { getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";

// Secrets — set via `firebase functions:secrets:set <name>` and bound on the
// functions that consume them. Never read .env or commit values to the repo.
export const apnsAuthKeySecret = defineSecret("APNS_AUTH_KEY");
export const apnsKeyIdSecret = defineSecret("APNS_KEY_ID");
export const apnsTeamIdSecret = defineSecret("APNS_TEAM_ID");
export const apnsBundleIdSecret = defineSecret("APNS_BUNDLE_ID");
// Set to "true" for sandbox (development builds), "false" or unset for production.
export const apnsUseSandboxSecret = defineSecret("APNS_USE_SANDBOX");

export const voipPushSecrets = [
    apnsAuthKeySecret,
    apnsKeyIdSecret,
    apnsTeamIdSecret,
    apnsBundleIdSecret,
    apnsUseSandboxSecret,
];

const USER_COLLECTION = "users";
const DEVICE_COLLECTION = "notificationDevices";

interface VoipDevice {
    deviceId: string;
    voipPushToken: string;
    bundleId?: string;
}

let cachedProvider: apn.Provider | null = null;
let cachedKey: string | null = null;
let cachedKeyId: string | null = null;
let cachedTeamId: string | null = null;
let cachedSandbox: boolean | null = null;

const getProvider = (): apn.Provider | null => {
    const key = apnsAuthKeySecret.value();
    const keyId = apnsKeyIdSecret.value();
    const teamId = apnsTeamIdSecret.value();
    const sandboxRaw = apnsUseSandboxSecret.value();
    const sandbox = sandboxRaw === "true" || sandboxRaw === "1";

    if (!key || !keyId || !teamId) {
        logger.warn("voipPush: APNs secrets not configured; skipping VoIP push.");
        return null;
    }

    const sameConfig =
        cachedProvider !== null &&
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

    cachedProvider = new apn.Provider({
        token: { key, keyId, teamId },
        production: !sandbox,
    });
    cachedKey = key;
    cachedKeyId = keyId;
    cachedTeamId = teamId;
    cachedSandbox = sandbox;
    return cachedProvider;
};

const collectVoipDevices = async (userIds: string[]): Promise<VoipDevice[]> => {
    if (userIds.length === 0) {
        return [];
    }

    const db = getFirestore();
    const devices: VoipDevice[] = [];

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
            if (token.length === 0) return;
            devices.push({
                deviceId: doc.id,
                voipPushToken: token,
                bundleId: typeof data.voipBundleId === "string" ? data.voipBundleId : undefined,
            });
        });
    }));

    return devices;
};

interface SendCallVoipPushArgs {
    callId: string;
    chatId: string;
    groupId?: string;
    initiatorId: string;
    initiatorName: string;
    callType: "audio" | "video";
    recipientUserIds: string[];
    handle?: string;
}

export const sendCallVoipPush = async (args: SendCallVoipPushArgs): Promise<{ accepted: number; failed: number }> => {
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

    const defaultBundleId = apnsBundleIdSecret.value();
    if (!defaultBundleId) {
        logger.warn("voipPush: APNS_BUNDLE_ID secret not set; skipping VoIP push.");
        return { accepted: 0, failed: 0 };
    }

    let accepted = 0;
    let failed = 0;

    await Promise.all(devices.map(async (device) => {
        // Topic for VoIP pushes is `<bundleId>.voip`.
        const topic = `${device.bundleId ?? defaultBundleId}.voip`;

        const notification = new apn.Notification();
        notification.topic = topic;
        notification.expiry = Math.floor(Date.now() / 1000) + 30; // ringing window
        notification.priority = 10;
        notification.pushType = "voip";
        notification.payload = {
            // The AppDelegate handler reads these fields. Keep keys stable.
            uuid: args.callId,
            callId: args.callId,
            chatId: args.chatId,
            groupId: args.groupId ?? null,
            callerName: args.initiatorName,
            initiatorId: args.initiatorId,
            initiatorName: args.initiatorName,
            callType: args.callType,
            hasVideo: args.callType === "video",
            handle: args.handle ?? args.chatId,
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
                        error: failure.error?.message,
                    });

                    // 410 Gone or BadDeviceToken => token is dead, scrub it.
                    const isGone =
                        String(failure.status) === "410" ||
                        failure.response?.reason === "BadDeviceToken" ||
                        failure.response?.reason === "Unregistered";
                    if (isGone) {
                        await scrubDeadVoipToken(args.recipientUserIds, device.deviceId, device.voipPushToken);
                    }
                }
            }
        } catch (error) {
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

const scrubDeadVoipToken = async (userIds: string[], deviceId: string, token: string) => {
    const db = getFirestore();
    await Promise.all(userIds.map(async (userId) => {
        const ref = db
            .collection(USER_COLLECTION)
            .doc(userId)
            .collection(DEVICE_COLLECTION)
            .doc(deviceId);
        const snap = await ref.get();
        if (!snap.exists) return;
        if (snap.data()?.voipPushToken === token) {
            await ref.update({ voipPushToken: null, voipPushTokenInvalidatedAt: Date.now() });
        }
    }));
};

interface UpsertVoipTokenArgs {
    userId: string;
    deviceId: string;
    voipPushToken: string;
    bundleId?: string;
    platform?: string;
}

export const upsertVoipTokenForDevice = async (args: UpsertVoipTokenArgs): Promise<void> => {
    const db = getFirestore();
    const ref = db
        .collection(USER_COLLECTION)
        .doc(args.userId)
        .collection(DEVICE_COLLECTION)
        .doc(args.deviceId);

    await ref.set({
        voipPushToken: args.voipPushToken,
        voipBundleId: args.bundleId ?? null,
        voipPlatform: args.platform ?? "ios",
        voipPushTokenUpdatedAt: Date.now(),
    }, { merge: true });
};
