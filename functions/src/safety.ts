import { randomUUID } from "node:crypto";
import { getDatabase } from "firebase-admin/database";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const MAX_QUEUE_PAYLOAD_BYTES = 256 * 1024;
const MAX_MESSAGES_PER_MINUTE = 90;
const MAX_REPORTS_PER_DAY = 20;

type ChatData = {
    participantIds?: unknown;
    participants?: Array<Record<string, unknown>>;
    groupId?: unknown;
};

type GroupMember = {
    userId: string;
    displayName?: string;
    photoURL?: string;
    role: "owner" | "admin" | "member";
    balance?: number;
    [key: string]: unknown;
};

const cleanId = (value: unknown): string => {
    const id = typeof value === "string" ? value.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error("INVALID_ID");
    return id;
};

const cleanText = (value: unknown, max: number): string =>
    (typeof value === "string" ? value : "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .trim()
        .slice(0, max);

const participantIdsFrom = (data: ChatData): string[] =>
    Array.isArray(data.participantIds)
        ? data.participantIds.filter((value): value is string => typeof value === "string")
        : [];

const getAuthorizedChat = async (uid: string, chatId: string): Promise<{ data: ChatData; participantIds: string[] }> => {
    const snapshot = await getFirestore().collection("chats").doc(chatId).get();
    if (!snapshot.exists) throw new Error("CHAT_NOT_FOUND");
    const data = snapshot.data() as ChatData;
    const participantIds = participantIdsFrom(data);
    if (!participantIds.includes(uid)) throw new Error("NOT_CHAT_MEMBER");
    return { data, participantIds };
};

const consumeQuota = async (uid: string, kind: "messages" | "reports", limit: number, windowMs: number): Promise<void> => {
    const now = Date.now();
    const bucket = Math.floor(now / windowMs);
    const quotaRef = getDatabase().ref(`serverQuotas/${kind}/${uid}/${bucket}`);
    const result = await quotaRef.transaction((current) => {
        const count = typeof current?.count === "number" ? current.count : 0;
        if (count >= limit) return;
        return { count: count + 1, expiresAt: (bucket + 2) * windowMs };
    });
    if (!result.committed) throw new Error("RATE_LIMITED");
};

const isBlockedEitherWay = async (first: string, second: string): Promise<boolean> => {
    const root = getDatabase().ref("blocks");
    const [a, b] = await Promise.all([
        root.child(first).child(second).get(),
        root.child(second).child(first).get(),
    ]);
    return a.val() === true || b.val() === true;
};

export async function queueChatMessageImpl(uid: string, input: Record<string, unknown>): Promise<{ queued: true }> {
    const recipientId = cleanId(input.recipientId);
    const messageId = cleanId(input.messageId);
    const chatId = cleanId(input.chatId);
    const payload = input.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("INVALID_PAYLOAD");
    const message = payload as Record<string, unknown>;
    const isSelfRelay = recipientId === uid && (message.senderId === uid || message.envelopeSenderId === uid);
    if ((!isSelfRelay && message.senderId !== uid) || message.chatId !== chatId) throw new Error("INVALID_SENDER");
    const size = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (size > MAX_QUEUE_PAYLOAD_BYTES) throw new Error("PAYLOAD_TOO_LARGE");

    const { participantIds } = await getAuthorizedChat(uid, chatId);
    if (!participantIds.includes(recipientId)) throw new Error("INVALID_RECIPIENT");
    if (recipientId !== uid && await isBlockedEitherWay(uid, recipientId)) throw new Error("USER_BLOCKED");
    await consumeQuota(uid, "messages", MAX_MESSAGES_PER_MINUTE, 60_000);

    const queueRef = getDatabase().ref(`messageQueue/${recipientId}/${messageId}`);
    if (input.replaceExisting === true) await queueRef.remove();
    await queueRef.set(message);
    return { queued: true };
}

export async function createAuthorizedCallImpl(uid: string, input: Record<string, unknown>): Promise<{ callId: string }> {
    const callId = cleanId(input.callId);
    const chatId = cleanId(input.chatId);
    const type = input.type === "video" ? "video" : input.type === "audio" ? "audio" : "";
    if (!type) throw new Error("INVALID_CALL_TYPE");
    const { data, participantIds } = await getAuthorizedChat(uid, chatId);
    const recipients = participantIds.filter((id) => id !== uid);
    if (recipients.length === 0) throw new Error("NO_RECIPIENTS");
    const blockStates = await Promise.all(recipients.map((id) => isBlockedEitherWay(uid, id)));
    const allowedRecipients = recipients.filter((_, index) => !blockStates[index]);
    if (allowedRecipients.length === 0) throw new Error("USER_BLOCKED");

    const userDoc = await getFirestore().collection("users").doc(uid).get();
    const displayName = cleanText(userDoc.data()?.displayName, 64) || "Someone";
    const photoURL = cleanText(userDoc.data()?.photoURL, 2048);
    const startedAt = Date.now();
    const allowedIds = [uid, ...allowedRecipients];
    const allowedUserIds = Object.fromEntries(allowedIds.map((id) => [id, true]));
    const callData = {
        callId,
        chatId,
        initiatorId: uid,
        participants: {
            0: {
                userId: uid,
                displayName,
                muted: false,
                cameraEnabled: type === "video",
                ...(photoURL ? { photoURL } : {}),
            },
        },
        participantIds: { [uid]: true },
        allowedUserIds,
        type,
        status: "ringing",
        startedAt,
        ...(typeof data.groupId === "string" && data.groupId ? { groupId: data.groupId } : {}),
    };
    const updates: Record<string, unknown> = { [`calls/${callId}`]: callData };
    const indexEntry = { callId, chatId, initiatorId: uid, type, status: "ringing", startedAt, ...(callData.groupId ? { groupId: callData.groupId } : {}) };
    for (const id of allowedIds) updates[`userActiveCalls/${id}/${callId}`] = indexEntry;
    await getDatabase().ref().update(updates);
    return { callId };
}

export async function mutateAuthorizedCallImpl(uid: string, input: Record<string, unknown>): Promise<{ state: "updated" | "deleted" | "missing"; answeredBy?: string }> {
    const callId = cleanId(input.callId);
    const action = cleanText(input.action, 20);
    if (!new Set(["ack", "status", "join", "leave", "delete"]).has(action)) throw new Error("INVALID_ACTION");
    const callRef = getDatabase().ref(`calls/${callId}`);
    let previousAllowedIds: string[] = [];
    const result = await callRef.transaction((current) => {
        if (!current || typeof current !== "object") return;
        const call = current as Record<string, any>;
        const allowed = call.allowedUserIds && typeof call.allowedUserIds === "object" ? call.allowedUserIds : {};
        if (allowed[uid] !== true) return;
        previousAllowedIds = Object.keys(allowed).filter((id) => allowed[id] === true);
        if (action === "delete") return null;
        if (action === "ack") {
            if (call.status === "ringing") call.deliveryState = "ringing";
            return call;
        }
        if (action === "status") {
            const status = cleanText(input.status, 16);
            if (!new Set(["ringing", "connected", "ended", "failed"]).has(status)) return;
            call.status = status;
            if (status === "ended" || status === "failed") call.endedAt = Date.now();
            return call;
        }
        const participantMap = call.participants && typeof call.participants === "object" ? call.participants : {};
        const participants = Object.values(participantMap).filter((value): value is Record<string, any> => !!value && typeof value === "object");
        if (action === "join") {
            if (call.status === "ended" || call.status === "failed") return;
            if (!participants.some((participant) => participant.userId === uid)) {
                const displayName = cleanText(input.displayName, 64) || "Someone";
                const photoURL = cleanText(input.photoURL, 2048);
                participants.push({
                    userId: uid,
                    displayName,
                    muted: input.muted === true,
                    cameraEnabled: input.cameraEnabled === true,
                    ...(photoURL ? { photoURL } : {}),
                });
                call.participants = Object.fromEntries(participants.map((participant, index) => [String(index), participant]));
                call.participantIds = { ...(call.participantIds ?? {}), [uid]: true };
                call.status = "connected";
                call.answeredBy = cleanText(input.deviceId, 160);
            }
            return call;
        }
        const remaining = participants.filter((participant) => participant.userId !== uid);
        call.participants = Object.fromEntries(remaining.map((participant, index) => [String(index), participant]));
        const participantIds = { ...(call.participantIds ?? {}) };
        delete participantIds[uid];
        call.participantIds = participantIds;
        if (remaining.length <= 1) {
            call.status = "ended";
            call.endedAt = Date.now();
        }
        return call;
    });
    if (!result.committed) throw new Error("NOT_CALL_PARTICIPANT");
    if (!result.snapshot.exists()) {
        if (previousAllowedIds.length > 0) {
            const cleanup = Object.fromEntries(previousAllowedIds.map((id) => [`userActiveCalls/${id}/${callId}`, null]));
            await getDatabase().ref().update(cleanup);
        }
        return { state: previousAllowedIds.length > 0 ? "deleted" : "missing" };
    }
    const next = result.snapshot.val() as Record<string, any>;
    const indexEntry = {
        callId,
        chatId: next.chatId,
        initiatorId: next.initiatorId,
        type: next.type,
        status: next.status,
        startedAt: next.startedAt,
        ...(next.groupId ? { groupId: next.groupId } : {}),
    };
    const updates = Object.fromEntries(previousAllowedIds.map((id) => [
        `userActiveCalls/${id}/${callId}`,
        next.status === "ended" || next.status === "failed" ? null : indexEntry,
    ]));
    await getDatabase().ref().update(updates);
    return { state: "updated", ...(next.answeredBy ? { answeredBy: String(next.answeredBy) } : {}) };
}

export async function authorizeChatAccessImpl(uid: string, input: Record<string, unknown>): Promise<{ authorized: true }> {
    const chatId = cleanId(input.chatId);
    const { participantIds } = await getAuthorizedChat(uid, chatId);
    const membership = Object.fromEntries(participantIds.map((id) => [id, true]));
    await getDatabase().ref().update({
        [`chatMembers/${chatId}`]: membership,
        [`receipts/${chatId}/__participants`]: membership,
    });
    return { authorized: true };
}

export async function setBlockedUserImpl(uid: string, input: Record<string, unknown>): Promise<{ blocked: boolean }> {
    const targetUserId = cleanId(input.targetUserId);
    if (targetUserId === uid) throw new Error("CANNOT_BLOCK_SELF");
    const blocked = input.blocked !== false;
    const db = getFirestore();
    const ref = db.collection("users").doc(uid).collection("blockedUsers").doc(targetUserId);
    if (blocked) {
        await ref.set({ userId: targetUserId, createdAt: FieldValue.serverTimestamp() });
    } else {
        await ref.delete();
    }
    await getDatabase().ref(`blocks/${uid}/${targetUserId}`).set(blocked ? true : null);
    return { blocked };
}

export async function reportSafetyIssueImpl(uid: string, input: Record<string, unknown>): Promise<{ reportId: string }> {
    const chatId = cleanId(input.chatId);
    const messageId = cleanId(input.messageId);
    const reportedUserId = cleanId(input.reportedUserId);
    const reason = cleanText(input.reason, 40);
    const allowedReasons = new Set(["harassment", "hate", "sexual", "violence", "scam", "other"]);
    if (!allowedReasons.has(reason)) throw new Error("INVALID_REASON");
    const { participantIds } = await getAuthorizedChat(uid, chatId);
    if (!participantIds.includes(reportedUserId) || reportedUserId === uid) throw new Error("INVALID_REPORTED_USER");
    await consumeQuota(uid, "reports", MAX_REPORTS_PER_DAY, 24 * 60 * 60 * 1000);
    const reportId = randomUUID();
    await getFirestore().collection("safetyReports").doc(reportId).set({
        reportId,
        reporterId: uid,
        reportedUserId,
        chatId,
        messageId,
        messageType: cleanText(input.messageType, 24) || "unknown",
        excerpt: cleanText(input.excerpt, 500),
        reason,
        status: "open",
        createdAt: FieldValue.serverTimestamp(),
        source: "ios",
    });
    return { reportId };
}

export async function mutateGroupMemberImpl(uid: string, input: Record<string, unknown>): Promise<{ updated: true }> {
    const groupId = cleanId(input.groupId);
    const targetUserId = cleanId(input.targetUserId);
    const action = cleanText(input.action, 20);
    if (!new Set(["promote", "demote", "remove"]).has(action)) throw new Error("INVALID_ACTION");
    if (targetUserId === uid && action === "remove") throw new Error("USE_LEAVE_GROUP");
    const db = getFirestore();
    let nextIds: string[] = [];
    let nextMembers: GroupMember[] = [];
    await db.runTransaction(async (transaction) => {
        const ref = db.collection("groups").doc(groupId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error("GROUP_NOT_FOUND");
        const data = snapshot.data()!;
        const members = Array.isArray(data.members) ? data.members as GroupMember[] : [];
        const actor = members.find((member) => member.userId === uid);
        const target = members.find((member) => member.userId === targetUserId);
        if (!actor || !target) throw new Error("MEMBER_NOT_FOUND");
        if (target.role === "owner") throw new Error("OWNER_PROTECTED");
        if (action === "promote" || action === "demote") {
            if (actor.role !== "owner") throw new Error("OWNER_REQUIRED");
            nextMembers = members.map((member) => member.userId === targetUserId
                ? { ...member, role: action === "promote" ? "admin" : "member" }
                : member);
            nextIds = Array.isArray(data.memberIds) ? data.memberIds : nextMembers.map((member) => member.userId);
            transaction.update(ref, { members: nextMembers, updatedAt: FieldValue.serverTimestamp() });
            return;
        }
        if (actor.role !== "owner" && actor.role !== "admin") throw new Error("ADMIN_REQUIRED");
        if (actor.role === "admin" && target.role !== "member") throw new Error("OWNER_REQUIRED");
        nextMembers = members.filter((member) => member.userId !== targetUserId);
        nextIds = (Array.isArray(data.memberIds) ? data.memberIds as string[] : []).filter((id) => id !== targetUserId);
        const archived = (Array.isArray(data.archivedMembers) ? data.archivedMembers as GroupMember[] : [])
            .filter((member) => member.userId !== targetUserId);
        transaction.update(ref, {
            members: nextMembers,
            memberIds: nextIds,
            archivedMembers: [...archived, { ...target, role: "member", balance: 0, archived: true, archivedAt: Date.now(), archivedReason: "removed" }],
            updatedAt: FieldValue.serverTimestamp(),
        });
    });

    if (action === "remove") {
        const chats = await db.collection("chats").where("groupId", "==", groupId).limit(1).get();
        if (!chats.empty) {
            const chat = chats.docs[0];
            const data = chat.data();
            await chat.ref.update({
                participantIds: (Array.isArray(data.participantIds) ? data.participantIds as string[] : []).filter((id) => id !== targetUserId),
                participants: (Array.isArray(data.participants) ? data.participants as Array<Record<string, unknown>> : []).filter((member) => member.userId !== targetUserId),
                updatedAt: FieldValue.serverTimestamp(),
            });
        }
    }
    return { updated: true };
}
