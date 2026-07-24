import {
    FieldValue,
    getFirestore,
    type DocumentData,
} from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";
import * as logger from "firebase-functions/logger";
import { v4 as uuidv4 } from "uuid";
import { resolveDisplayName } from "./identity";

const GROUPS_COLLECTION = "groups";
const CHATS_COLLECTION = "chats";
const USERS_COLLECTION = "users";
const MESSAGE_QUEUE_PATH = "messageQueue";

interface GroupMemberRecord {
    userId: string;
    displayName: string;
    photoURL?: string | null;
    role: "owner" | "admin" | "member";
    balance: number;
}

export interface JoinGroupResult {
    groupId: string;
    alreadyMember: boolean;
}

const toSafeError = (error: unknown): { name?: string; message?: string } => {
    if (error instanceof Error) {
        return { name: error.name, message: error.message };
    }
    return { message: "Unknown error" };
};

/**
 * Resolves an invite code to a group and adds the caller as a member —
 * entirely server-side via the Admin SDK. This can't be a plain client
 * Firestore write: the invite-code lookup is a `where('inviteCode', '==', ...)`
 * query against `groups`, whose read rule requires pre-existing membership
 * (`request.auth.uid in resource.data.memberIds`) — a rule a non-member can
 * never satisfy, so Firestore rejects the entire query outright (it evaluates
 * rules against a query's potential result set, not the actual matched docs,
 * so no client-side workaround exists). See the CLAUDE.md gotcha on this.
 *
 * Mirrors the client's old joinGroup (GroupContext.tsx) write shape exactly —
 * archivedMembers purge, chat participant fan-out, RTDB system message — so
 * this is a drop-in replacement, not a behavior change.
 */
export async function joinGroupByInviteCode(
    uid: string,
    inviteCode: string,
    requestId: string | undefined,
): Promise<JoinGroupResult> {
    const db = getFirestore();

    const groupsSnapshot = await db
        .collection(GROUPS_COLLECTION)
        .where("inviteCode", "==", inviteCode)
        .limit(1)
        .get();
    if (groupsSnapshot.empty) {
        throw new Error("Invite code not found");
    }

    const groupDoc = groupsSnapshot.docs[0];
    const groupData = groupDoc.data() as DocumentData;
    const memberIds = (groupData.memberIds ?? []) as string[];

    if (memberIds.includes(uid)) {
        return { groupId: groupDoc.id, alreadyMember: true };
    }

    const userDoc = await db.collection(USERS_COLLECTION).doc(uid).get();
    const userData = userDoc.data() ?? {};
    // "New member" is a literal fallback word, deliberately never persisted
    // as-if-guessed — see identity.ts's header comment (doc 30).
    const displayName = resolveDisplayName(userData, "New member");
    const photoURL = typeof userData.photoURL === "string" && userData.photoURL.trim()
        ? userData.photoURL.trim()
        : null;

    // If the user previously left or was removed, drop them from
    // archivedMembers so we don't have a duplicate identity record — same
    // intent as the old client code, just with real read access to compute it.
    const purgedArchive = ((groupData.archivedMembers ?? []) as GroupMemberRecord[]).filter(
        (member) => member.userId !== uid,
    );

    const newMemberEntry: GroupMemberRecord = {
        userId: uid,
        displayName,
        photoURL,
        role: "member",
        balance: 0,
    };

    await groupDoc.ref.update({
        memberIds: FieldValue.arrayUnion(uid),
        members: FieldValue.arrayUnion(newMemberEntry),
        archivedMembers: purgedArchive,
        updatedAt: FieldValue.serverTimestamp(),
    });

    // Mirror the associated chat thread + queue a system message, same as
    // the old client code — best-effort, doesn't fail the join if it errors.
    try {
        const chatSnapshot = await db
            .collection(CHATS_COLLECTION)
            .where("groupId", "==", groupDoc.id)
            .limit(1)
            .get();

        if (!chatSnapshot.empty) {
            const chatDoc = chatSnapshot.docs[0];
            const chatData = chatDoc.data();
            const messageId = requestId ?? uuidv4();
            const now = Date.now();
            const systemMessage = {
                senderId: uid,
                chatId: chatDoc.id,
                requestId: requestId ?? messageId,
                content: `${displayName} joined the group`,
                type: "system",
                timestamp: now,
                mediaUrl: null,
                thumbnailUrl: null,
                isGroupChat: true,
                // Doc 30: lets MessageBubble prefer a live resolveDisplayName()
                // lookup over this frozen `content` string once the joiner's
                // name is known/fixed. Self-referential — relatedUserId is the
                // joiner themselves, same as senderId.
                systemEventKind: "member_joined",
                relatedUserId: uid,
            };

            await chatDoc.ref.update({
                participantIds: FieldValue.arrayUnion(uid),
                participants: FieldValue.arrayUnion({
                    userId: uid,
                    displayName,
                    ...(photoURL ? { photoURL } : {}),
                    status: "online",
                }),
                lastMessage: { ...systemMessage, createdAt: FieldValue.serverTimestamp() },
                updatedAt: FieldValue.serverTimestamp(),
            });

            const currentParticipantIds = ((chatData.participantIds ?? []) as string[]);
            const recipients = [...new Set([...currentParticipantIds, uid])];
            const rtdb = getDatabase();
            await Promise.all(
                recipients.map((recipientId) =>
                    rtdb.ref(`${MESSAGE_QUEUE_PATH}/${recipientId}/${messageId}`).set(systemMessage).catch((error) => {
                        logger.warn("joinGroupByInviteCode: failed to queue system message", {
                            groupId: groupDoc.id,
                            recipientId,
                            error: toSafeError(error),
                        });
                    }),
                ),
            );
        }
    } catch (error) {
        logger.warn("joinGroupByInviteCode: chat sync failed (join still succeeded)", {
            groupId: groupDoc.id,
            uid,
            error: toSafeError(error),
        });
    }

    return { groupId: groupDoc.id, alreadyMember: false };
}
