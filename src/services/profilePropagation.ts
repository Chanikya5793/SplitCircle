/**
 * profilePropagation.ts — keep denormalized identity copies in sync.
 *
 * A user's displayName/photoURL is embedded in every group's `members` array
 * (and mirrored from there onto friend records by FriendsScreen's self-heal).
 * Those copies were written once at join time and never updated, so profile
 * photo changes never reached friends' devices. After a profile edit, call
 * `propagateProfileToGroups` to rewrite this user's member entry in each group.
 *
 * Best-effort by design: each group updates in its own transaction, failures
 * are logged and skipped (offline edits propagate the next time the user
 * changes their profile while online; the `users/{uid}` doc is authoritative).
 */

import { db } from '@/firebase';
import type { Group, GroupMember } from '@/models';
import { doc, runTransaction } from 'firebase/firestore';

interface ProfilePatch {
  displayName?: string;
  photoURL?: string | null;
}

const patchMember = (member: GroupMember, patch: ProfilePatch): GroupMember => {
  const next = { ...member };
  if (patch.displayName !== undefined && patch.displayName.trim()) {
    next.displayName = patch.displayName.trim();
  }
  if (patch.photoURL !== undefined) {
    // Firestore arrays can't hold undefined — use deletion via omission.
    if (patch.photoURL === null) {
      delete next.photoURL;
    } else {
      next.photoURL = patch.photoURL;
    }
  }
  return next;
};

/** Rewrite this user's member entry in each given group. Returns #updated. */
export const propagateProfileToGroups = async (
  userId: string,
  patch: ProfilePatch,
  groups: Group[],
): Promise<number> => {
  let updated = 0;
  for (const group of groups) {
    const isMember =
      group.members.some((m) => m.userId === userId) ||
      (group.archivedMembers ?? []).some((m) => m.userId === userId);
    if (!isMember) continue;

    try {
      await runTransaction(db, async (txn) => {
        const ref = doc(db, 'groups', group.groupId);
        const snap = await txn.get(ref);
        if (!snap.exists()) return;
        const data = snap.data() as Group;

        const payload: Record<string, unknown> = {};
        if ((data.members ?? []).some((m) => m.userId === userId)) {
          payload.members = data.members.map((m) =>
            m.userId === userId ? patchMember(m, patch) : m,
          );
        }
        if ((data.archivedMembers ?? []).some((m) => m.userId === userId)) {
          payload.archivedMembers = (data.archivedMembers ?? []).map((m) =>
            m.userId === userId ? patchMember(m, patch) : m,
          );
        }
        if (Object.keys(payload).length > 0) txn.update(ref, payload);
      });
      updated += 1;
    } catch (error) {
      console.error(`Failed to propagate profile to group ${group.groupId}`, error);
    }
  }
  return updated;
};
