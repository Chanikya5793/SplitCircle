import {
    FieldValue,
    getFirestore,
    type DocumentData,
    type DocumentReference,
    type Firestore,
} from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";
import { getAuth } from "firebase-admin/auth";
import * as logger from "firebase-functions/logger";
import { v4 as uuidv4 } from "uuid";

const USERS_COLLECTION = "users";
const GROUPS_COLLECTION = "groups";
const CHATS_COLLECTION = "chats";
const EXPENSES_COLLECTION = "expenses";
const RECURRING_BILLS_COLLECTION = "recurringBills";
const NOTIFICATION_DEVICES_COLLECTION = "notificationDevices";
const FRIENDS_PATH = "friends";
const MESSAGE_QUEUE_PATH = "messageQueue";

// Firestore batched writes cap at 500 ops (the client's deleteGroup throws
// past 450). Account deletion chunks instead of throwing so a solo-owned
// group with many linked docs never forces the user to retry manually.
const MAX_BATCH_OPS = 450;
const BALANCE_EPSILON = 0.005;

export interface DeletionBlocker {
    groupId: string;
    groupName: string;
    reason: "transfer_ownership" | "unsettled_balance";
    memberCount?: number;
    balance?: number;
    currency?: string;
}

interface GroupMemberRecord {
    userId: string;
    displayName: string;
    photoURL?: string;
    role: "owner" | "admin" | "member";
}

interface ExpenseParticipantRecord {
    userId: string;
    share: number;
}

interface GroupExpenseRecord {
    paidBy: string;
    amount: number;
    participants?: ExpenseParticipantRecord[];
}

interface GroupSettlementRecord {
    fromUserId: string;
    toUserId: string;
    amount: number;
}

const toStringValue = (value: unknown): string => {
    return typeof value === "string" ? value.trim() : "";
};

const toSafeError = (error: unknown): { name?: string; message?: string } => {
    if (error instanceof Error) {
        return { name: error.name, message: error.message };
    }
    return { message: "Unknown error" };
};

/**
 * Admin-side port of GroupContext.tsx's adaptGroup balance replay
 * (src/context/GroupContext.tsx:127), scoped to a single user since there is
 * no client SDK available server-side. MUST stay in lockstep with adaptGroup:
 * the payer gets the full expense amount, each participant loses their
 * `.share`, and settlements move the amount from `fromUserId` to `toUserId`.
 */
const computeMemberBalance = (data: DocumentData, uid: string): number => {
    let balance = 0;

    const expenses = (data.expenses ?? []) as GroupExpenseRecord[];
    for (const expense of expenses) {
        if (expense.paidBy === uid) {
            balance += expense.amount;
        }
        for (const participant of expense.participants ?? []) {
            if (participant.userId === uid) {
                balance -= participant.share;
            }
        }
    }

    const settlements = (data.settlements ?? []) as GroupSettlementRecord[];
    for (const settlement of settlements) {
        if (settlement.fromUserId === uid) {
            balance += settlement.amount;
        }
        if (settlement.toUserId === uid) {
            balance -= settlement.amount;
        }
    }

    return balance;
};

/**
 * Groups that must be resolved before deletion: owned with other members
 * still present (transfer ownership first), or a nonzero live balance
 * (settle up first — mirrors leaveGroup's doc-29 rule, not just the
 * owner-with-members case). Called from the client's pre-check callable and
 * re-run inside deleteAccount itself to close the race where group state
 * changes between the check and the confirm tap.
 */
export async function findDeletionBlockers(uid: string): Promise<DeletionBlocker[]> {
    const db = getFirestore();
    const snapshot = await db.collection(GROUPS_COLLECTION).where("memberIds", "array-contains", uid).get();
    const blockers: DeletionBlocker[] = [];

    for (const doc of snapshot.docs) {
        const data = doc.data();
        const members = (data.members ?? []) as GroupMemberRecord[];
        const me = members.find((member) => member.userId === uid);
        const groupName = toStringValue(data.name) || "Untitled group";
        const currency = toStringValue(data.currency) || undefined;

        if (me?.role === "owner" && members.length > 1) {
            blockers.push({
                groupId: doc.id,
                groupName,
                reason: "transfer_ownership",
                memberCount: members.length,
            });
            continue;
        }

        const balance = computeMemberBalance(data, uid);
        if (Math.abs(balance) >= BALANCE_EPSILON) {
            blockers.push({
                groupId: doc.id,
                groupName,
                reason: "unsettled_balance",
                balance,
                currency,
            });
        }
    }

    return blockers;
}

const commitDeletesInChunks = async (refs: DocumentReference[]): Promise<void> => {
    const db = getFirestore();
    for (let index = 0; index < refs.length; index += MAX_BATCH_OPS) {
        const batch = db.batch();
        for (const ref of refs.slice(index, index + MAX_BATCH_OPS)) {
            batch.delete(ref);
        }
        await batch.commit();
    }
};

/**
 * Solo-owned group (the deleting user is the only member): cascade-delete
 * the group doc plus its chats/expenses/recurringBills docs, chunked to stay
 * under Firestore's batch cap. Mirrors the client's deleteGroup
 * (GroupContext.tsx), extended to also sweep recurringBills — a gap that
 * exists in that client path but must not be repeated here.
 */
const deleteSoloOwnedGroup = async (groupRef: DocumentReference, groupId: string): Promise<void> => {
    const db = getFirestore();
    const [chatsSnapshot, expensesSnapshot, billsSnapshot] = await Promise.all([
        db.collection(CHATS_COLLECTION).where("groupId", "==", groupId).get(),
        db.collection(EXPENSES_COLLECTION).where("groupId", "==", groupId).get(),
        db.collection(RECURRING_BILLS_COLLECTION).where("groupId", "==", groupId).get(),
    ]);

    // groupRef goes LAST: if a later chunk fails partway through, the group
    // doc should still exist rather than vanish while its chats/expenses/
    // recurringBills orphan under a now-nonexistent groupId — a retry can
    // then re-query by groupId and finish the job.
    const refsToDelete: DocumentReference[] = [
        ...chatsSnapshot.docs.map((doc) => doc.ref),
        ...expensesSnapshot.docs.map((doc) => doc.ref),
        ...billsSnapshot.docs.map((doc) => doc.ref),
        groupRef,
    ];

    await commitDeletesInChunks(refsToDelete);
};

/**
 * Non-owner membership: archive instead of drop, same shape as the client's
 * leaveGroup/removeMember (GroupContext.tsx) — keeps displayName/photo
 * resolvable so historical balances/debts don't render as "Unknown". balance
 * is stored as 0; the real balance still recomputes live via adaptGroup
 * client-side. Returns the departing member's display name for the system
 * message.
 */
const archiveDepartingMember = async (
    groupRef: DocumentReference,
    data: DocumentData,
    uid: string,
): Promise<string> => {
    const members = (data.members ?? []) as GroupMemberRecord[];
    const me = members.find((member) => member.userId === uid);
    const displayName = me?.displayName ?? "Deleted user";

    const newMembers = members.filter((member) => member.userId !== uid);
    const newMemberIds = ((data.memberIds ?? []) as string[]).filter((id) => id !== uid);
    const existingArchive = ((data.archivedMembers ?? []) as GroupMemberRecord[]).filter(
        (member) => member.userId !== uid,
    );

    const archivedEntry = {
        userId: uid,
        displayName,
        ...(me?.photoURL ? { photoURL: me.photoURL } : {}),
        role: "member",
        balance: 0,
        archived: true,
        archivedAt: Date.now(),
        archivedReason: "account_deleted",
    };

    await groupRef.update({
        members: newMembers,
        memberIds: newMemberIds,
        archivedMembers: [...existingArchive, archivedEntry],
        updatedAt: FieldValue.serverTimestamp(),
    });

    return displayName;
};

/**
 * Best-effort system message into the group's chat thread, mirroring
 * writeGroupSystemMessage's RTDB queue shape (messageQueueService.ts) — the
 * Cloud Function writes to messageQueue/{recipientId}/{messageId} directly
 * via admin.database() since it cannot call the client function. Skips the
 * chat doc's lastMessage/participants update on purpose (best-effort only;
 * the next client read reconciles group membership from members[] anyway).
 */
const postAccountDeletedSystemMessage = async (
    db: Firestore,
    groupId: string,
    uid: string,
    displayName: string,
): Promise<void> => {
    const chatSnapshot = await db.collection(CHATS_COLLECTION).where("groupId", "==", groupId).limit(1).get();
    if (chatSnapshot.empty) {
        return;
    }

    const chatDoc = chatSnapshot.docs[0];
    const recipientIds = ((chatDoc.data().participantIds ?? []) as string[]).filter((id) => id !== uid);
    if (recipientIds.length === 0) {
        return;
    }

    const messageId = uuidv4();
    const message = {
        senderId: uid,
        chatId: chatDoc.id,
        requestId: messageId,
        content: `${displayName}'s account was deleted`,
        type: "system",
        timestamp: Date.now(),
        mediaUrl: null,
        thumbnailUrl: null,
        isGroupChat: true,
    };

    const rtdb = getDatabase();
    await Promise.all(
        recipientIds.map((recipientId) =>
            rtdb.ref(`${MESSAGE_QUEUE_PATH}/${recipientId}/${messageId}`).set(message).catch((error) => {
                logger.warn("Account deletion: failed to queue system message", {
                    groupId,
                    recipientId,
                    error: toSafeError(error),
                });
            }),
        ),
    );
};

const deleteNotificationDevices = async (db: Firestore, uid: string): Promise<void> => {
    const snapshot = await db
        .collection(USERS_COLLECTION)
        .doc(uid)
        .collection(NOTIFICATION_DEVICES_COLLECTION)
        .get();

    if (snapshot.empty) {
        return;
    }

    await commitDeletesInChunks(snapshot.docs.map((doc) => doc.ref));
};

/**
 * Cascades a user's full account deletion: every group they belong to is
 * either cascade-deleted (solo-owned) or has their membership archived
 * (everything else — findDeletionBlockers already ruled out owner-with-
 * other-members and nonzero-balance groups), then their own
 * notificationDevices, RTDB friends node, Firestore user doc, and finally
 * the Firebase Auth user itself.
 *
 * Callers MUST re-run findDeletionBlockers immediately before calling this
 * (see deleteAccount in index.ts) — this function does not re-validate.
 */
export async function deleteAccountCascade(uid: string): Promise<void> {
    const db = getFirestore();
    const groupsSnapshot = await db.collection(GROUPS_COLLECTION).where("memberIds", "array-contains", uid).get();

    for (const groupDoc of groupsSnapshot.docs) {
        const data = groupDoc.data();
        const members = (data.members ?? []) as GroupMemberRecord[];
        const me = members.find((member) => member.userId === uid);

        if (me?.role === "owner" && members.length === 1) {
            await deleteSoloOwnedGroup(groupDoc.ref, groupDoc.id);
            continue;
        }

        const displayName = await archiveDepartingMember(groupDoc.ref, data, uid);
        await postAccountDeletedSystemMessage(db, groupDoc.id, uid, displayName);
    }

    await deleteNotificationDevices(db, uid);

    // Only the deleted user's OWN friends/{uid} node is cleared. Friendships
    // are actually written bidirectionally by functions/src/friends.ts
    // (friends/A/B AND friends/B/A for shared-group/debt friendships) — other
    // users' friends/{otherUid}/{uid} reverse edges are left dangling on
    // purpose. RTDB has no reverse index from a uid to "who has me as a
    // friend", so cleaning those would require a full users scan; the
    // resulting staleness (a friend entry pointing at a deleted account,
    // possibly with a denormalized displayName snapshot) mirrors the same
    // already-accepted tradeoff archivedMembers makes for group history.
    await getDatabase()
        .ref(`${FRIENDS_PATH}/${uid}`)
        .remove()
        .catch((error) => {
            logger.warn("Account deletion: failed to clear friends node", { uid, error: toSafeError(error) });
        });

    await db.collection(USERS_COLLECTION).doc(uid).delete();
    await getAuth().deleteUser(uid);
}
