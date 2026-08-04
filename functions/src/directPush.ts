/**
 * Direct APNs / FCM delivery, replacing the Expo relay (ai_layer/docs/36 §6).
 *
 * Every push currently goes through `exp.host`, which sees the notification
 * title and body. That mattered enormously before §3 (they were the message
 * plaintext) and still matters now: it is a third party in the delivery path we
 * do not control, subject to its own rate limits, and it costs an extra
 * round trip for receipts.
 *
 * PER-DEVICE, NOT A FLAG DAY. A device is sent direct the moment it has a
 * native token on file, and via Expo until then. No install has ever stored a
 * native token (collection only shipped 2026-08-03), so a global switch would
 * silently stop notifications for every device that had not checked in since.
 * This makes the cutover happen device by device as tokens arrive, with no
 * coordination and no window where anyone goes dark.
 *
 * The APNs half reuses `voipPush.ts`'s proven token-based `.p8` setup,
 * including its dual sandbox/production retry — `BadDeviceToken` is returned
 * both for an environment mismatch and for a genuinely dead token, so the other
 * gateway must be tried before concluding anything (CLAUDE.md).
 */
import apn from "@parse/node-apn";
import { getMessaging } from "firebase-admin/messaging";
import * as logger from "firebase-functions/logger";

import {
    apnsAuthKeySecret,
    apnsBundleIdSecret,
    apnsKeyIdSecret,
    apnsTeamIdSecret,
    apnsUseSandboxSecret,
} from "./voipPush";

export interface DirectPushTarget {
    platform: "ios" | "android";
    nativeToken: string;
    title: string;
    subtitle?: string;
    body: string;
    data: Record<string, string>;
    /** iOS: allows the Notification Service Extension to rewrite the body. */
    mutableContent?: boolean;
    channelId?: string;
    /**
     * Android only. Data-only FCM wakes Expo's background task, which can open
     * an encrypted preview before posting the one visible notification.
     */
    dataOnly?: boolean;
}

export interface DirectPushResult {
    sent: number;
    failed: number;
    /** Tokens APNs/FCM reported as permanently dead — callers should clear them. */
    invalidTokens: string[];
}

const providerCache = new Map<boolean, apn.Provider>();
let cachedCreds: { key: string; keyId: string; teamId: string } | null = null;

const getProvider = (production: boolean): apn.Provider | null => {
    const key = apnsAuthKeySecret.value();
    const keyId = apnsKeyIdSecret.value();
    const teamId = apnsTeamIdSecret.value();
    if (!key || !keyId || !teamId) return null;

    if (!cachedCreds || cachedCreds.key !== key || cachedCreds.keyId !== keyId
        || cachedCreds.teamId !== teamId) {
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

/** Reasons that mean "wrong gateway", not "dead token". Same list as voipPush. */
const ENV_MISMATCH = new Set([
    "BadEnvironmentKeyInToken",
    "BadDeviceToken",
    "DeviceTokenNotForTopic",
]);

/** Reasons that mean the token will never work again. */
const PERMANENTLY_DEAD = new Set(["Unregistered", "BadDeviceToken"]);

const sendApns = async (targets: DirectPushTarget[]): Promise<DirectPushResult> => {
    const result: DirectPushResult = { sent: 0, failed: 0, invalidTokens: [] };
    const bundleId = apnsBundleIdSecret.value();
    if (!bundleId) return result;

    const preferSandbox = ["true", "1"].includes(apnsUseSandboxSecret.value());

    for (const target of targets) {
        const note = new apn.Notification();
        note.topic = bundleId;
        // iOS 13+ requires APNs push-type classification. APNs can infer
        // `alert` from aps.alert, but a Notification Service Extension is too
        // important to rely on that inference: an explicitly-classified alert
        // is the documented route for mutable-content delivery.
        note.pushType = "alert";
        note.alert = {
            title: target.title,
            ...(target.subtitle ? { subtitle: target.subtitle } : {}),
            body: target.body,
        };
        note.sound = "default";
        note.payload = target.data;
        if (target.mutableContent) {
            // `mutable-content` invokes the NSE before iOS renders the alert.
            // Do not add `content-available`: this is an alert push, not a
            // silent/background push, and Apple documents the NSE contract as
            // alert + mutable-content.
            note.mutableContent = true;
        }

        // Preferred gateway first, then the other. Doing this per notification
        // rather than caching a verdict per token: a device can move between
        // environments across builds (TestFlight vs a local dev install).
        let delivered = false;
        for (const production of [!preferSandbox, preferSandbox]) {
            const provider = getProvider(production);
            if (!provider) break;
            const response = await provider.send(note, target.nativeToken);
            if (response.sent.length > 0) { delivered = true; break; }

            const reason = response.failed[0]?.response?.reason;
            if (reason && !ENV_MISMATCH.has(reason)) {
                if (PERMANENTLY_DEAD.has(reason)) result.invalidTokens.push(target.nativeToken);
                break;
            }
            // Env mismatch: fall through and try the other gateway.
            if (reason && PERMANENTLY_DEAD.has(reason) && production === preferSandbox) {
                result.invalidTokens.push(target.nativeToken);
            }
        }
        if (delivered) result.sent += 1; else result.failed += 1;
    }
    return result;
};

const sendFcm = async (targets: DirectPushTarget[]): Promise<DirectPushResult> => {
    const result: DirectPushResult = { sent: 0, failed: 0, invalidTokens: [] };
    if (targets.length === 0) return result;

    const response = await getMessaging().sendEach(
        targets.map((target) => ({
            token: target.nativeToken,
            // Android renders a `notification` payload itself while the app is
            // backgrounded. That races ahead of JS and permanently exposes the
            // generic fallback instead of the decrypted preview. Message
            // pushes use data-only delivery and are presented locally instead.
            ...(target.dataOnly ? {} : { notification: { title: target.title, body: target.body } }),
            data: target.data,
            android: {
                priority: "high" as const,
                // Do not add Android-specific presentation fields either:
                // they can turn an otherwise data-only message into an OS
                // notification before the encrypted preview is available.
                ...(target.dataOnly ? {} : {
                    notification: {
                        ...(target.channelId ? { channelId: target.channelId } : {}),
                        sound: "default",
                    },
                }),
            },
        })),
    );

    response.responses.forEach((entry, index) => {
        if (entry.success) { result.sent += 1; return; }
        result.failed += 1;
        const code = entry.error?.code ?? "";
        // The two codes that mean the token is dead rather than the send failing.
        if (code === "messaging/registration-token-not-registered"
            || code === "messaging/invalid-registration-token") {
            result.invalidTokens.push(targets[index].nativeToken);
        }
    });
    return result;
};

/**
 * Sends to whatever native tokens are supplied, splitting by platform.
 *
 * Never throws: a direct-send failure must fall back to Expo rather than lose
 * the notification, so the caller needs a result it can act on, not an
 * exception.
 */
export const sendDirectPush = async (
    targets: DirectPushTarget[],
): Promise<DirectPushResult> => {
    const merged: DirectPushResult = { sent: 0, failed: 0, invalidTokens: [] };
    if (targets.length === 0) return merged;

    for (const [platform, send] of [
        ["ios", sendApns],
        ["android", sendFcm],
    ] as const) {
        const slice = targets.filter((t) => t.platform === platform);
        if (slice.length === 0) continue;
        try {
            const outcome = await send(slice);
            merged.sent += outcome.sent;
            merged.failed += outcome.failed;
            merged.invalidTokens.push(...outcome.invalidTokens);
        } catch (error) {
            merged.failed += slice.length;
            logger.error("sendDirectPush failed", {
                platform,
                count: slice.length,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return merged;
};
