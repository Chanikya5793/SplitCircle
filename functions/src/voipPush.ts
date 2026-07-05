import apn from "@parse/node-apn";
import { getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { v5 as uuidv5 } from "uuid";

// MUST match the client (src/services/nativeCallService.ts). CallKit requires a
// valid RFC-4122 UUID; deriving it deterministically from the callId means the
// native VoIP push and the in-app JS path report the SAME CallKit identity.
const CALL_UUID_NAMESPACE = "6f9b8e2a-1c3d-4b5e-8a7f-0d1e2c3b4a59";
const nativeUuidForCall = (callId: string): string => uuidv5(callId, CALL_UUID_NAMESPACE);

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

// One provider per APNs environment (production vs sandbox). Token-based (.p8)
// auth lets the SAME key authenticate against both gateways, so we can try the
// other environment when a token is rejected for env mismatch — that's what
// makes VoIP work whether the installed build is a dev (sandbox) or a
// production/TestFlight/store build without any secret juggling.
const providerCache = new Map<boolean, apn.Provider>();
let cachedCreds: { key: string; keyId: string; teamId: string } | null = null;

/** Whichever environment the APNS_USE_SANDBOX secret prefers, tried FIRST. */
const prefersSandbox = (): boolean => {
    const raw = apnsUseSandboxSecret.value();
    return raw === "true" || raw === "1";
};

/** Provider for a specific environment; caches and rebuilds on cred rotation. */
const getProvider = (production: boolean): apn.Provider | null => {
    const key = apnsAuthKeySecret.value();
    const keyId = apnsKeyIdSecret.value();
    const teamId = apnsTeamIdSecret.value();

    if (!key || !keyId || !teamId) {
        logger.warn("voipPush: APNs secrets not configured; skipping VoIP push.");
        return null;
    }

    if (!cachedCreds || cachedCreds.key !== key || cachedCreds.keyId !== keyId || cachedCreds.teamId !== teamId) {
        for (const p of providerCache.values()) p.shutdown();
        providerCache.clear();
        cachedCreds = { key, keyId, teamId };
    }

    let provider = providerCache.get(production);
    if (!provider) {
        provider = new apn.Provider({ token: { key, keyId, teamId }, production });
        providerCache.set(production, provider);
    }
    return provider;
};

// APNs rejection reasons that mean "wrong environment" — retry the other
// gateway before giving up. `BadDeviceToken` is famously ambiguous: APNs
// returns it both for env mismatch AND for genuinely dead tokens, so we retry
// the other env first and only scrub if BOTH environments reject.
const ENV_MISMATCH_REASONS = new Set(["BadDeviceToken", "BadEnvironmentKeyInToken"]);
// Reasons that mean the token is permanently dead regardless of environment.
const DEAD_TOKEN_REASONS = new Set(["Unregistered", "DeviceTokenNotForTopic"]);

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
    // Try the preferred environment first, then fall back to the other one.
    const preferProduction = !prefersSandbox();
    if (!getProvider(preferProduction)) {
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
            // `uuid` MUST be a valid RFC-4122 UUID or CallKit silently refuses
            // to present the call — derive it deterministically from callId.
            uuid: nativeUuidForCall(args.callId),
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

        // Send against one environment; returns 'sent' | reason string | 'error'.
        const sendVia = async (production: boolean): Promise<"sent" | string> => {
            const provider = getProvider(production);
            if (!provider) return "no-provider";
            try {
                const result = await provider.send(notification, device.voipPushToken);
                if (result.sent.length > 0) return "sent";
                const failure = result.failed[0];
                return failure?.response?.reason ?? String(failure?.status ?? "unknown");
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        };

        // 1) Preferred environment. 2) On an env-mismatch reason, retry the
        //    other gateway (same .p8 key works for both). Scrub only when the
        //    token is dead in the environment(s) we actually reached.
        let reason = await sendVia(preferProduction);
        if (reason !== "sent" && ENV_MISMATCH_REASONS.has(reason)) {
            const fallbackReason = await sendVia(!preferProduction);
            if (fallbackReason === "sent") {
                reason = "sent";
            } else {
                logger.warn("voipPush: rejected in both environments", {
                    callId: args.callId,
                    deviceId: device.deviceId,
                    preferred: reason,
                    fallback: fallbackReason,
                });
                // Dead in both environments → the token is genuinely gone.
                if (ENV_MISMATCH_REASONS.has(fallbackReason) || DEAD_TOKEN_REASONS.has(fallbackReason)) {
                    await scrubDeadVoipToken(args.recipientUserIds, device.deviceId, device.voipPushToken);
                }
                reason = fallbackReason;
            }
        } else if (reason !== "sent") {
            logger.warn("voipPush: APNs rejected token", {
                callId: args.callId,
                deviceId: device.deviceId,
                reason,
            });
            if (DEAD_TOKEN_REASONS.has(reason)) {
                await scrubDeadVoipToken(args.recipientUserIds, device.deviceId, device.voipPushToken);
            }
        }

        if (reason === "sent") accepted += 1;
        else failed += 1;
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
