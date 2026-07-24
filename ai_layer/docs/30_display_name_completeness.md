# 30 — Display name completeness

Research + implementation-ready plan for a bug reported live in production: users
signing in with Apple can end up with a permanently empty `displayName`, which the
app then shows as literal placeholder-ish garbage (or, worse, nothing at all) in
dozens of places — including money-attribution UI. Researched via a multi-agent
Workflow (codebase audit + Apple's official docs + industry patterns + a 4-lens
brainstorm + synthesis) per explicit request, decisions below locked in with the
user via `AskUserQuestion` before writing this doc.

> **Status (2026-07-24): BUILT & deployed.** Implemented via a 12-agent
> Workflow (auth race fix, GroupContext system messages, money-critical UI
> rollout, chat surfaces + the live-lookup renderer, calls, friends, AI/
> search/stats narration, hidden-ledger, the new name-edit screen + 3-tier
> nudge, the Cloud Function backfill, and the local-message migration).
> The Workflow's own adversarial Review/Verify phases partially hit this
> account's session spend limit mid-run (2 of 3 review dimensions and 0 of 2
> verify dimensions completed) — the two completed reviews' findings were
> checked by hand instead: several real gaps confirmed and fixed (see
> CLAUDE.md's gotcha and the fix commit), everything else confirmed correct
> by direct inspection (the `relatedUserId` self-referential-vs-not table
> across all 7 write sites, the `MessageBubble` renderer's fallback
> behavior, `resolveDisplayName`'s no-op-for-real-names guarantee). Root +
> `functions/` typecheck clean, all 373+144+28 tests pass, confirmed live on
> Simulator (chat system messages resolving live names correctly, Settings
> nudge chip suppressed for a named user, no crashes). Functions + Firestore
> rules deployed. **Backfill run 2026-07-24**: invoked
> `backfillMissingDisplayNames()` directly against production (Admin SDK,
> authenticated via the same account that already deploys this project —
> the `runDisplayNameBackfill` onCall wrapper's `admin: true` claim gate was
> never granted to anyone; going straight to the underlying function was
> simpler and avoided a separate IAM-adjacent step). Result: `{scanned: 0,
> recovered: 0, skipped: 0, groupsUpdated: 0, errors: 0}` — zero accounts
> currently have a literal empty `displayName` in Firestore, so there was
> nothing to repair at run time. (The query is an exact `== ''` match, per
> `buildUserProfile`'s own contract of always writing a literal empty
> string, never `null`/`undefined`, for an unset name — this backfill would
> not catch an affected account whose field was missing entirely rather
> than an empty string, though no known write path in this codebase
> produces that shape.) Re-run the same approach if a future account is
> reported stuck this way. Real-device verification of the Apple sign-in
> path itself is still open per doc 27.

## Why this, why now

A real user hit this: after signing in with Apple, their name shows as "your
profile" instead of their actual name. That's the symptom. The root cause and its
blast radius are much bigger than one string.

## Root cause #1 — Apple's one-time name grant

Confirmed against Apple's own documentation
([Authenticating Users with Sign in with Apple](https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple)):

> "The API collects this information and shares it with your app the first time
> the user logs in using Sign in with Apple. If the user then uses Sign in with
> Apple on another device, the API doesn't ask for the user's name or email
> again. It collects the information again only if the user stops using Sign in
> with Apple and later reconnects to your app."

This is a **true one-time grant tied to the Apple ID↔app relationship**, not the
device. There is no API to re-request it. The only reset path is the user
manually revoking the app (Settings → [Apple ID] → Sign-In & Security → Apps
Using Apple ID) and reconnecting — corroborated by an Apple DTS engineer on the
[Developer Forums](https://developer.apple.com/forums/thread/708415). Apple's own
guidance is blunt: "immediately store it locally so your app can access it again
... in the event of a process or network failure" — capture-or-lose-it-forever,
by design.

**Apple's App Store Review guidelines do not require a display name**, and
5.1.1(v) actually cuts the other way by default ("Apps may not require users to
enter personal information ... except when directly relevant to the core
functionality"). For SplitCircle specifically, knowing *whose* name is on a
shared expense **is** core functionality — a real name is not incidental
metadata here the way it might be for, say, a note-taking app. That distinction
matters for the design decision below.

**Critical constraint found in Apple's Developer Forums**: Apple has rejected
apps under Guideline 4.0/4.8 for showing a screen that re-collects name/email
right after Sign in with Apple, reasoning that data "should already be provided
by the Authentication Services framework"
([thread 776815](https://developer.apple.com/forums/thread/776815),
[751115](https://developer.apple.com/forums/thread/751115),
[760302](https://developer.apple.com/forums/thread/760302)). Our case —
backfilling data Apple's API *returned empty* — is a defensible distinction, but
not one to bet App Review on. **This rules out a blocking gate as the primary
mechanism.**

## Root cause #2 — a real, independent race bug (found during this research, not previously known)

`AuthContext.tsx` has two independent, unsynchronized writers to the same
`users/{uid}` document:

- **Creation write** (`AuthContext.tsx:~223-231`, inside the `onSnapshot` "doc
  missing" branch): a full, unmerged `setDoc(docRef, buildUserProfile(firebaseUser), ...)`.
- **Name-capture write** (`AuthContext.tsx:~403-419`, inside `signInWithApple()`):
  `updateProfile(signedInUser, { displayName })` on Firebase Auth, then a
  Firestore merge write of `{ displayName, updatedAt }`.

These fire from two separate async chains (`onAuthStateChanged`'s effect vs.
`signInWithApple()`'s own await chain) with **no ordering guarantee** between
them. The doc's own existing comment claims same-client writes apply in enqueue
order — true only *within* one async chain, not across two independent ones. If
the creation write's `setDoc` executes *after* the merge write lands, it
overwrites `displayName` back to `''` using a `buildUserProfile(firebaseUser)`
snapshot captured before `updateProfile()` resolved — **permanently**, since
Apple never resends the name. Two compounding gaps: the merge write is
fire-and-forget (`.catch(() => undefined)`, no `console.error`, no retry), and
nothing calls `setUser()` locally after `updateProfile()` resolves — the
in-memory profile only self-heals on the *next* Firestore snapshot, leaving a
window where `GroupContext.tsx`'s `createGroup` (line ~391, `displayName:
user.displayName`, no guard) can capture and permanently propagate the empty
name if the user races into creating a group fast enough.

**This must be fixed regardless of any UX decision below** — every other part
of this plan assumes the capture pipe stops leaking, which today it doesn't.

## Root cause #3 — ~40+ scattered, inconsistent, mostly-broken fallback strings

A full-codebase audit (grep across every `.displayName` read site in `src/` and
`functions/src/`) found the ad-hoc-fallback pattern repeated **independently
at every call site**, with three distinct bug classes:

1. **`?? 'X'` is dead code for this bug.** `buildUserProfile` produces the
   literal empty string `''`, not `null`/`undefined`. `'' ?? 'Friend'` evaluates
   to `''`. Roughly half the "protected" call sites found use `??` and are
   silently broken for exactly the case this doc is about — including all 8
   occurrences in `FriendInfoScreen.tsx`, `ChatContext.tsx:687`, `functions/src/accountDeletion.ts:207`,
   and 5+ sites in the AI/search/stats-narration layer.
2. **No fallback at all — renders literally blank.** The worst class, and the
   one that makes this a correctness bug, not a cosmetic one:
   **`AddExpenseScreen.tsx`** (split chips, "Who paid?" picker, receipt-scanner
   member list — lines 226, 249, 398, 543, 1021, 1077, 1111) and **four
   independently duplicated `getInitials()` functions** in
   `src/components/BillSplit/{ParticipantList,WeightedRouletteWheel,AdvancedModeContent,RouletteWheel}.tsx`
   have zero protection. An affected user's payer chip, split checkbox, or
   avatar in the money-critical bill-split UI renders **completely blank and
   unlabeled** — not "Unknown," nothing. `RecurringBillsScreen.tsx`,
   `GroupInfoScreen.tsx` (member rows + avatar initials),
   `hiddenLedgerService.ts` (persists a group name like `" & Bob"`), and
   `MentionAutocomplete.tsx` have the same gap.
3. **Inconsistent guarded fallbacks.** Where a guard does exist and does fire,
   the actual word varies pointlessly by file — `'Unknown'`, `'Someone'`/`'someone'`,
   `'User'`/`'user'`, `'Direct Chat'`/`'Direct'`, `'Removed user'`, `'Friend'`,
   `'Call'`/`'Chat'`, plus four *different* avatar-initials conventions (`'?'`
   in the one shared `AvatarPhoto.tsx` component that's supposed to be
   universal per its own header comment, `'??'`, `'U'`/`'F'`, or the app's own
   initials "SP" in `ProfilePhotoUploader.tsx`) — sometimes two different words
   for the identical fallback concept in the *same file*
   (`useCallManager.ts:295` "Unknown" vs. `:335` "User" for the same
   `user.displayName`; `ChatRoomScreen.tsx:1467` "user" vs. `:1476` "User").

**Persisted consequences (worse than a render glitch — baked into permanent records):**
`GroupContext.tsx`'s six system-message call sites (join/leave/remove/rename/admin-role/Money-in-Chat)
all interpolate a raw, unguarded name into chat text that's written once and
never revisited — an empty name produces grammatically broken, permanently
stored lines like `" left the group"` (leading space, no name) or, via
`functions/src/accountDeletion.ts:266`, `"'s account was deleted"` (leading
apostrophe). `functions/src/groupJoin.ts` — the newest, most careful code in the
repo — already guards correctly and falls back to `'New member'`, but that
string is what gets *permanently written* into the group's `members[]`, the
chat's `participants[]`, and a chat line reading "New member joined the group"
— forever, unless something re-propagates the real name later, which nothing
currently does.

**One thing already built correctly, worth reusing rather than re-inventing:**
`src/services/profilePropagation.ts`'s `propagateProfileToGroups(userId, patch,
groups)` rewrites the denormalized `displayName` copy in every group's
`members`/`archivedMembers` array, and its guard (`patch.displayName.trim()`,
line ~26) is a real truthy check — it can never overwrite a real name with an
empty one. **It is currently only ever called with `{ photoURL }`**
(`ProfilePhotoUploader.tsx:83`) — nothing calls it with `{ displayName }`,
because **there is currently no UI anywhere in the app for a user to edit their
own display name after signup.** `RegisterScreen.tsx` collects a name once, at
email/password signup only; `ProfilePhotoUploader.tsx` only handles the photo.

## What big tech / the industry does about this

Researched via WebSearch across Apple Developer Forums, Firebase/FlutterFire/
react-native-firebase GitHub issues, and UX case studies. Named, citable
patterns:

1. **Capture-once, persist-forever** is the universally recommended (and only
   available) mitigation for Apple specifically — corroborated across
   [firebase-ios-sdk #10306](https://github.com/firebase/firebase-ios-sdk/issues/10306),
   [flutterfire #10057](https://github.com/firebase/flutterfire/issues/10057)/[#7274](https://github.com/firebase/flutterfire/issues/7274),
   [react-native-firebase #4046](https://github.com/invertase/react-native-firebase/issues/4046) —
   this is a well-known pain point specific to Apple's SDK, not something
   SplitCircle got uniquely wrong.
2. **Never a hard blocking re-collection screen post-Apple-auth** — see the App
   Store rejection threads above.
3. **Nil-coalesce to a soft default, never hard-block**, is the dominant
   code-level pattern in community answers.
4. **Email-derived smart default** — an
   [Auth0 Community thread](https://community.auth0.com/t/creating-a-new-user-in-the-dashboard-doesnt-populate-the-name-from-email-anymore/20119)
   describes defaulting a missing name to the email address/local-part. Treated
   as a recommended *display-time* pattern, not verified against a specific
   named consumer app.
5. **Low-friction, editable, reassurance-copy'd onboarding step** — Discord's
   post-signup username prompt ("You can always change this later!") is the
   commonly-cited shape for this kind of soft ask.
6. **Progressive/incentivized completion, non-blocking** — LinkedIn's
   profile-strength-meter pattern: visible incentive to complete a field,
   never a gate.

No citable example of a specific "retroactive backfill" strategy for
already-broken accounts was found publicly — this appears to be under-documented
industry-wide, likely because (per finding above) most apps don't hit this bug
class at all since only Apple has the one-time-grant quirk.

## The four brainstormed approaches, and what got decided

A 4-lens panel proposed independent solutions — blocking gate, soft nudge,
centralized fallback utility, prevent-and-backfill — then a synthesis pass
reconciled them. Locked decisions (confirmed with the user):

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Nudge assertiveness | **Soft, persistent, non-blocking** | Blocking gate | Apple's own forum-documented rejection pattern for post-Apple-auth re-collection; the gate's stated justification (protect money UI) is already fully covered by the fallback-utility fix below, which works with zero dependency on the user ever acting |
| Scope | **Universal** — same handling for any provider's empty name, not Apple-only | Apple-specific special-casing | One code path, future-proof; Google can also return an empty name in edge cases (e.g. restricted Workspace profiles) |
| Already-broken data | **Backfill live records, and rewrite past chat system messages** (see design below) | Leave chat history untouched | User's explicit call — see "System message re-rendering" below for how this is actually achievable given the local-first message architecture |
| Placeholder rendering | **Calm copy + distinct visual style**, not alarming copy | "Unnamed member"-style alarm copy | Reuses the app's existing archived-member visual treatment (italic/dimmed) rather than inventing new alarm language |

**Explicitly rejected across all lenses:** persisting an email-derived guessed
name into the *real* `displayName` field. Guessing "Chan" from
`chan@icloud.com` and writing it as fact into permanent money-attribution
history is worse than a clearly-marked placeholder — the guess belongs at
render time only, via the fallback utility, never as a write.

## Implementation plan

### 1. Fix the capture race (root cause #2) — `src/context/AuthContext.tsx`

- After `updateProfile()` resolves in `signInWithApple()`, call `setUser()`
  locally with the corrected name immediately — don't wait on a Firestore
  round-trip to self-heal.
- Switch the merge write (currently bare `.catch(() => undefined)`) to
  `mergeFields: ['displayName', 'updatedAt']` — the exact pattern already
  proven fixing the chat-reactions `merge: true` bug earlier this project
  (see the CLAUDE.md gotcha on it). Log failures via `console.error`, matching
  doc 27's own established convention for production-visible auth logging.
- Make the creation write (`setDoc` inside the `onSnapshot` "doc missing"
  branch) field-scoped or otherwise unable to regress an already-set name —
  it currently does a full unmerged overwrite using a `buildUserProfile`
  snapshot that can be stale relative to the in-flight name-capture write.

### 2. `resolveDisplayName()` / `resolveInitials()` — centralized utility

New `src/utils/identity.ts`:

```ts
type NameSource = { displayName?: string | null; email?: string | null } | null | undefined;

export const resolveDisplayName = (source: NameSource, fallback = 'Someone'): string => {
  const name = source?.displayName?.trim();
  if (name) return name;
  return fallback; // no email-derived guess written or rendered as if real — see rejection above
};

export const resolveInitials = (name: string | null | undefined, fallback = '?'): string => {
  const trimmed = name?.trim();
  if (!trimmed) return fallback;
  return trimmed.split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
};
```

Deliberately loose `source` type — accepts `User`, `GroupMember`,
`ChatParticipant`, `FriendRow`, `CallParticipant` as-is, no adapter needed.
Absorb `AvatarPhoto.tsx`'s existing (correct) `initialsFor()` into this file as
the single source, and delete the four duplicated BillSplit `getInitials()`
functions in favor of it.

**Rollout, ordered by stakes (highest first):**
1. `AddExpenseScreen.tsx`, the 4 BillSplit initials functions,
   `RecurringBillsScreen.tsx`, `SettlementsScreen.tsx`, `GroupInfoScreen.tsx`,
   `DebtsList.tsx`, `BalanceSummary.tsx` — every money-attribution surface
   with zero or dead-code protection today.
2. Every `?? 'X'` site (dead code for `''`) — mechanical swap to
   `resolveDisplayName(source, 'X')`, preserving each site's existing fallback
   word for now (consolidating the *words* themselves is a follow-up, not
   blocking this fix).
3. Persisted-write sites — `GroupContext.tsx`'s `createGroup` and system
   messages, `ChatContext.tsx:687`, `hiddenLedgerService.ts`,
   `useCallManager.ts:284`, `functions/src/accountDeletion.ts:207` — wrap the
   value going INTO Firestore/RTDB with `resolveDisplayName`, not just its
   eventual render.
4. `functions/src/` needs its own minimal duplicate (`functions/src/identity.ts`)
   — no shared import path exists between the two TS projects.

### 3. Name-edit screen — new, doesn't exist today

New `src/screens/settings/EditNameScreen.tsx` (or a bottom sheet, designer's
call at build time — reuse `RegisterScreen.tsx`'s `AppTextInput`/`canSubmit`
pattern either way). On submit: `updateDoc(userRef, { displayName })` →
Firebase Auth `updateProfile({ displayName })` (matching `buildUserProfile`'s
existing-wins precedence) → `propagateProfileToGroups(userId, { displayName },
groups)` — its second-ever caller, and the first for this field.

### 4. Soft, persistent nudge — three tiers, one computed flag

No new persisted field — `needsDisplayName(user) => !user?.displayName?.trim()`
in `src/utils/identity.ts`, computed inline wherever needed. Always in sync
with the real field with zero migration/write cost; nothing to drift.

1. **Settings-tab badge dot** — persistent across sessions, only clears when
   the flag flips false server-side (not independently dismissible — this is
   what makes it actually get noticed, per the research: a dismiss-once toast
   gets ignored forever, a badge that only clears on the real fix doesn't).
2. **Inline "Add your name" chip** on `SettingsScreen.tsx`'s own-profile row,
   next to the existing `{user?.displayName || 'Your profile'}` label — right
   where the user's eyes land after tapping through from the badge. Opens the
   new name-edit screen from (3).
3. **One-time toast**, first affected session only, fired from the post-Apple-
   sign-in success path: "We couldn't get your name from Apple — tap to add
   one." Dismissible, never repeats as a toast (tiers 1/2 remain).

### 5. Placeholder rendering style — reuse the existing archived-member treatment

Wherever `resolveDisplayName()`'s fallback actually renders (i.e., the user
never completed their name), apply the same visual treatment
`GroupInfoScreen.tsx` already uses for departed/archived members — dimmed,
italic text — rather than plain body text indistinguishable from a real name.
Calm copy ("Someone"), visually marked as provisional.

### 6. Cloud Function backfill for already-broken accounts

New export in `functions/src/` (mirrors `accountDeletion.ts`'s Admin-SDK
pattern): query `users` for empty `displayName`, `admin.auth().getUser(uid)`
for each — Firebase Auth's copy is the more reliable of the two writes (the
Firestore merge is the one that's historically been best-effort), so most
already-broken accounts likely still have the real name recoverable from Auth.
Where recoverable: backfill Firestore, then run the Admin-SDK equivalent of
`propagateProfileToGroups` into every group's `members[]`/`archivedMembers[]`.
Where Auth is *also* empty (capture never ran at all): no server-side recovery
exists — these accounts fall through to the nudge (section 4) same as any
newly-affected user.

### 7. System-message re-rendering — how "rewrite past chat messages" is actually achievable

Constraint: per this app's architecture, **messages are local-first — RTDB is
transit-only, deleted after delivery; there is no central Firestore store of
chat history to bulk-edit** (see CLAUDE.md's Architecture DNA). A server-side
migration cannot reach into every device's locally-stored message text. Two
parts, going forward and backward:

**Going forward — stop freezing names into text at all.** Add optional
structured fields to system messages: `systemEventKind` (`'member_joined' |
'member_left' | 'member_removed' | 'account_deleted' | 'group_renamed' |
'money_in_chat_updated' | 'role_changed_admin' | 'role_changed_member'`) and
`relatedUserId` — **not** the same as `senderId` in every case (confirmed by
reading the actual call sites: `promoteMember`/`demoteMember`'s system message
is sent with `senderId` = the *acting admin*, but the name embedded in the
text is the *target* member — these are different users). `content` stays
populated too (for search indexing, notification previews, and as a fallback
when live member data can't be resolved), but message-rendering components
prefer `systemEventKind` + a live `resolveDisplayName()` lookup against the
group's *current* member/archivedMembers list over the frozen `content` string
whenever both are present. This means a name fixed *after* a "joined the
group" message was sent automatically renders correctly everywhere that
message is later displayed — no backfill needed for anything sent after this
ships.

**Backward — a lazy, on-device, one-time-per-message migration**, run when a
chat's local history loads (cheap: local-only, no network). For each locally-
stored `type: 'system'` message missing `systemEventKind`, pattern-match
against the known old templates (`"X joined the group"`, `"X left the group"`,
`"X's account was deleted"`, `"X updated Money in Chat settings"`, `"X renamed
the group to ..."`) — the self-referential subset where `senderId` *is*
confirmed to be the same user whose name is embedded — and re-render using
`resolveDisplayName()` against that `senderId`'s current name, same template.
**Scoped deliberately to the self-referential subset only**: the
"removed"/"is now/no longer an admin" templates don't reliably map `senderId`
→ embedded name (see above), so auto-healing those from old stored text would
be a guess, not a fix — leave them as historical record. This is an honest
scope line, not a shortcut: chat history is lower-stakes than the money UI
this whole doc is really about, and guessing wrong in chat text is worse than
leaving an old message alone.

## Explicitly out of scope for this pass

- Consolidating the *words* used across already-correctly-guarded fallback
  sites (`'Unknown'` vs `'Someone'` vs `'User'` etc.) into one canonical word —
  real inconsistency, but cosmetic, not a correctness bug; a good follow-up
  once this ships.
- A retroactive fix for `hiddenLedgerService.ts`'s persisted group-name
  concatenation (`" & Bob"`) — same root cause, same fix once `resolveDisplayName`
  wraps that write site, no separate migration needed since it's not
  chat-history text.
- Any change to how Google or email/password signup collect names — both
  already reliably populate `displayName` today; this doc's universal-scope
  decision means they get the same *fallback/nudge* treatment if they ever
  don't, not new collection logic.
