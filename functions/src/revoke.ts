/**
 * revoke.ts — pure logic for the "revoke" silent push.
 *
 * When a group, expense, or settlement is deleted, devices that already
 * received a visible push about it hold a dead deep link in their tray.
 * The server sends a silent push (content-available on iOS, data-only on
 * Android) carrying the deleted entity ids so a background handler on the
 * client can withdraw those tray notifications without waking the UI.
 *
 * Kept free of firebase imports so it can be unit-tested directly.
 */

export interface RevokeFilter {
    groupId?: string;
    expenseId?: string;
    settlementId?: string;
    chatId?: string;
}

export interface RemovedGroupEntities {
    expenseIds: string[];
    settlementIds: string[];
}

const collectIds = (value: unknown, idField: string): Set<string> => {
    const ids = new Set<string>();
    if (!Array.isArray(value)) {
        return ids;
    }
    for (const entry of value) {
        if (typeof entry === "object" && entry !== null) {
            const id = (entry as Record<string, unknown>)[idField];
            if (typeof id === "string" && id.length > 0) {
                ids.add(id);
            }
        }
    }
    return ids;
};

/**
 * Compares the before/after states of a group document and returns the
 * expense and settlement ids that were removed by the update.
 */
export const diffRemovedGroupEntities = (
    before: Record<string, unknown> | undefined,
    after: Record<string, unknown> | undefined,
): RemovedGroupEntities => {
    const removed: RemovedGroupEntities = { expenseIds: [], settlementIds: [] };
    if (!before || !after) {
        return removed;
    }

    const beforeExpenses = collectIds(before.expenses, "expenseId");
    const afterExpenses = collectIds(after.expenses, "expenseId");
    for (const id of beforeExpenses) {
        if (!afterExpenses.has(id)) {
            removed.expenseIds.push(id);
        }
    }

    const beforeSettlements = collectIds(before.settlements, "settlementId");
    const afterSettlements = collectIds(after.settlements, "settlementId");
    for (const id of beforeSettlements) {
        if (!afterSettlements.has(id)) {
            removed.settlementIds.push(id);
        }
    }

    return removed;
};

/**
 * Builds the data payload for a revoke push. Returns null when the filter
 * carries no ids — a revoke push without a target must never be sent.
 */
export const buildRevokeData = (
    filter: RevokeFilter,
): Record<string, string> | null => {
    const data: Record<string, string> = { type: "revoke" };
    if (filter.groupId) data.groupId = filter.groupId;
    if (filter.expenseId) data.expenseId = filter.expenseId;
    if (filter.settlementId) data.settlementId = filter.settlementId;
    if (filter.chatId) data.chatId = filter.chatId;
    return Object.keys(data).length > 1 ? data : null;
};
