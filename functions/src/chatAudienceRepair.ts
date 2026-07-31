import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

const CHATS_COLLECTION = "chats";

export interface RepairChatAudienceResult {
    repaired: boolean;
    participantIds: string[];
}

/**
 * Reconciles a chat doc whose `participantIds` and `participants` arrays have
 * drifted apart (ai_layer/docs/32 §5d).
 *
 * Older clients did not keep the two representations in lockstep. That is
 * harmless online — the server fan-out has its own recipient list — but it
 * broke nearby messaging outright: `resolveMeshThreadAudience` unions both
 * arrays and requires a direct chat to resolve to EXACTLY two people, so a
 * thread missing someone from both arrays returned null and every nearby
 * envelope for it was rejected on send AND receive, with no UI feedback.
 *
 * WHY THIS IS A CLOUD FUNCTION AND NOT A CLIENT WRITE. `firestore.rules`
 * deliberately forbids clients from touching these two fields:
 * `isChatMutableUpdate()` asserts `request.resource.data.participantIds ==
 * resource.data.participantIds` (and the same for `participants`), and
 * `isGroupChatJoinUpdate()` only lets a caller add THEMSELVES to a group they
 * already belong to. A repair write from the client is therefore denied,
 * permanently — the same class of wall CLAUDE.md documents for the
 * invite-code join. Loosening the rule is not an option either: rules cannot
 * map `participants[].userId` to compare it against `participantIds`, so any
 * client-writable form of this would have to permit adding arbitrary user ids
 * to a chat, which is a read-access escalation (the chat read rule is
 * membership-based). Doing it with the Admin SDK keeps the union derived from
 * the document's OWN contents, so no caller can inject a new participant.
 *
 * The caller must already be a participant by the pre-repair document, and the
 * result can only ever ADD ids that one of the two arrays already contained.
 */
export const repairChatAudience = async (
    uid: string,
    chatId: string,
): Promise<RepairChatAudienceResult> => {
    const db = getFirestore();
    const chatRef = db.collection(CHATS_COLLECTION).doc(chatId);

    return db.runTransaction(async (tx) => {
        const snap = await tx.get(chatRef);
        if (!snap.exists) {
            throw new Error("Chat not found");
        }
        const data = snap.data() ?? {};

        const storedIds: string[] = Array.isArray(data.participantIds)
            ? data.participantIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
            : [];
        const participants: { userId?: unknown }[] = Array.isArray(data.participants)
            ? data.participants
            : [];
        const participantIdsFromObjects = participants
            .map((participant) => participant?.userId)
            .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);

        // Authorize against the PRE-repair document, using either
        // representation: the caller may legitimately be the person who is
        // missing from `participantIds` — that is the exact corruption being
        // repaired, and requiring the stale array would make it unfixable.
        if (!storedIds.includes(uid) && !participantIdsFromObjects.includes(uid)) {
            throw new Error("Not a participant of this chat");
        }

        const union = [...new Set([...storedIds, ...participantIdsFromObjects])];

        // Rebuild `participants` so both representations describe the same
        // people. Existing entries keep their stored profile fields; an id
        // known only to `participantIds` gets a minimal entry, which the
        // normal profile-sync path fills in later. Never drop an entry.
        const byUserId = new Map<string, Record<string, unknown>>();
        for (const participant of participants) {
            const userId = participant?.userId;
            if (typeof userId === "string" && userId.length > 0) {
                byUserId.set(userId, participant as Record<string, unknown>);
            }
        }
        const repairedParticipants = union.map(
            (userId) => byUserId.get(userId) ?? { userId },
        );

        const alreadyConsistent = union.length === storedIds.length
            && union.length === byUserId.size;
        if (alreadyConsistent) {
            return { repaired: false, participantIds: union };
        }

        tx.update(chatRef, {
            participantIds: union,
            participants: repairedParticipants,
        });

        logger.info("repairChatAudience: reconciled chat membership", {
            chatId,
            uid,
            before: storedIds.length,
            after: union.length,
        });

        return { repaired: true, participantIds: union };
    });
};
