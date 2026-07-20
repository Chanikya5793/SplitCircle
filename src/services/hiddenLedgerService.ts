/**
 * hiddenLedgerService.ts — the hidden 2-person ledger behind 1:1 money
 * (ai_layer/docs/21 §hidden ledger, doc 26 §1:1 recurring).
 *
 * A hidden ledger is a REAL expense group with `hidden: true`: excluded from
 * the groups list UI, but fully alive for expenses/settlements/balances, so
 * friendBalances and every money funnel pick it up with zero changes.
 *
 * The group id is DETERMINISTIC (`ledger_<sortedUidA>__<sortedUidB>`), so
 * concurrent ensures from either side / any device converge on one document —
 * the same idempotency trick as recurring expense ids.
 */

import { db } from '@/firebase';
import type { Group } from '@/models';
import { doc, getDoc, setDoc } from 'firebase/firestore';

export interface LedgerPeer {
    userId: string;
    displayName: string;
    photoURL?: string;
}

export const hiddenLedgerGroupId = (userIdA: string, userIdB: string): string =>
    `ledger_${[userIdA, userIdB].sort().join('__')}`;

/** Find the hidden ledger for two users in an already-loaded groups list. */
export const findHiddenLedgerGroup = (
    groups: Group[],
    userIdA: string,
    userIdB: string,
): Group | undefined => {
    const id = hiddenLedgerGroupId(userIdA, userIdB);
    return groups.find(
        (g) =>
            g.hidden === true &&
            (g.groupId === id ||
                ((g.memberIds?.length ?? 0) === 2 &&
                    g.memberIds!.includes(userIdA) &&
                    g.memberIds!.includes(userIdB))),
    );
};

/**
 * Get-or-create the hidden ledger group for me + friend. Both users become
 * members at create (the creator is 'owner' — role only matters for the few
 * admin-gated surfaces, which a 2-person ledger doesn't expose).
 */
export const ensureHiddenLedgerGroup = async (
    me: LedgerPeer,
    friend: LedgerPeer,
    currency: string,
    existingGroups: Group[] = [],
): Promise<string> => {
    const known = findHiddenLedgerGroup(existingGroups, me.userId, friend.userId);
    if (known) return known.groupId;

    const groupId = hiddenLedgerGroupId(me.userId, friend.userId);
    const ref = doc(db, 'groups', groupId);
    const snapshot = await getDoc(ref);
    if (snapshot.exists()) return groupId;

    await setDoc(ref, {
        groupId,
        requestId: groupId,
        name: `${me.displayName} & ${friend.displayName}`,
        currency,
        inviteCode: groupId.slice(-6).toUpperCase(),
        hidden: true,
        members: [
            {
                userId: me.userId,
                displayName: me.displayName,
                photoURL: me.photoURL ?? null,
                role: 'owner',
                balance: 0,
            },
            {
                userId: friend.userId,
                displayName: friend.displayName,
                photoURL: friend.photoURL ?? null,
                role: 'member',
                balance: 0,
            },
        ],
        memberIds: [me.userId, friend.userId],
        expenses: [],
        settlements: [],
        createdBy: me.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });
    return groupId;
};
