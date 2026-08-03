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
