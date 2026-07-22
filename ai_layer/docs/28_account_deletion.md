# 28 — In-app account deletion

Research + implementation-ready plan for letting a user permanently delete their
account from inside the app. Not yet built. Written as a companion to
[doc 27](27_sign_in_with_apple.md) — flagged there as a pre-existing gap, now
researched and planned in full per follow-up request.

## Why this, why now

App Store Review Guideline 5.1.1(v): any app that lets a user create an account
must let them **initiate deletion of that account from within the app** — not just
deactivate it, and not require emailing support. This app has had account creation
(email/password, Google, and soon Apple per doc 27) since before this doc, with no
in-app deletion path anywhere. This is an existing compliance gap independent of
Sign in with Apple, but adding a second/third SSO provider raises the odds a
reviewer checks for it.

## Current state (as found in the codebase)

- **Nothing exists.** No "Delete account" entry in
  [`SettingsScreen.tsx`](../../src/screens/settings/SettingsScreen.tsx), no
  callable Cloud Function, no client service.
- **Firestore rules already assume deletion is server-only:**
  [`firestore.rules:124`](../../firestore.rules) has `allow delete: if false;` on
  `match /users/{userId}`, and the `notificationDevices` subcollection is
  `allow create, update, delete: if false;` too. A client SDK call can never
  delete these — this has to be a Cloud Function using the Admin SDK, which
  bypasses security rules entirely. That's actually a simplification: Firebase's
  usual "must re-authenticate before `deleteUser()`" requirement only applies to
  the **client** SDK's `auth.currentUser.delete()` — it does not apply to
  `admin.auth().deleteUser(uid)` called from a trusted server context. No
  re-auth/password-re-entry UI is needed.
- **`GroupContext.tsx` already has two directly reusable patterns:**
  - `leaveGroup` ([`GroupContext.tsx:1621`](../../src/context/GroupContext.tsx)):
    blocks if the caller is the group's `owner` ("Owners must promote another
    member to owner before leaving"); otherwise archives the member (`archived:
    true`, `balance: 0`, `archivedReason: 'left'`) and posts a system message.
    Crucially, **it does not check the caller's outstanding balance** — leaving
    with a nonzero balance already zeroes it in the archive today. This is an
    existing product decision (balance history stays visible to the group, but
    the leaving member's live balance doesn't block departure) — account deletion
    should follow the exact same rule, not invent a stricter one.
  - `deleteGroup` ([`GroupContext.tsx:1688`](../../src/context/GroupContext.tsx)):
    owner-only, batches-deletes the group doc + its `chats` docs + its `expenses`
    docs (capped at 450 ops, throws past that). **Does not delete matching
    `recurringBills` docs** (a separate top-level collection keyed by `groupId`,
    per [`firestore.rules:184`](../../firestore.rules)) — a pre-existing gap in
    `deleteGroup` itself, unrelated to this feature, noted here only because the
    account-deletion Cloud Function's group-cleanup path should not repeat it.
- **System messages don't live in a Firestore subcollection.** Per the
  architecture DNA in CLAUDE.md, messages are RTDB-transit + device-local, never
  Firestore. `writeGroupSystemMessage`
  ([`GroupContext.tsx:808`](../../src/context/GroupContext.tsx)) updates the
  chat doc's `lastMessage` preview, then calls
  `queueMessage(recipientId, message, true)` for each remaining participant.
  `queueMessage` ([`messageQueueService.ts:156`](../../src/services/messageQueueService.ts))
  writes to RTDB at `messageQueue/{recipientId}/{messageId}` — a Cloud Function
  replicating this must write to that same path via `admin.database()`, it can't
  reuse the client function directly (different SDK, different auth context).
- **Friends list lives in RTDB, one user's list per node:** `friends/{ownerUid}/
  {friendUid}` ([`friendsService.ts`](../../src/services/friendsService.ts)),
  one-sided by design (friending user A doesn't mirror into user B's list). Only
  the deleted user's own `friends/{uid}` node needs cleanup; other users'
  denormalized `displayName`/`photoURL` snapshots of the deleted user going stale
  is already-accepted behavior — the same tradeoff `archivedMembers` makes
  ("keeps displayName/photo resolvable forever so historical balances/debts don't
  render as Unknown").
- **No Firebase Storage rules file in this repo** (`firebase.json` has no
  `storage` key) and no profile-photo-upload code found — avatars in the current
  UI render as colored initials, not uploaded images. If a photo upload path gets
  added later, revisit whether deletion needs a Storage cleanup step; not needed
  today.
- **`functions/src/index.ts`** uses the `onCall` v2 HTTPS pattern throughout
  (`syncNotificationDevice`, `unregisterNotificationDevice`, etc.: `const uid =
  request.auth?.uid; if (!uid) throw new HttpsError('unauthenticated', ...)`) —
  the new `deleteAccount` function should match that exact shape.

## Design decisions (proposed defaults — flag if you want different behavior)

- **Owned groups with other members block deletion**, mirroring `leaveGroup`'s
  existing owner rule exactly. The client pre-checks and shows which groups need
  ownership transferred first, rather than surprising the user with a server
  error after they've already confirmed.
- **Solo-owned groups (the user is the only member) auto-delete** as part of
  account deletion — there's no one to transfer ownership to, and blocking on
  that would make deletion impossible for a common case (a user who made a
  personal-only tracking group). This reuses `deleteGroup`'s cascade (group +
  chats + expenses), extended to also sweep `recurringBills` for that `groupId`
  (fixing, for this path only, the gap noted above — not touching client-side
  `deleteGroup` itself, out of scope here).
- **Non-owner memberships get the same treatment as `leaveGroup`**: archived,
  balance zeroed, system message posted ("X's account was deleted" instead of
  "X left the group" — clearer to the remaining members than a generic leave
  message).
- **No re-authentication step** — per the Firestore-rules finding above, this is
  safe because deletion runs entirely through the Admin SDK server-side. A
  destructive-confirmation UI step (type "DELETE" or a two-tap confirm) still
  makes sense as a *mistake* guard, just not as a security requirement.

## Implementation plan

1. **`functions/src/accountDeletion.ts`** (new file, mirroring `recurringBills.ts`'s
   shape — a focused module imported into `index.ts`):
   ```ts
   import { getFirestore, FieldValue } from "firebase-admin/firestore";
   import { getDatabase } from "firebase-admin/database";
   import { getAuth } from "firebase-admin/auth";
   import * as logger from "firebase-functions/logger";

   export interface DeletionBlocker {
     groupId: string;
     groupName: string;
     memberCount: number;
   }

   /** Groups the caller owns with other members present — must be resolved
    *  (ownership transferred, or the other members removed) before deletion. */
   export async function findDeletionBlockers(uid: string): Promise<DeletionBlocker[]> {
     const db = getFirestore();
     const snap = await db.collection("groups").where("memberIds", "array-contains", uid).get();
     const blockers: DeletionBlocker[] = [];
     for (const doc of snap.docs) {
       const data = doc.data();
       const members = (data.members ?? []) as Array<{ userId: string; role: string }>;
       const me = members.find((m) => m.userId === uid);
       if (me?.role === "owner" && members.length > 1) {
         blockers.push({ groupId: doc.id, groupName: data.name ?? "Untitled group", memberCount: members.length });
       }
     }
     return blockers;
   }

   export async function deleteAccountCascade(uid: string): Promise<void> {
     const db = getFirestore();
     const rtdb = getDatabase();

     const groupsSnap = await db.collection("groups").where("memberIds", "array-contains", uid).get();

     for (const groupDoc of groupsSnap.docs) {
       const data = groupDoc.data();
       const members = (data.members ?? []) as Array<{ userId: string; role: string; displayName: string; photoURL?: string }>;
       const me = members.find((m) => m.userId === uid);

       if (me?.role === "owner" && members.length === 1) {
         // Solo-owned — cascade-delete the group itself (mirrors client deleteGroup,
         // plus the recurringBills sweep it's missing).
         const batch = db.batch();
         batch.delete(groupDoc.ref);
         const [chatsSnap, expensesSnap, billsSnap] = await Promise.all([
           db.collection("chats").where("groupId", "==", groupDoc.id).get(),
           db.collection("expenses").where("groupId", "==", groupDoc.id).get(),
           db.collection("recurringBills").where("groupId", "==", groupDoc.id).get(),
         ]);
         chatsSnap.forEach((d) => batch.delete(d.ref));
         expensesSnap.forEach((d) => batch.delete(d.ref));
         billsSnap.forEach((d) => batch.delete(d.ref));
         await batch.commit();
         continue;
       }

       // Otherwise: archive-remove, same shape as client leaveGroup/removeMember.
       const newMembers = members.filter((m) => m.userId !== uid);
       const archivedEntry = {
         userId: uid,
         displayName: me?.displayName ?? "Deleted user",
         ...(me?.photoURL ? { photoURL: me.photoURL } : {}),
         role: "member",
         balance: 0,
         archived: true,
         archivedAt: Date.now(),
         archivedReason: "account_deleted",
       };
       await groupDoc.ref.update({
         members: newMembers,
         memberIds: FieldValue.arrayRemove(uid),
         archivedMembers: FieldValue.arrayUnion(archivedEntry),
         updatedAt: FieldValue.serverTimestamp(),
       });

       // Best-effort system message — mirrors writeGroupSystemMessage's RTDB
       // queue shape (messageQueueService.ts), not its Firestore lastMessage
       // update (skippable here; the next client read reconciles from members[]).
       const chatSnap = await db.collection("chats").where("groupId", "==", groupDoc.id).limit(1).get();
       if (!chatSnap.empty) {
         const chatData = chatSnap.docs[0].data();
         const recipients = ((chatData.participantIds ?? []) as string[]).filter((id) => id !== uid);
         const messageId = db.collection("_").doc().id; // cheap UUID-shaped id
         const message = {
           senderId: uid,
           chatId: chatSnap.docs[0].id,
           content: `${archivedEntry.displayName}'s account was deleted`,
           type: "system",
           timestamp: Date.now(),
           isGroupChat: true,
         };
         await Promise.all(
           recipients.map((rid) =>
             rtdb.ref(`messageQueue/${rid}/${messageId}`).set(message).catch((err) =>
               logger.warn("account deletion: system message queue failed", { rid, err: String(err) }),
             ),
           ),
         );
       }
     }

     // Notification devices — client rules block writes here; Admin SDK doesn't.
     const devicesSnap = await db.collection("users").doc(uid).collection("notificationDevices").get();
     await Promise.all(devicesSnap.docs.map((d) => d.ref.delete()));

     // Own friends list (RTDB) — one-sided, see friendsService.ts.
     await rtdb.ref(`friends/${uid}`).remove().catch(() => undefined);

     await db.collection("users").doc(uid).delete();
     await getAuth().deleteUser(uid);
   }
   ```
2. **`functions/src/index.ts`** — two callables, matching the existing `onCall`
   style exactly:
   ```ts
   export const checkAccountDeletionBlockers = onCall(async (request) => {
     const uid = request.auth?.uid;
     if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
     const blockers = await findDeletionBlockers(uid);
     return { blockers };
   });

   export const deleteAccount = onCall(async (request) => {
     const uid = request.auth?.uid;
     if (!uid) throw new HttpsError("unauthenticated", "Authentication required.");
     const blockers = await findDeletionBlockers(uid);
     if (blockers.length > 0) {
       throw new HttpsError("failed-precondition", "Transfer ownership of your groups first.", { blockers });
     }
     await deleteAccountCascade(uid);
     logger.info("Account deleted", { uid });
     return { success: true };
   });
   ```
   Re-running `findDeletionBlockers` inside `deleteAccount` (not just trusting the
   client's earlier check) closes the race where a group's ownership changes
   between the pre-check and the confirm tap.
3. **Client service** — `src/services/accountDeletionService.ts`:
   ```ts
   import { httpsCallable, getFunctions } from 'firebase/functions';

   export const checkDeletionBlockers = async () => {
     const fn = httpsCallable(getFunctions(), 'checkAccountDeletionBlockers');
     const { data } = await fn();
     return (data as { blockers: Array<{ groupId: string; groupName: string; memberCount: number }> }).blockers;
   };

   export const deleteAccount = async () => {
     const fn = httpsCallable(getFunctions(), 'deleteAccount');
     await fn();
   };
   ```
4. **`AuthContext.tsx`** — add a thin wrapper that calls the service then tears
   down local state the same way `signOutUser` does:
   ```ts
   const deleteAccountAndSignOut = async () => {
     await deleteAccount(); // throws HttpsError('failed-precondition', ...) with blockers if any remain
     await unregisterCurrentDevice().catch(() => undefined);
     await clearCachedProfile();
     await signOut(auth); // local-only once the Auth user no longer exists server-side
   };
   ```
   Add to `AuthContextValue` / the memoized `value`, matching the existing shape.
5. **UI — `SettingsScreen.tsx`:** a "Delete account" row in a danger-zone section
   (mirrors the existing destructive-action patterns like "Leave group"/"Remove
   from group" `appAlert` confirmations elsewhere in the app):
   - Tap → call `checkDeletionBlockers()`.
   - If blockers non-empty → modal listing the group names, "Transfer ownership
     or delete these groups first," with a link into each group's member list.
   - If clean → destructive confirm (`appAlert` with a "Delete" destructive
     button, or a typed-confirmation input for extra friction given this is
     irreversible) → `deleteAccountAndSignOut()` → on success, `user` becomes
     `null` and `AppNavigator` swaps to the auth stack automatically, same as any
     other sign-out.
6. **Verify:** create a throwaway test account, put it in a solo group, a
   multi-member group as a regular member, and a multi-member group as owner;
   confirm the owner case blocks with the right group name, the other two get
   cleaned up correctly, and the Firebase Auth user + Firestore doc are actually
   gone afterward (check the Firebase console, not just the client UI).
7. **Ship:** `functions` changes need `firebase deploy --only functions` (or
   `npm run ship:ios:full`, which does that first) — this is a backend-only
   change, no new native dependency, no new build required for the client side
   beyond a normal JS bundle update.

## Out of scope for this pass

- Apple's server-to-server notifications for Apple ID revocation/deletion
  (mentioned in doc 27) — separate integration, not required for this flow to
  work correctly today.
- A grace period / "restore within 30 days" pattern some apps use — Apple's
  guideline requires deletion to be *reachable*, not necessarily instant; a grace
  period is a valid alternative design but adds real complexity (soft-delete
  flag, restore flow, scheduled hard-delete job) not justified unless requested.
- Fixing `deleteGroup`'s pre-existing `recurringBills` cleanup gap for its own
  (non-account-deletion) call path — noted for awareness, not touched here.
