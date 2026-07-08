/**
 * revoke.test.ts — the pure logic behind the "revoke" silent push: diffing
 * before/after group documents for removed entities and building the
 * revoke payload.
 */

import { describe, it, expect } from "vitest";

import { buildRevokeData, diffRemovedGroupEntities } from "./revoke";

describe("diffRemovedGroupEntities", () => {
    it("returns nothing for missing before/after states", () => {
        expect(diffRemovedGroupEntities(undefined, { expenses: [] })).toEqual({
            expenseIds: [],
            settlementIds: [],
        });
        expect(diffRemovedGroupEntities({ expenses: [] }, undefined)).toEqual({
            expenseIds: [],
            settlementIds: [],
        });
    });

    it("returns nothing when nothing was removed", () => {
        const state = {
            expenses: [{ expenseId: "e1" }, { expenseId: "e2" }],
            settlements: [{ settlementId: "s1" }],
        };
        expect(diffRemovedGroupEntities(state, state)).toEqual({
            expenseIds: [],
            settlementIds: [],
        });
    });

    it("detects removed expenses", () => {
        const before = { expenses: [{ expenseId: "e1" }, { expenseId: "e2" }] };
        const after = { expenses: [{ expenseId: "e2" }] };
        expect(diffRemovedGroupEntities(before, after)).toEqual({
            expenseIds: ["e1"],
            settlementIds: [],
        });
    });

    it("detects removed settlements", () => {
        const before = { settlements: [{ settlementId: "s1" }, { settlementId: "s2" }] };
        const after = { settlements: [{ settlementId: "s1" }] };
        expect(diffRemovedGroupEntities(before, after)).toEqual({
            expenseIds: [],
            settlementIds: ["s2"],
        });
    });

    it("ignores additions", () => {
        const before = { expenses: [{ expenseId: "e1" }] };
        const after = { expenses: [{ expenseId: "e1" }, { expenseId: "e2" }] };
        expect(diffRemovedGroupEntities(before, after)).toEqual({
            expenseIds: [],
            settlementIds: [],
        });
    });

    it("treats a missing array in after as removal of all its entities", () => {
        const before = {
            expenses: [{ expenseId: "e1" }],
            settlements: [{ settlementId: "s1" }],
        };
        expect(diffRemovedGroupEntities(before, { name: "Trip" })).toEqual({
            expenseIds: ["e1"],
            settlementIds: ["s1"],
        });
    });

    it("skips malformed entries without ids", () => {
        const before = { expenses: [{ expenseId: "e1" }, { amount: 5 }, null, "junk"] };
        const after = { expenses: [] };
        expect(diffRemovedGroupEntities(before, after)).toEqual({
            expenseIds: ["e1"],
            settlementIds: [],
        });
    });
});

describe("buildRevokeData", () => {
    it("returns null when no ids are present", () => {
        expect(buildRevokeData({})).toBeNull();
    });

    it("carries only the ids that are set", () => {
        expect(buildRevokeData({ groupId: "g1" })).toEqual({
            type: "revoke",
            groupId: "g1",
        });
        expect(buildRevokeData({ expenseId: "e1", settlementId: "s1" })).toEqual({
            type: "revoke",
            expenseId: "e1",
            settlementId: "s1",
        });
        expect(buildRevokeData({ chatId: "c1" })).toEqual({
            type: "revoke",
            chatId: "c1",
        });
    });
});
