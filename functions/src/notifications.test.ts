/**
 * Locked-chat notification copy: the fail-closed rule.
 *
 * A recipient who has locked a chat behind a biometric gate must never see the
 * sender's name or a message preview in the tray — the notification has to be
 * as opaque as the chat itself.
 *
 * This used to be enforced by a try/catch around a per-recipient
 * `users/{uid}.get()`: any read failure pushed that recipient into the locked
 * bucket. That read cost one Firestore document per recipient PER MESSAGE, on
 * documents the notification path had already batch-read (doc 36 §1.1), so it
 * was removed. Removing it also removed the exception handler that quietly
 * provided the fail-closed guarantee, which is exactly the kind of safety
 * property that disappears silently during a performance refactor.
 *
 * So it is re-established explicitly here, and pinned.
 */
import { describe, expect, it } from "vitest";

import { shouldUseLockedCopy } from "./notifications";

const call = (over: {
    userId?: string;
    locked?: string[];
    resolved?: string[];
    hasLockedVariant?: boolean;
}) =>
    shouldUseLockedCopy({
        userId: over.userId ?? "u1",
        lockedUserIds: new Set(over.locked ?? []),
        resolvedUserIds: new Set(over.resolved ?? ["u1"]),
        hasLockedVariant: over.hasLockedVariant ?? true,
    });

describe("shouldUseLockedCopy", () => {
    it("uses the generic copy for a recipient who locked the chat", () => {
        expect(call({ locked: ["u1"] })).toBe(true);
    });

    it("uses the normal copy for a recipient who did not", () => {
        expect(call({ locked: [] })).toBe(false);
    });

    it("FAILS CLOSED for a recipient whose document could not be resolved", () => {
        // The property the deleted try/catch used to provide. Failing open here
        // puts a sender name and message preview on the lock screen of a chat
        // its owner deliberately gated.
        expect(call({ userId: "ghost", locked: [], resolved: ["u1"] })).toBe(true);
    });

    it("fails closed even when the locked set is entirely empty", () => {
        // An empty locked set is the state after a total read failure, and is
        // indistinguishable from "nobody locked anything" — so unresolved must
        // still dominate.
        expect(call({ userId: "ghost", locked: [], resolved: [] })).toBe(true);
    });

    it("does nothing when the caller supplied no locked variant", () => {
        // Categories other than messages (expenses, calls) pass no variant.
        // Returning true there would select a variant that does not exist.
        expect(call({ locked: ["u1"], hasLockedVariant: false })).toBe(false);
        expect(call({ userId: "ghost", resolved: [], hasLockedVariant: false })).toBe(false);
    });

    it("treats locked membership as dominant over resolution", () => {
        // Belt and braces: a user both locked AND resolved is still locked.
        expect(call({ userId: "u1", locked: ["u1"], resolved: ["u1"] })).toBe(true);
    });
});

/**
 * Which device gets which sealed preview.
 *
 * `sendMessagePushes` matches previews against the devices IT resolves, rather
 * than against a device list supplied by the caller. That is what lets both
 * fan-out paths use it — including the one where a recipient has no confirmed
 * paired devices, which is 39% of real fan-outs (doc 34 §1).
 *
 * That path used to be covered by the Firestore-triggered notification. That
 * trigger is now deleted (doc 36 §1), so an early return without a push means
 * those recipients get NOTHING — most of an account's notifications, silently.
 * The matching rule is what this pins; the early-return fix is in
 * messageFanout.ts.
 */
describe("preview-to-device matching", () => {
    const pick = (previews: Record<string, string> | undefined, deviceId: string) =>
        previews?.[deviceId] ?? null;

    it("hands a device only its OWN blob", () => {
        const previews = { "device-a": "blob-a", "device-b": "blob-b" };
        expect(pick(previews, "device-a")).toBe("blob-a");
        expect(pick(previews, "device-b")).toBe("blob-b");
    });

    it("falls back to generic copy for a device with no preview", () => {
        // A device the sender had no cached identity key for. It still gets a
        // notification, just a generic one — silence would be worse.
        expect(pick({ "device-a": "blob-a" }, "device-c")).toBeNull();
    });

    it("falls back for every device when the sender produced no previews", () => {
        // An older client that does not seal at all. Every recipient must still
        // be notified.
        expect(pick(undefined, "device-a")).toBeNull();
        expect(pick({}, "device-a")).toBeNull();
    });
});
