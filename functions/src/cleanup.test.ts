/**
 * The reaper's expiry decision.
 *
 * `syncGapBatches` had NO reaper at all until doc 35, while
 * `syncBatchService.ts`'s own catch comment credited one for bounding how long
 * a batch could linger — a mechanism that had never been wired, which is a
 * pattern CLAUDE.md records three separate times in this project.
 *
 * The decision worth pinning is not "is 24 hours the right number" but the case
 * that is easy to get backwards: a node with NO `createdAt`. Defaulting a
 * missing timestamp to `now`, or skipping such a node, would make exactly the
 * nodes this reaper exists for permanently un-reapable — and it would look
 * correct in review, because every individual line reads sensibly.
 */
import { describe, expect, it } from "vitest";

import { isExpiredNode } from "./cleanup";

// Anchored to the REAL clock, deliberately. A hardcoded constant here was a
// trap: the obvious wrong implementation defaults a missing timestamp to
// `Date.now()`, and with a NOW constant set in the future every assertion still
// passed — the test looked like it pinned the behaviour and pinned nothing.
// Verified by breaking the implementation and watching this file stay green.
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const cutoff = NOW - DAY;

describe("isExpiredNode", () => {
    it("keeps a node written just now", () => {
        expect(isExpiredNode({ createdAt: NOW }, cutoff)).toBe(false);
    });

    it("keeps a node from just inside the window", () => {
        // A device offline overnight must still find its history waiting.
        expect(isExpiredNode({ createdAt: NOW - DAY + 60_000 }, cutoff)).toBe(false);
    });

    it("reaps a node from outside the window", () => {
        expect(isExpiredNode({ createdAt: NOW - DAY - 1 }, cutoff)).toBe(true);
    });

    it("reaps a node with NO createdAt rather than keeping it forever", () => {
        // The case the whole helper exists for. A batch written before the
        // field existed would otherwise sit in RTDB permanently.
        expect(isExpiredNode({ v: 1, b: "sealed" }, cutoff)).toBe(true);
    });

    it("reaps a node whose createdAt is unusable", () => {
        // Unreadable is not a reason to keep something forever.
        for (const bad of ["yesterday", null, undefined, NaN, Infinity, {}]) {
            expect(isExpiredNode({ createdAt: bad }, cutoff), String(bad)).toBe(true);
        }
    });

    it("reaps a null or non-object node without throwing", () => {
        // RTDB can hand back a deleted or malformed node mid-sweep; throwing
        // here would abort the entire scheduled cleanup for every other path.
        expect(() => isExpiredNode(null, cutoff)).not.toThrow();
        expect(isExpiredNode(null, cutoff)).toBe(true);
        expect(isExpiredNode("garbage", cutoff)).toBe(true);
    });

    it("does not treat a future timestamp as expired", () => {
        // Clock skew between a client and the reaper is normal; a node stamped
        // slightly ahead must not be deleted the moment it is written.
        expect(isExpiredNode({ createdAt: NOW + 60_000 }, cutoff)).toBe(false);
    });
});
