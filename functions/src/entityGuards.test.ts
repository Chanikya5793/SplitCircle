/**
 * entityGuards.test.ts — the pure existence-evaluation logic used to skip
 * push notifications for groups/expenses/settlements deleted between the
 * trigger event and dispatch.
 */

import { describe, it, expect, vi } from "vitest";

// Mocked so importing the module doesn't require the real firebase-admin
// package (matches the aiLayer.test.ts pattern).
vi.mock("firebase-admin/firestore", () => ({ getFirestore: vi.fn() }));

import { evaluateGroupEntityData } from "./entityGuards";

describe("evaluateGroupEntityData", () => {
    it("blocks when the group data is missing (group deleted)", () => {
        expect(evaluateGroupEntityData(undefined, {})).toEqual({
            ok: false,
            reason: "group_deleted",
        });
    });

    it("allows when the group exists and no entity check is requested", () => {
        expect(evaluateGroupEntityData({ name: "Trip" }, {})).toEqual({ ok: true });
    });

    it("allows when the expense is still present", () => {
        const group = { expenses: [{ expenseId: "e1" }, { expenseId: "e2" }] };
        expect(evaluateGroupEntityData(group, { expenseId: "e2" })).toEqual({ ok: true });
    });

    it("blocks when the expense was removed", () => {
        const group = { expenses: [{ expenseId: "e1" }] };
        expect(evaluateGroupEntityData(group, { expenseId: "gone" })).toEqual({
            ok: false,
            reason: "expense_deleted",
        });
    });

    it("blocks when the expenses array is missing entirely", () => {
        expect(evaluateGroupEntityData({ name: "Trip" }, { expenseId: "e1" })).toEqual({
            ok: false,
            reason: "expense_deleted",
        });
    });

    it("allows when the settlement is still present", () => {
        const group = { settlements: [{ settlementId: "s1" }] };
        expect(evaluateGroupEntityData(group, { settlementId: "s1" })).toEqual({ ok: true });
    });

    it("blocks when the settlement was removed", () => {
        const group = { settlements: [{ settlementId: "s1" }] };
        expect(evaluateGroupEntityData(group, { settlementId: "s9" })).toEqual({
            ok: false,
            reason: "settlement_deleted",
        });
    });

    it("checks both ids when provided and reports the expense first", () => {
        const group = { expenses: [], settlements: [] };
        expect(
            evaluateGroupEntityData(group, { expenseId: "e1", settlementId: "s1" }),
        ).toEqual({ ok: false, reason: "expense_deleted" });
    });

    it("ignores malformed array entries instead of crashing", () => {
        const group = { expenses: [null, "junk", 42, { expenseId: "e1" }] };
        expect(evaluateGroupEntityData(group, { expenseId: "e1" })).toEqual({ ok: true });
        expect(evaluateGroupEntityData(group, { expenseId: "e2" })).toEqual({
            ok: false,
            reason: "expense_deleted",
        });
    });
});
