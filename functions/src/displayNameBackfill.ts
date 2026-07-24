import {
    FieldValue,
    getFirestore,
    type DocumentData,
    type DocumentReference,
} from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import * as logger from "firebase-functions/logger";

const USERS_COLLECTION = "users";
const GROUPS_COLLECTION = "groups";

interface GroupMemberRecord {
    userId: string;
    displayName: string;
    [key: string]: unknown;
}

export interface DisplayNameBackfillResult {
    /** Users found with an empty Firestore displayName. */
    scanned: number;
    /** Of those, how many had a real name recoverable from Firebase Auth. */
    recovered: number;
    /** Of those, how many had NO recoverable name (Auth is also empty) — falls through to the client nudge (doc 30 §4). */
    skipped: number;
    /** Total group member/archivedMembers entries rewritten across all recovered users. */
    groupsUpdated: number;
    /** Per-user lookup/write failures — logged individually, doesn't abort the run. */
    errors: number;
}

const toSafeError = (error: unknown): { name?: string; message?: string } => {
    if (error instanceof Error) {
        return { name: error.name, message: error.message };
    }
    return { message: "Unknown error" };
};

/**
 * Admin-SDK mirror of src/services/profilePropagation.ts's patchMember,
 * scoped to displayName only (this backfill never touches photoURL). Same
 * guard: never overwrites a member entry with a blank name.
 */
const patchMemberDisplayName = (member: GroupMemberRecord, displayName: string): GroupMemberRecord => {
    if (!displayName.trim()) return member;
    return { ...member, displayName: displayName.trim() };
};

/**
 * Rewrites this user's denormalized displayName copy in every group's
 * members[]/archivedMembers[] they appear in (or ever appeared in). Admin-SDK
 * equivalent of propagateProfileToGroups (src/services/profilePropagation.ts)
 * — that file can't be imported here (functions/ is a separate TS project
 * with no shared import path to src/, the same reason identity.ts is a
 * deliberate hand-duplicate rather than a shared import). Returns the number
 * of group docs actually rewritten.
 */
const propagateDisplayNameToGroups = async (uid: string, displayName: string): Promise<number> => {
    const db = getFirestore();
    // memberIds array-contains is the same query GroupContext.tsx's own
    // groups listener uses (GroupContext.tsx:341) — the client-side
    // propagateProfileToGroups this mirrors has an identical blind spot: a
    // group where this user is ONLY in archivedMembers (fully departed, no
    // longer in memberIds) is invisible to both. Not a regression introduced
    // here; there's no indexed field to reach those groups server-side either
    // (Group has no flat archivedMemberIds array — only archivedMembers
    // objects, see src/models/group.ts). For a still-active membership this
    // still correctly patches BOTH members[] and archivedMembers[] below (a
    // rejoin can leave a stale archived entry alongside an active one).
    const snapshot = await db.collection(GROUPS_COLLECTION).where("memberIds", "array-contains", uid).get();

    let updated = 0;
    for (const doc of snapshot.docs) {
        const ref: DocumentReference = doc.ref;
        try {
            const wrote = await db.runTransaction(async (txn) => {
                const snap = await txn.get(ref);
                if (!snap.exists) return false;
                const data = snap.data() as DocumentData;

                const members = (data.members ?? []) as GroupMemberRecord[];
                const archivedMembers = (data.archivedMembers ?? []) as GroupMemberRecord[];
                const memberHit = members.some((m) => m.userId === uid);
                const archivedHit = archivedMembers.some((m) => m.userId === uid);
                if (!memberHit && !archivedHit) return false;

                const payload: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
                if (memberHit) {
                    payload.members = members.map((m) =>
                        m.userId === uid ? patchMemberDisplayName(m, displayName) : m,
                    );
                }
                if (archivedHit) {
                    payload.archivedMembers = archivedMembers.map((m) =>
                        m.userId === uid ? patchMemberDisplayName(m, displayName) : m,
                    );
                }
                txn.update(ref, payload);
                return true;
            });
            if (wrote) updated += 1;
        } catch (error) {
            logger.warn("displayNameBackfill: failed to propagate to group", {
                uid,
                groupId: ref.id,
                error: toSafeError(error),
            });
        }
    }

    return updated;
};

/**
 * One-time repair for accounts stuck with a permanently empty `displayName`
 * (ai_layer/docs/30_display_name_completeness.md §6) — the Apple one-time-
 * name-grant quirk (root cause #1) plus the AuthContext.tsx capture race
 * (root cause #2, fixed elsewhere in doc 30) left some already-created
 * accounts with `users/{uid}.displayName === ''` forever, since Apple never
 * resends the name on a later sign-in.
 *
 * Firebase Auth's copy of the name is the more reliable of the two writers
 * historically — the Firestore merge write is the one that's been
 * best-effort/racy (see AuthContext.tsx's capture-race gotcha in CLAUDE.md) —
 * so most already-broken accounts likely still have the real name sitting in
 * Auth even though Firestore went permanently empty. Where Auth is ALSO
 * empty (capture never ran at all, e.g. email/password signup that never set
 * a name), there's no server-side recovery: those users fall through to the
 * client-side nudge tiers built elsewhere in doc 30.
 *
 * Deliberately NOT wired into any client UI or screen — this repairs
 * historical data, it isn't part of the ongoing product flow. Intended to be
 * invoked once, manually, after this ships (Firebase Console's function
 * tester, `firebase functions:shell`, or a one-off authenticated
 * `httpsCallable` call), not on a recurring schedule — the capture-race fix
 * (doc 30 §1) is what stops NEW accounts from breaking this way going
 * forward, so there's nothing new for a scheduled re-run to catch.
 */
export async function backfillMissingDisplayNames(): Promise<DisplayNameBackfillResult> {
    const db = getFirestore();
    const auth = getAuth();

    // buildUserProfile (AuthContext.tsx) always produces a literal '' for an
    // unset name, never null/undefined — safe to query for the exact empty
    // string rather than scanning every user doc.
    const snapshot = await db.collection(USERS_COLLECTION).where("displayName", "==", "").get();

    const result: DisplayNameBackfillResult = {
        scanned: snapshot.size,
        recovered: 0,
        skipped: 0,
        groupsUpdated: 0,
        errors: 0,
    };

    for (const userDoc of snapshot.docs) {
        const uid = userDoc.id;

        let authUser;
        try {
            authUser = await auth.getUser(uid);
        } catch (error) {
            logger.warn("displayNameBackfill: failed to look up Auth user", { uid, error: toSafeError(error) });
            result.errors += 1;
            continue;
        }

        const recoveredName = authUser.displayName?.trim();
        if (!recoveredName) {
            // Auth is also empty — no server-side recovery possible. Falls
            // through to the client nudge (doc 30 §4) same as any
            // newly-affected user.
            result.skipped += 1;
            continue;
        }

        try {
            await userDoc.ref.update({ displayName: recoveredName, updatedAt: FieldValue.serverTimestamp() });
            const groupsUpdated = await propagateDisplayNameToGroups(uid, recoveredName);
            result.recovered += 1;
            result.groupsUpdated += groupsUpdated;
            logger.info("displayNameBackfill: recovered displayName from Auth", { uid, groupsUpdated });
        } catch (error) {
            logger.error("displayNameBackfill: failed to write recovered displayName", {
                uid,
                error: toSafeError(error),
            });
            result.errors += 1;
        }
    }

    logger.info("displayNameBackfill: run complete", result);
    return result;
}
