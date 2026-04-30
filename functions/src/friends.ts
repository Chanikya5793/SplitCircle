import { getDatabase } from "firebase-admin/database";
import * as logger from "firebase-functions/logger";

export type FriendSource = "group" | "debt" | "manual";

interface FriendEntry {
    source: FriendSource;
    since: number;
    lastInteractionAt?: number;
}

const FRIENDS_PATH = "friends";

const sourceRank: Record<FriendSource, number> = {
    // Higher rank "wins" on collision so we never silently downgrade a debt
    // friendship to a group friendship — it would obscure that there's still
    // money between them. `manual` is the strongest because the user
    // explicitly chose it.
    group: 1,
    debt: 2,
    manual: 3,
};

const writeFriendEntry = async (
    ownerUid: string,
    friendUid: string,
    next: FriendEntry,
): Promise<void> => {
    if (!ownerUid || !friendUid || ownerUid === friendUid) return;

    const ref = getDatabase().ref(`${FRIENDS_PATH}/${ownerUid}/${friendUid}`);

    await ref.transaction((current: FriendEntry | null) => {
        if (!current) return next;

        const incomingRank = sourceRank[next.source] ?? 0;
        const existingRank = sourceRank[current.source] ?? 0;
        const winningSource: FriendSource = incomingRank >= existingRank ? next.source : current.source;

        return {
            source: winningSource,
            since: Math.min(current.since ?? next.since, next.since),
            lastInteractionAt: Math.max(current.lastInteractionAt ?? 0, next.lastInteractionAt ?? next.since),
        };
    });
};

/**
 * Add a mutual friendship between two users — both /friends/A/B and /friends/B/A
 * are written by the admin SDK in parallel. Idempotent and source-aware.
 */
export const materializeMutualFriendship = async (
    uidA: string,
    uidB: string,
    source: FriendSource,
): Promise<void> => {
    if (!uidA || !uidB || uidA === uidB) return;

    const now = Date.now();
    const entry: FriendEntry = { source, since: now, lastInteractionAt: now };

    await Promise.all([
        writeFriendEntry(uidA, uidB, entry),
        writeFriendEntry(uidB, uidA, entry),
    ]);
};

/**
 * For every pair in the given member set, ensure a `group` friendship exists.
 * Pair count is O(n²) but groups are bounded (~tens of members). Single RTDB
 * round-trip per directed edge via transaction.
 */
export const materializeGroupFriendships = async (
    memberIds: readonly string[],
): Promise<void> => {
    const unique = Array.from(new Set(memberIds.filter((id): id is string => typeof id === "string" && id.length > 0)));
    if (unique.length < 2) return;

    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
            writes.push(materializeMutualFriendship(unique[i], unique[j], "group"));
        }
    }

    try {
        await Promise.all(writes);
    } catch (error) {
        logger.warn("friends: materializeGroupFriendships partial failure", {
            error: error instanceof Error ? error.message : String(error),
            memberCount: unique.length,
        });
    }
};

/**
 * The payer + each split-participant on an expense gets a mutual `debt`
 * friendship. Use this from your expense / settlement create triggers.
 */
export const materializeDebtFriendships = async (
    payerUid: string,
    counterpartyUids: readonly string[],
): Promise<void> => {
    if (!payerUid) return;

    const counterparties = Array.from(new Set(
        counterpartyUids.filter((id): id is string => typeof id === "string" && id.length > 0 && id !== payerUid),
    ));

    try {
        await Promise.all(
            counterparties.map((uid) => materializeMutualFriendship(payerUid, uid, "debt")),
        );
    } catch (error) {
        logger.warn("friends: materializeDebtFriendships partial failure", {
            error: error instanceof Error ? error.message : String(error),
            payerUid,
            counterpartyCount: counterparties.length,
        });
    }
};

/**
 * Bump `lastInteractionAt` on an existing friendship (use after settlements,
 * messages, calls). Best-effort — does not create a friendship if missing.
 */
export const touchFriendInteraction = async (
    uidA: string,
    uidB: string,
): Promise<void> => {
    if (!uidA || !uidB || uidA === uidB) return;
    const now = Date.now();
    const updates = {
        [`${FRIENDS_PATH}/${uidA}/${uidB}/lastInteractionAt`]: now,
        [`${FRIENDS_PATH}/${uidB}/${uidA}/lastInteractionAt`]: now,
    };
    try {
        await getDatabase().ref().update(updates);
    } catch (error) {
        // Ignore — entry might not exist yet, or write was racing a delete.
    }
};
