/**
 * entityGuards.ts — pre-send existence checks for push notifications.
 *
 * Firestore triggers fire on the *event* state, but the entity can be deleted
 * between the event and the actual push dispatch (fast delete after create,
 * retried/delayed trigger executions, etc.). These guards re-read the group
 * document right before sending so we never notify people about groups,
 * expenses, or settlements that no longer exist.
 */

import { getFirestore } from "firebase-admin/firestore";

export interface GroupEntityCheck {
    expenseId?: string;
    settlementId?: string;
}

export type GroupEntityGuardResult =
    | { ok: true }
    | { ok: false; reason: "group_deleted" | "expense_deleted" | "settlement_deleted" };

const arrayContainsId = (
    value: unknown,
    idField: string,
    id: string,
): boolean => {
    if (!Array.isArray(value)) {
        return false;
    }
    return value.some(
        (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as Record<string, unknown>)[idField] === id,
    );
};

/**
 * Pure check against already-fetched group data. Exported for unit tests.
 */
export const evaluateGroupEntityData = (
    groupData: Record<string, unknown> | undefined,
    check: GroupEntityCheck,
): GroupEntityGuardResult => {
    if (!groupData) {
        return { ok: false, reason: "group_deleted" };
    }

    if (check.expenseId && !arrayContainsId(groupData.expenses, "expenseId", check.expenseId)) {
        return { ok: false, reason: "expense_deleted" };
    }

    if (check.settlementId && !arrayContainsId(groupData.settlements, "settlementId", check.settlementId)) {
        return { ok: false, reason: "settlement_deleted" };
    }

    return { ok: true };
};

/**
 * Re-reads groups/{groupId} and verifies the group (and, when provided, the
 * specific expense/settlement inside it) still exists.
 *
 * Fails OPEN on read errors: a transient Firestore hiccup should not silently
 * swallow a legitimate notification — the guard only blocks when we have
 * positively confirmed the entity is gone.
 */
export const verifyGroupEntityExists = async (
    groupId: string,
    check: GroupEntityCheck = {},
): Promise<GroupEntityGuardResult> => {
    try {
        const snap = await getFirestore().collection("groups").doc(groupId).get();
        if (!snap.exists) {
            return { ok: false, reason: "group_deleted" };
        }
        return evaluateGroupEntityData(snap.data() as Record<string, unknown>, check);
    } catch {
        return { ok: true };
    }
};
