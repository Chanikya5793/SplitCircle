# 28 — In-app account deletion

Research + implementation plan for letting a user permanently delete their account
from inside the app. Written as a companion to [doc 27](27_sign_in_with_apple.md) —
flagged there as a pre-existing gap, now researched and planned in full per
follow-up request.

> **Status (2026-07-23): shipped and verified end-to-end in production.**
> Functions deployed (`checkAccountDeletionBlockers`, `deleteAccount`, both
> `us-central1`). Verified live against a real account (`six@six.six`, a
> settled non-owner member of an 8-member group): blocker check ran clean →
> destructive confirm → server log `{"message":"Account deleted","uid":
> "Y6GxlcSTgpR3XVmM4tjiwZRMusy2"}` → client auto-signed-out. Confirmed via the
> Firebase Console, not just the client UI: the Auth user is gone from the
> Users list, `users/{uid}` reads "This document does not exist," and the
> group's `archivedMembers` array now has a correctly-shaped entry
> (`archivedReason: "account_deleted"`, `balance: 0`, right timestamp). The
> owner-blocks and unsettled-balance-blocks paths were not separately
> live-tested (no account in that state was on hand this pass) but share the
> same `findDeletionBlockers` code exercised — clean — during this run, and
> were adversarially code-reviewed (see below). See "Real bugs found & fixed
> during review (pre-ship)" below — a multi-dimension adversarial review
> caught six real issues in the first implementation pass, all fixed before
> deploy.

> **Updated by [doc 29](29_group_departure_balance_integrity.md):** this doc
> originally modeled account deletion's group-cleanup on `leaveGroup`'s
> then-current behavior, which did not check the caller's balance before
> departure. Doc 29 changes `leaveGroup` to block on a nonzero balance — account
> deletion must follow the same rule (see "Design decisions" and the Cloud
> Function sketch below, both updated) or it becomes a backdoor around that
> check. Read doc 29 first if you're implementing either feature.

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
    As of doc 29, it also blocks on a nonzero live balance ("settle up before
    leaving") — account deletion's cascade must enforce the same rule per group,
    not the weaker pre-doc-29 behavior. (Doc 29 also found and fixes a separate,
    more serious bug: editing an expense after someone's departure was silently
    dropping their share from the split. That fix is orthogonal to this doc's
    Cloud Function — it lives entirely in `AddExpenseScreen.tsx` — but it's why
    the balance shown/checked here can be trusted as accurate.)
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
- **Friends list lives in RTDB, one node per (owner, friend) pair:**
  `friends/{ownerUid}/{friendUid}`. **Correction (found during review, was wrong
  above):** this is NOT one-sided for the common case. Manual adds via
  [`friendsService.ts`](../../src/services/friendsService.ts)'s
  `addFriendManually` only write the adder's own node, but
  [`functions/src/friends.ts`](../../functions/src/friends.ts)'s
  `materializeMutualFriendship` — triggered for every shared-group or
  shared-debt pair — writes **both** `friends/{A}/{B}` and `friends/{B}/{A}` via
  the Admin SDK. So most real friendships in this app are bidirectional. Account
  deletion only clears the deleted user's own `friends/{uid}` node; every other
  user's `friends/{otherUid}/{uid}` reverse edge is left dangling on purpose —
  RTDB has no reverse index from a uid to "who has me as a friend," so cleaning
  those would need a full users scan. This is the same accepted tradeoff
  `archivedMembers` makes (a friend/former-member entry keeps resolving to a
  real name/photo forever instead of going "Unknown"), just not something that
  happens to be free here — it costs a full scan, so it's skipped.
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
  balance zeroed in the stored record (the *real* balance still recomputes live
  via `adaptGroup`, same as today), system message posted ("X's account was
  deleted" instead of "X left the group" — clearer to the remaining members than
  a generic leave message).
- **Per doc 29: any group with a nonzero live balance also blocks deletion**,
  same as `leaveGroup`'s new rule — not just owner-with-members. The blocker list
  returned to the client distinguishes "transfer ownership" from "settle up"
  reasons so the UI can give the right instruction per group.
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
     reason: "transfer_ownership" | "unsettled_balance";
     memberCount?: number;
     balance?: number;
   }

   /** Admin-side port of adaptGroup's balance replay (GroupContext.tsx:127),
    *  scoped to one group + one user — no client SDK available here. */
   function computeMemberBalance(data: FirebaseFirestore.DocumentData, uid: string): number {
     let balance = 0;
     for (const expense of data.expenses ?? []) {
       if (expense.paidBy === uid) balance += expense.amount;
       for (const p of expense.participants ?? []) {
         if (p.userId === uid) balance -= p.share;
       }
     }
     for (const settlement of data.settlements ?? []) {
       if (settlement.fromUserId === uid) balance += settlement.amount;
       if (settlement.toUserId === uid) balance -= settlement.amount;
     }
     return balance;
   }

   /** Groups that must be resolved before deletion: owned-with-other-members
    *  (transfer ownership first), or a nonzero live balance (settle up first —
    *  see doc 29, mirrors leaveGroup's rule). Re-run inside deleteAccount itself,
    *  not just trusted from an earlier client pre-check, to close the race where
    *  group state changes between check and confirm. */
   export async function findDeletionBlockers(uid: string): Promise<DeletionBlocker[]> {
     const db = getFirestore();
     const snap = await db.collection("groups").where("memberIds", "array-contains", uid).get();
     const blockers: DeletionBlocker[] = [];
     for (const doc of snap.docs) {
       const data = doc.data();
       const members = (data.members ?? []) as Array<{ userId: string; role: string }>;
       const me = members.find((m) => m.userId === uid);
       const groupName = data.name ?? "Untitled group";
       if (me?.role === "owner" && members.length > 1) {
         blockers.push({ groupId: doc.id, groupName, reason: "transfer_ownership", memberCount: members.length });
         continue; // ownership must be resolved first; balance is checked after re-running post-transfer
       }
       const balance = computeMemberBalance(data, uid);
       if (Math.abs(balance) >= 0.005) {
         blockers.push({ groupId: doc.id, groupName, reason: "unsettled_balance", balance });
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
     return (data as {
       blockers: Array<{
         groupId: string;
         groupName: string;
         reason: 'transfer_ownership' | 'unsettled_balance';
         memberCount?: number;
         balance?: number;
       }>;
     }).blockers;
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
   - If blockers non-empty → modal listing the group names, copy branched per
     `reason`: `transfer_ownership` → "Transfer ownership or delete this group
     first," linking into the group's member list; `unsettled_balance` →
     "Settle up {amount} in this group first" (same message shape as
     `leaveGroup`'s new error per doc 29), linking into the group's balances.
   - If clean → destructive confirm (`appAlert` with a "Delete" destructive
     button, or a typed-confirmation input for extra friction given this is
     irreversible) → `deleteAccountAndSignOut()` → on success, `user` becomes
     `null` and `AppNavigator` swaps to the auth stack automatically, same as any
     other sign-out.
6. **Verify:** create a throwaway test account, put it in a solo group, a
   multi-member group as a regular member (settled), a multi-member group as a
   regular member with an unsettled balance, and a multi-member group as owner;
   confirm the owner case and the unsettled-balance case both block with the
   right copy, the settled/solo cases get cleaned up correctly, and the Firebase
   Auth user + Firestore doc are actually
   gone afterward (check the Firebase console, not just the client UI).
7. **Ship:** `functions` changes need `firebase deploy --only functions` (or
   `npm run ship:ios:full`, which does that first) — this is a backend-only
   change, no new native dependency, no new build required for the client side
   beyond a normal JS bundle update.

## Real bugs found & fixed during review (pre-ship, 2026-07-23)

The plan above was implemented close to verbatim, then put through a
multi-dimension adversarial review before any deploy. Six real, reproducible
issues surfaced — none were hypothetical, all were confirmed against actual
file contents by an independent verification pass. All six are fixed in the
code as it stands now.

1. **`AuthContext.tsx`'s own `onSnapshot` listener on `users/{uid}` resurrected
   the just-deleted profile doc.** The listener's "doc doesn't exist" branch
   unconditionally treated a missing doc as "not created yet" and called
   `setDoc` to recreate it — a comment even said "to be safe (and for Google
   Sign In), we create it if missing." `deleteAccountCascade` deletes
   `users/{uid}` mid-cascade, well before the callable RPC returns; while that
   promise is still pending, the still-live listener sees the delete, and (since
   `firestore.rules`'s `allow create: if isSelf(userId)` only checks the JWT is
   still signature-valid, not that the Auth user still exists server-side)
   happily recreates it. This fired on the deleting device's own session AND,
   independently, on any other device signed into the same account — a second
   phone left logged in would resurrect the doc on its own, unrelated to
   whichever device actually ran the deletion. Fixed by tracking whether the
   listener has ever observed the doc existing this sign-in session
   (`hasSeenProfileDoc`, a local closure variable inside the
   `onAuthStateChanged` callback — naturally resets per sign-in, no manual
   reset needed): if it has, a later "missing" is a deletion, not a fresh
   account, and the fix is to sign out locally instead of recreating.
2. **`deleteAccountAndSignOut` resurrected the just-deleted `notificationDevices`
   doc.** It called `deleteAccountCallable()` (which deletes the whole
   `notificationDevices` subcollection server-side as part of the cascade)
   *before* `unregisterCurrentDevice()` — whose Admin-SDK-backed
   `set(..., {merge:true})` bypasses the client-side hard-deny rule and
   recreates the doc, because the client's cached ID token is still valid for a
   while after `admin.auth().deleteUser()` (Firebase doesn't check revocation
   by default). This wasn't a rare race — it fired on essentially every
   successful deletion. Fixed by reordering: unregister the device *before*
   calling `deleteAccountCallable()`, not after.
3. **Currency was silently dropped from the deletion-blocker alert.**
   `DeletionBlocker` never carried a `currency` field, so
   `SettingsScreen.tsx`'s "Settle up {amount} in this group first" copy always
   formatted the balance as USD regardless of the group's actual currency —
   every other `formatCurrency` call site in the codebase passes the group's
   currency explicitly. Fixed by adding `currency?: string` to `DeletionBlocker`
   (both the Cloud Function and the client mirror) and threading the group
   doc's `currency` field through.
4. **The two new callables skipped this codebase's error-observability
   convention.** Every comparable cascading callable (`triggerRecurringBillsForGroup`,
   `sendTestPushNotification`, `reportMissedCall`) wraps its cascading call in
   try/catch, logs a structured `logger.error` with `uid` + context, and
   rethrows a clean `HttpsError`. The new `checkAccountDeletionBlockers` and
   `deleteAccount` had none of that — a mid-cascade failure would leave no
   uid-tagged log entry to diagnose it by. Fixed by matching the existing
   pattern exactly (rethrow `HttpsError`s untouched, wrap anything else).
5. **`archivedReason: "account_deleted"` isn't a value `GroupMember`'s type
   allows.** `src/models/group.ts` typed `archivedReason` as `'left' | 'removed'`
   only, so `GroupInfoScreen.tsx`'s render (`archivedReason === 'left' ? 'Left'
   : 'Removed'`) would label a self-deleted account "Removed" — implying an
   admin kicked them, not that they closed their own account. Fixed by
   extending the union to include `'account_deleted'` and adding a third
   branch to the render ternary ("Account deleted").
6. **Batch-chunk ordering in the solo-group cascade delete put the group doc
   first**, so a group with enough linked docs to need multiple 450-op chunks
   would have its group doc vanish in chunk #1 before later chunks (holding
   most of the expenses/chats/bills) commit — if a later chunk then failed, the
   linked docs orphan permanently under a `groupId` nothing resolves to
   anymore. Fixed by moving the group doc's delete to the end of the list, so a
   failure partway through leaves the group doc (and thus a re-queryable
   `groupId`) intact for a retry to finish the job.

Also **corrected**, not a bug fix: the "Current state" section above originally
said the friends list is "one-sided by design." That's wrong for the common
case — `functions/src/friends.ts` writes friendships bidirectionally for any
shared-group/debt pair. The design decision (only clean the deleted user's own
`friends/{uid}` node, leave other users' reverse edges stale) is unchanged and
still correct, just for a different reason than originally stated (a full RTDB
scan to find reverse edges is disproportionate, not "there are no reverse
edges to clean").

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
