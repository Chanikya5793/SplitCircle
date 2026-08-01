# CLAUDE.md — agent entry point

SplitCircle: Splitwise + WhatsApp + FaceTime in one RN app. iOS-first (iOS 26 SDK,
tested on iOS 27). Expo SDK 55, RN 0.83, Hermes, New Architecture, TypeScript strict.
App Store name: **ManaSplit** (bundle `com.splitcircle.app`, ascAppId 6760814898).

Docs: [DESIGN.md](DESIGN.md) (binding UI rules) · [OPS.md](OPS.md) (ship/credentials/calls infra) ·
[README.md](README.md) (setup) · [ai_layer/docs/17](ai_layer/docs/17_chatbot_pipeline_v2.md) (on-device
chat pipeline + Private Cloud Compute escalation) ·
[ai_layer/docs/18](ai_layer/docs/18_app_intents_siri_pcc_indexing.md) (Siri / App Intents / Spotlight
indexing — iOS 27, iOS-only) · [ai_layer/docs/19](ai_layer/docs/19_widgets_and_siri_control.md)
(widgets + Siri app-control + the one-time widget-target runbook) ·
[ai_layer/docs/20](ai_layer/docs/20_native_search_tab.md) (native UISearchTab search — the
react-native-screens patch, bridge, behavioral contract; READ BEFORE touching search or tabs) ·
[ai_layer/docs/21](ai_layer/docs/21_money_in_chat.md) (Money-in-Chat blueprint — locked product
decisions for expenses⇄chat integration; the contract for that build) ·
[ai_layer/docs/22](ai_layer/docs/22_stats_insights.md) (stats/insights engine, AI tiers,
chat digests, budgets — incl. the PCC simulator-crash gotcha; READ BEFORE touching PCC) ·
[ai_layer/docs/23](ai_layer/docs/23_insights_chat_threads.md) (insights chat + the
app-wide AI thread framework — locked decisions, thread store, PCC enrollment checklist) ·
[ai_layer/docs/24](ai_layer/docs/24_agentic_ai_pipeline.md) (agentic "one brain" pipeline —
JS tool loop, clarify chips, streaming, PCC depth engine, local-tier privacy rule; the
binding contract for BOTH AI surfaces — READ BEFORE touching assistant/insights chat) ·
[ai_layer/docs/25](ai_layer/docs/25_ai_flywheel_memory_search.md) (quality flywheel —
👎-to-fixture evals, AI memory + ledger, search-tab answer card; locked build order Q1→Q3) ·
[ai_layer/docs/26](ai_layer/docs/26_recurring_bills_v2.md) (Recurring Bills v2 — stateful chat
bill cards, fixed/variable, payer rotation, pattern detection, 1:1 accept-per-occurrence;
locked contract, sequenced AFTER doc 25 Q1→Q3) ·
[ai_layer/docs/27](ai_layer/docs/27_sign_in_with_apple.md) (Sign in with Apple — BUILT &
shipped to TestFlight 2026-07-24 (build 0.0.154), verified end-to-end on Simulator with a
real Apple ID; App Store Guideline 4.8 compliance since Google is already offered; the actual
bug wasn't the nonce/entitlement code, it was a missing GCIP Identity Providers registration
— see the CLAUDE.md gotcha above and doc 27's "Real bug found & fixed" section; NOT yet
verified on a physical device, TestFlight-only so far; see doc 30 for a related open issue —
Apple's one-time-only name grant can leave `displayName` empty) ·
[ai_layer/docs/28](ai_layer/docs/28_account_deletion.md) (in-app account deletion —
BUILT & shipped 2026-07-23, verified end-to-end in production against a real account
(Auth user + Firestore doc confirmed gone via the Firebase Console, group
`archivedMembers` entry confirmed correctly shaped); App Store Guideline 5.1.1(v)
compliance; Cloud-Function-only since Firestore rules hard-deny client deletes on
`users/{uid}`; honors doc 29's balance-check rule; a live Firestore `onSnapshot`
listener resurrecting a just-deleted `users/{uid}` doc was the nastiest of six bugs
an adversarial review caught pre-ship — see doc 28's "Real bugs found & fixed"
section before touching any other cascading-delete feature) ·
[ai_layer/docs/29](ai_layer/docs/29_group_departure_balance_integrity.md) (group
departure balance integrity — BUILT & shipped: fixed `AddExpenseScreen.tsx`'s
`billSplitParticipants` silently dropping a departed participant's share on edit,
added a settle-up-before-leaving gate to `leaveGroup` + a balance warning to
`removeMember`, and fixed a separate pre-existing Firestore rules gap that made
every `leaveGroup`/`removeMember` call fail outright — see the `isGroupDepartureUpdate`
gotcha below. READ before touching expense editing, `leaveGroup`, `removeMember`, or
doc 28's Cloud Function, which still needs the matching balance check doc 29 added) ·
[ai_layer/docs/30](ai_layer/docs/30_display_name_completeness.md) (display name
completeness — BUILT & deployed 2026-07-24: Sign in with Apple's one-time-only
name grant plus a real `AuthContext.tsx` write-ordering race could leave
`displayName` permanently empty; ~40+ places across the app showed inconsistent,
mostly-broken ad-hoc fallback strings instead, including *zero* fallback in
`AddExpenseScreen.tsx`'s split UI and five (not four — a `MessageInfoScreen.tsx`
copy was missed by the original audit) duplicated `getInitials()` — blank,
unlabeled chips in money-attribution UI, the worst class of bug this doc found;
universal `resolveDisplayName()`/`resolveInitials()` in `src/utils/identity.ts`
is now the ONLY sanctioned way to handle a possibly-empty name, never hand-roll
another `|| 'X'`/`?? 'X'` at a new call site; the one-time production backfill
Cloud Function exists but hasn't been invoked yet, gated on a custom admin claim
— see doc 30's status note before assuming existing broken accounts are fixed) ·
[ai_layer/docs/34](ai_layer/docs/34_linked_device_sync_v2.md) (linked-device
sync v2 — RESEARCHED 2026-07-31, decisions LOCKED, nothing built. Diagnoses why
a reinstalled device never syncs: `syncGapService`'s SCOPE GUARD skips any chat
with ZERO local messages, and the history handoff it defers to is one-shot per
device lifetime — so "should have history, has none" is covered by NEITHER
mechanism, permanently and silently. Also locks the move from per-message
gap-fill replay (M messages x D devices of encryptions, RTDB writes and function
invocations) to ONE encrypted, signed JSON batch per chat range) ·
[ai_layer/docs/32](ai_layer/docs/32_nearby_messaging_offline_sync.md) (nearby
mesh + multi-device delivery — RESEARCHED 2026-07-30, fix plan LOCKED. **Read
§10 FIRST if messaging is broken**: §1-§9 are the OFFLINE mesh queue, §10 is
two ONLINE bugs that are what users actually hit. ALL of §5 + §10 are BUILT;
§5d's `repairChatAudience` Cloud Function is deployed and has a live caller.
The remaining gap is that nothing native is device-verified. Root
causes worth knowing before touching this area: (1) `queueMessageToOwnDevices`
defaulted to the strict `'all-devices'` encryption coverage policy, so ONE
unreachable sibling device silently stopped your own messages reaching ALL your
linked devices — self-sync must use `'available-devices'`, see the gotcha
below; (2) two native paths replaced the whole shared `MCSession` to fix one
peer, so any invitation timeout or routine trust refresh disconnected every
device and 3+ devices could never mesh; (3) direct chats were excluded from
`flushMeshCloudRelay` on the belief that DMs are mesh-only, which they never
were — a DM sent online already uses the identical RTDB `queueMessage` path, so
the exclusion just meant an offline DM died at the 7-day TTL; `originOwned`,
not chat type, is what stops a relay impersonating a sender; (4) a FIFO
break-on-error in `flushMeshCloudRelay` blocked the ENTIRE queue on one stuck
operation — ordering is a per-conversation guarantee, so it is now bucketed
per chat with bounded retry).

## Architecture DNA (do not break)

Local-first, WhatsApp-style. Three tiers:

| Tier | Tech | Holds | Lifetime |
|---|---|---|---|
| Transit | Firebase RTDB | message queue, call signaling (`/calls`, `/userActiveCalls`) | deleted after delivery/hangup |
| Local | AsyncStorage + files | messages, call history, media, wallpapers, split history | permanent on device |
| Persistent | Firestore | profiles, groups, chats metadata, expenses | permanent on server |

- Never store messages/calls in Firestore. Never let RTDB accumulate (reapers exist).
- Calls: RTDB signaling + LiveKit media + CallKit/PushKit native UI. CallKit UUIDs are
  deterministic uuidv5 (namespace `6f9b8e2a-1c3d-4b5e-8a7f-0d1e2c3b4a59`) — server and
  client must stay byte-identical.
- Keys/tokens: never in the repo. Client env via `.env` (`EXPO_PUBLIC_*`), server via
  `firebase functions:secrets:set`.

## Commands

```bash
npx tsc --noEmit                 # typecheck (4 pre-existing test-lib errors are known)
npm run ship:ios                 # build local .ipa + deliver to App Store Connect (headless)
npm run ship:ios:full            # + firebase deploy (functions, firestore rules) first
firebase deploy --only functions,firestore:rules
```

**JS-only change → verify on sim without a build** (native deps unchanged only):

```bash
APP=$(xcrun simctl get_app_container <booted-sim-udid> com.splitcircle.app app)
npx expo export:embed --entry-file index.ts --platform ios --dev false \
  --bundle-output "$APP/main.jsbundle" --assets-dest "$APP"
xcrun simctl terminate <udid> com.splitcircle.app && xcrun simctl launch <udid> com.splitcircle.app
```

Do NOT run local sim Release builds (`expo run:ios --configuration Release`) — banned,
they hog the Mac. Native changes → `npm run ship:ios` or eas build.

## Gotchas that have burned us

- **This Firebase project is on Google Cloud Identity Platform (GCIP), not vanilla
  Firebase Auth — check the Console page header ("Authentication with Identity
  Platform" confirms it) before trusting any generic Firebase Auth tutorial/doc.**
  GCIP has a THIRD provider-config surface beyond the Firebase Console's
  "Authentication → Sign-in method" panel: the separate Google Cloud Console, at
  `console.cloud.google.com/customer-identity/providers` → provider → Edit, with its
  own "Platform" checkboxes (iOS/Android/Web) and a per-platform Bundle ID/Client ID
  field. Sign in with Apple (doc 27) failed with `auth/invalid-credential` ("The
  audience in ID Token [...] does not match the expected audience") for hours of
  otherwise-correct setup — Firebase Console's Apple toggle was Enabled, the iOS
  app's bundle ID was correctly registered in Project Settings, the identity
  token's `aud`/nonce were both independently verified correct — because none of
  that is where GCIP reads the expected native audience from. The fix was on the
  Google Cloud Console's Identity Providers page: Apple provider had zero Platform
  checkboxes checked. Diagnosed by decoding the identity token's own JWT claims
  client-side and logging via `console.error` (production bundles need this, not
  `debugLog`/`__DEV__`-gated logs) while capturing device logs live via `xcrun
  simctl spawn <udid> log stream --predicate 'process == "SplitCircle"'` — don't
  guess at Firebase/GCIP config errors from the generic error code alone, the real
  `.message` and a decoded token tell you exactly what's wrong. Before adding ANY
  new federated/OIDC sign-in provider, check the Google Cloud Console's Identity
  Providers page, not just the Firebase Console.
- **`firestore.rules`'s `groups/{groupId}` update rule must have a branch for every
  membership-shape change, or that write fails silently for everyone, forever.**
  `isGroupJoinUpdate` (grow `members`/`memberIds` by one, self only) had no mirror —
  `leaveGroup`/`removeMember` shrink the same fields plus grow `archivedMembers`, a
  shape none of the three `allow update` branches permitted. Every call to either
  function failed with `permission-denied` client-side (looked like an app bug, was a
  rules bug) until `isGroupDepartureUpdate` was added (doc 29). Before adding any new
  way a group doc's `members`/`memberIds`/`archivedMembers` can change, check it has a
  matching rule branch — the client code shipping cleanly (`tsc`, tests, even a
  simulator run against cached/local state) proves nothing about whether Firestore
  will actually accept the write. **Same bug bit `isGroupJoinUpdate` itself later
  (2026-07-23):** `joinGroup` (`GroupContext.tsx`) always writes `archivedMembers` too
  (purging the joiner's own stale archived entry on rejoin), but the rule's
  `affectedKeys().hasOnly([...])` list didn't include it — every invite-code join
  failed with `permission-denied`, discovered only while manually constructing
  multi-member test data for doc 28's deletion-blocker verification (nothing in the
  existing test suite exercises the real invite-code join path). Fixed by adding
  `'archivedMembers'` to `isGroupJoinUpdate`'s allowed keys. **The invite-code LOOKUP
  itself was a separate, deeper bug, fixed 2026-07-24:** `joinGroup`'s
  `where('inviteCode', '==', code)` query against `groups` required read access
  (`allow read: if request.auth.uid in resource.data.memberIds`) that a non-member
  provably can never satisfy; Firestore rejects the entire query outright (it
  evaluates rules against a query's *potential* result set, not the actual matched
  docs — a rule Firestore can't statically prove safe for a query denies unconditionally,
  regardless of what the data actually contains). No client-side rule tweak could fix
  this. Fixed by moving the ENTIRE join operation server-side: `joinGroupByInviteCode`
  (`functions/src/groupJoin.ts`, wrapped as an `onCall` in `index.ts`) does the
  invite-code lookup, archivedMembers purge, member/chat writes, and RTDB system
  message all via the Admin SDK (bypasses rules entirely, matching the
  `checkAccountDeletionBlockers`/`deleteAccount` pattern), and the client's `joinGroup`
  (`GroupContext.tsx`) is now a thin wrapper calling it
  (`src/services/groupJoinService.ts`). Verified end-to-end through the real app UI
  (not just the Firebase Console workaround): a fresh account joined a group via
  invite code and appeared correctly in that group's member list. Before adding any
  OTHER client Firestore query that needs to run before the querying user has
  read-granting membership/participant status on the target collection, assume it
  will hit this same Firestore query-provability wall — route it through a Cloud
  Function instead of trying to loosen the read rule.
- **Never `setDoc(ref, data, { merge: true })` when `data` has a nested map/object field
  you might need to shrink (e.g. delete a key).** Firestore's plain `merge: true`
  recursively merges nested objects — it can only ADD/overwrite keys present in the new
  value, never remove one that's simply absent from it. This silently broke chat
  reaction removal for good:
  [`publishMessageState`](src/services/messageStateService.ts) published the toggled
  `reactions` map (a `Record<emoji, userId[]>`) with bare `merge: true`; removing your
  only/last reaction produced `{}`, which is a complete no-op server-side, so the old
  reaction stayed forever. Worse, `subscribeToMessageStates` stays live on the writer's
  OWN device while a chat is open, so the echo of that under-merged write flowed
  straight back through `applyRemoteMessageState` and stomped the correct local
  optimistic removal — the bug reproduced even for the person removing their own
  reaction, not just other participants. A first fix attempt (2026-07-22) added a
  `reactionsLocalVersion` ordering guard to `applyRemoteMessageState`
  (`src/services/localMessageStorage.ts`) on the theory the culprit was a *stale*
  replay; it didn't help, because the echoed doc isn't stale-by-timestamp, it's the
  server's current-but-wrong state. Fixed by switching to Firestore's `mergeFields`
  option (`mergeFields: Object.keys(data)`), which makes each *listed* top-level field
  a full replace instead of a recursive merge, while leaving sibling fields untouched —
  same "partial update" contract, correct deletion semantics. Before adding any new
  `setDoc(..., { merge: true })` call whose payload includes a map/array-of-objects
  field that a later write might need to shrink, use `mergeFields` (or per-key
  `deleteField()` sentinels) instead.
- **`stripUndefinedDeep` (`GroupContext.tsx`) must never wrap an `arrayUnion()`/
  `serverTimestamp()`/other Firestore `FieldValue` sentinel — only the plain-data
  object nested inside one.** It recurses into ANY value where `typeof === 'object'`
  via `Object.entries()` → `Object.fromEntries()`, including FieldValue sentinels
  (e.g. `arrayUnion('x')` is really `ArrayUnionFieldValueImpl { _methodName:
  'arrayUnion', _elements: ['x'] }` — verified by inspecting it directly in a Node
  REPL). Reconstructing that via `Object.fromEntries` produces a plain object with
  those same two keys, which is no longer `instanceof` the real sentinel class —
  Firestore's SDK then serializes it as a literal garbage map field instead of
  performing the union/timestamp write. This silently broke `joinGroup`,
  `leaveGroup`, and `removeMember` (`stripUndefinedDeep({ ..., updatedAt:
  serverTimestamp() })` at each call site) — found 2026-07-23 while debugging why
  `joinGroup`'s batch write kept failing rules validation (the mangled `memberIds`/
  `members` fields came back as `{_methodName, _elements}` maps instead of arrays,
  so `.size()`/`.hasAll()` calls in the rule errored out). Confirm any FieldValue
  sentinel with `Object.entries(arrayUnion('x'))` before trusting a generic
  deep-sanitizer won't mangle it — the fix is to strip only the inner plain-data
  object (e.g. `arrayUnion(stripUndefinedDeep({...plainFields}))`), never the
  outer payload that contains the sentinel call itself.
- **A pod that ships its own `OTHER_LDFLAGS` to link a vendored archive is BROKEN
  under this project's static linkage — and every wrong fix for it still builds
  green.** This project must stay on `use_frameworks! :linkage => :static`
  (Expo's `ExpoModulesCore`/`ExpoModulesJSI` set `static_framework = true`, so a
  dynamic default hard-fails CocoaPods'
  `verify_no_static_framework_transitive_dependencies` validator — and that
  failure aborts *before* `Pods.xcodeproj`/`Podfile.lock` are regenerated, so a
  later Xcode build silently succeeds against the STALE static project. Never
  trust `pod install`'s exit code or a downstream green build: grep the
  generated xcconfig/pbxproj for the setting you think you changed). A static
  framework target is assembled by `libtool`/`ar`, which never invokes `ld`, so
  any `OTHER_LDFLAGS` in a pod's `pod_target_xcconfig` is **silently discarded**
  — this is how `LibSignalClient` (doc 31 Phase 3) ended up with hundreds of
  undefined `_signal_*` symbols at the app link. Forcing just that pod's
  `MACH_O_TYPE = mh_dylib` in `post_install` looks like the fix and is a trap:
  it links, archives, and uploads fine, but CocoaPods computed the app's
  `[CP] Embed Pods Frameworks` list at INSTALL time from the pod's *declared*
  (static) type, so the resulting dylib is never copied into
  `.app/Frameworks/` — build 0.0.156 shipped to TestFlight and crashed on
  every launch (dyld, before any JS), with App Store Connect flagging the same
  defect as **ITMS-90863**. The correct pattern: keep every pod static and put
  the archive on the **app target's** `OTHER_LDFLAGS` via `post_install`
  (`$(inherited)` first), because the app target is the only build step in the
  workspace that really runs `ld`. It must go on the target, NOT in a podspec's
  `user_target_xcconfig`: CocoaPods *sorts* merged OTHER_LDFLAGS tokens and put
  the archive *before* `-framework "LibSignalClient"`, and static-archive
  linking is order-dependent (`ld` pulls only members resolving an
  already-undefined symbol, no re-scan). Verify with
  `nm -arch arm64 <binary> | grep -c " T _<prefix>"` **and** `nm -u`, plus
  `ls .app/Frameworks/`, not by the build going green.
- **A Cloud Function that exists in `functions/src/` is NOT deployed, and
  nothing in the normal workflow tells you.** `npm run ship:ios` builds and
  submits the APP only — it never touches Firebase (`ship:ios:full` does).
  Found 2026-07-25: doc 31's Phase 1 pairing backend (`createPairingCode`,
  `redeemPairingCode`, `revokeDevice`) and Phase 2's `fanOutQueuedMessage` had
  been written, typechecked, committed and documented as "BUILT" for days while
  **never having been pushed** — `firebase functions:list` showed 22 deployed
  functions, none of them these. The client called callables that did not
  exist, so device pairing could not have worked for anyone, and per-device
  message fan-out was inert. The failure is silent from the app side (a missing
  callable looks like a generic network/internal error) and invisible to
  `tsc`, the test suites, and code review. Before believing any server-side
  feature is live, diff `firebase functions:list` against the `export const
  … = onCall`/`onValue*` names in `functions/src/index.ts` — and note the
  exported callable name can differ from the impl function's name
  (`syncNotificationDevice` wraps `syncNotificationDeviceRecord`), so deploy
  filters must use the EXPORT name or `firebase deploy` fails with "No function
  matches the filter".
- **Verifying native/iOS work: the traps that cost the most time (doc 31 build,
  2026-07-25).** Each of these produced a GREEN build or a clean exit code while
  being wrong.
  - **A Release build's JS `console.*` never reaches the device log.** A JS
    probe logged nothing while `NSLog` from native on the same code path
    appeared instantly. Instrument Release-on-device from NATIVE, or write to
    the app container and pull the file — never from JS.
  - **`xcrun devicectl` has no `console` subcommand, and `log stream` has no
    `--device-name` on this toolchain.** The capture that works is
    `xcrun devicectl device process launch --device <udid> --console <bundleid>`
    (stdout/stderr only). For simulators, `xcrun simctl spawn <udid> log stream`.
  - **A local device build needs `-allowProvisioningUpdates`.** Without it,
    signing fails on missing device registration / Sign in with Apple / PCC.
  - **Adding a new .swift file to `modules/<name>/ios/` requires `pod install`
    BEFORE the build proves anything.** A file absent from `Pods.xcodeproj`
    compiles to nothing, and the build stays green until something references
    it — one new file sat un-compiled through a "successful" build this way.
  - **Expo config plugins DO NOT run in this project** (committed `ios/` folder,
    non-CNG). `npx expo install <pkg>` adds the plugin to app.config.ts and it
    silently never applies. Info.plist keys (`UIBackgroundModes`,
    `BGTaskSchedulerPermittedIdentifiers`, …) must be added BY HAND, and the
    identifier read from the module's own source, not guessed. Verify in the
    BUILT app's Info.plist (`plutil -extract … <app>/Info.plist`), not the
    source one.
  - **Any App-ID capability change invalidates provisioning profiles.** EAS
    regenerates on next `ship:ios`; local builds need
    `-allowProvisioningUpdates`. Expected, not a failure.
- **CloudKit: never `CKQuery` your own records unless you have added a queryable
  index by hand.** A `TRUEPREDICATE` query fails at runtime with
  `Field 'recordName' is not marked queryable` — CloudKit does not auto-create
  indexes, and a fresh install can never rely on someone having clicked through
  the CloudKit Dashboard. Fetch by KNOWN record id instead and keep an index
  record (doc 31's backup manifest is exactly that). Also: **iOS Settings →
  iCloud → Manage Storage displays the LAST PATH COMPONENT of the container
  identifier verbatim** — `iCloud.com.splitcircle.app` showed as a meaningless
  "app", which is why the container is now `iCloud.com.splitcircle.ManaSplit`.
  Containers can be neither renamed nor deleted, so get the name right first
  time; the old one is unassigned and its data orphaned.
- **"Is it deployed?" is not the last question — ask "does anything CALL
  it?"** A 2026-07-26 audit of doc 31 found three functions written,
  committed, deployed and documented as BUILT with zero callers anywhere:
  `sendHistoryHandoff`/`receiveHistoryHandoff` (so a newly paired device
  got no history — the entire point of that phase) and
  `replenishPrekeysIfLow` (so a device silently degraded to
  signed-prekey-only once its 100 one-time prekeys were consumed, losing
  the forward secrecy they exist for). This is one rung BELOW the
  compiles/deployed/reachable/correct ladder doc 31 §5c already
  documents — the code was reachable and correct, and simply never
  invoked. `tsc`, tests, review and `functions:list` all pass in this
  state. Before writing BUILT, grep for a caller of every new exported
  function outside its own file.
- **Tightening an auth path can strand the legitimate user completely —
  check the single-device case explicitly.** Closing doc 31 §5b bug #2
  (devices auto-promoting themselves to confirmed main) made every
  non-first device register as `pending_confirmation`, needing approval
  from an existing device. Correct for adding a companion; a permanent
  lockout for a user whose only phone was lost or died, since the
  approver named by the UI is the device they no longer have — and the
  gate's only other action, Cancel, signs out into the same state. Every
  chat, expense and group became unreachable. Fixed by finally building
  §3.12's recovery flow (`functions/src/accountRecovery.ts`). Two rules
  came out of it: when a fix narrows who may authorize something, walk
  the case where the user owns exactly ONE device and it is gone; and
  when a recovery escape hatch is refused for security, check the
  security is real — here `firestore.rules` gates chats/expenses on the
  authenticated uid rather than a live device session, so blocking
  recovery would have stopped no attacker while stranding real users.
- **A callable that mints a credential must not REQUIRE that credential.**
  `redeemPairingCode` demanded `request.auth.uid` while returning the custom
  token the device signs in WITH — so QR pairing failed with "Authentication
  required" on every scan, for its entire existence, and the only way into the
  app was the sign-in path that bypasses pairing altogether. Any onboarding/
  recovery endpoint reached by a device that has no session yet must derive
  identity from the artefact it presents (here: the pairing code document), and
  its safety must come from that artefact being short-lived, single-use,
  high-entropy AND from what it grants being gated afterwards (a redeemed code
  yields only a `pending_confirmation` device that still needs approval).
- **Doc-comments in this repo have three times asserted a mechanism that was
  never wired.** `extractSalt` was documented as breaking the restore
  key-derivation circle and was never called (restore failed with "wrong
  passphrase" against a backup written seconds earlier); a handoff checkpoint
  wrote `manifestCreatedAt` and never compared it (a second handoff silently
  skipped chunks); a retirement attestation was signed while the ack that
  actually unlocks retirement was left unsigned and forgeable. When a comment
  claims a safety property, grep that the code path exists before believing it.
- **UIScene lifecycle is mandatory** (iOS 27 kills classic lifecycle, TN3187). Cold-start
  user activities arrive in `SceneDelegate` `connectionOptions.userActivities`, not
  `application(_:continue:)`. Keep the scene manifest through Expo upgrades.
- **patch-package**: patches/ must actually be applied — grep node_modules to verify
  after installs. Patches exist for callkeep, livekit-webrtc, bottom-tabs, expo-sqlite, RN.
- **expo-audio**: `pause()` deactivates the shared AVAudioSession unless the player was
  created with `keepAudioSessionActive: true` — this silently kills live call audio.
- **APNs env**: `BadEnvironmentKeyInToken`/`BadDeviceToken` = sandbox/production mismatch;
  voipPush.ts has dual-env fallback. VoIP pushes MUST call `reportNewIncomingCall`
  unconditionally or iOS revokes the privilege.
- **Hermes + optional native modules**: probe `requireOptionalNativeModule()` before
  `require()`ing a package whose native half may be missing — else SIGSEGV, not a catch.
- **iOS 26 native search tab is a PATCH** (`patches/react-native-screens+4.23.0.patch`):
  on iOS 26 the tab bar uses the UITab/UISearchTab API so the search circle is detached
  and the tab bar morphs into the system search field natively. RNS upstream has no
  UISearchTab (issue #3999 not_planned) — an RNS upgrade breaks this; re-port every
  `PATCHED (SplitCircle)` block. `tabBarSystemItem: 'search'` must stay unlabeled
  (title/tabBarLabel demotes it). SearchScreen mirrors the native field via
  splitcircle-ai events; tab-switch KEEPS a committed query, only cancel clears
  (Photos semantics — deliberate). Full contract: [ai_layer/docs/20](ai_layer/docs/20_native_search_tab.md).
- **Native changes are invisible to the jsbundle hot-swap** — the sim shows old native
  code until a real build is installed. `expo run:ios` fails on the Xcode beta (no
  Simulator.app — it's Device Hub now); use raw `xcodebuild -configuration Debug` +
  `simctl install` for a one-off sim proof, or `npm run ship:ios`.
- **Reanimated new-arch**: inserting a sibling ABOVE entering-animated ScrollView content
  doesn't shift that content (overlap) — mount late-loading rows outside the ScrollView.
  `flex: 1` inside height-constrained containers collapses to zero height.
- **Liquid-glass violations don't show up in code review — they need a grep, not an
  eyeball.** A hand-rolled solid/hex surface reads as "normal dark UI" until it sits
  next to a real glass one; a full 45-bug branch review missed every instance until a
  screenshot caught it (`AddExpenseScreen`'s payer/category pickers were raw
  react-native-paper `Dialog`/`Menu`, `HeaderMenu.tsx` was hardcoded `#1c1c20`). Before
  touching any modal/menu/dropdown, read DESIGN.md's "Self-audit" checklist under
  "Liquid glass DNA" and grep for its signatures — don't rely on the diff looking fine.
- **A glass dropdown/overlay stacked over a screen with SIMILAR content underneath
  (another list of names/rows) needs its own dimming backdrop, or it reads as
  double-vision.** Converting `BillSplitScreen`'s payer/participant dropdown from
  near-opaque solid to `GlassCard` let the scrolling participant list underneath bleed
  through legibly enough to overlap the dropdown's own rows — invisible in a code diff,
  only caught by actually opening the sheet on a simulator. A plain dark scrim wasn't
  opaque enough either (GlassCard's own translucency still let text shapes through);
  fixed with a full `BlurView` + tint backdrop between the trigger screen and the
  dropdown (same shape as the winner-overlay/`MessageActionSheet` backdrop pattern).
  Any new glass overlay presented ON TOP of a similarly-styled scrolling list needs
  this backdrop — a solid canvas beneath a menu/sheet doesn't.
- **iOS 26 scroll-edge effect is disabled by an RN patch** (`patches/react-native+0.83.2.patch`,
  `RCTEnhancedScrollView.mm` `PATCHED (SplitCircle)` block). Built with the iOS 26 SDK, every
  UIScrollView gets a default progressive glass fade at its edges (`UIScrollEdgeEffect`) — over
  our colorful liquid backdrops it looks like fog "dimming" content near the top/bottom (worst
  in chat, tracks the keyboard). RN has no prop for it; an RN upgrade must re-port the patch.
- **Never unconditional `onContentSizeChange` → `scrollToEnd`** on a chat list with
  STREAMING content: every token re-fires it, offsets compound past the content
  ("infinite scroll into the void") and scroll-back gets yanked forever. Gate the
  follow on a near-bottom ref (see the AI chat surfaces); explicit sends re-engage it.
- **react-native-svg** pinned 15.12.1 (chart-kit compat).
- **@shopify/react-native-skia (2.10.0) powers the chat photo editor** — added
  2026-07-27, and the FIRST new native pod added since the LibSignalClient
  disaster, so it was verified the way that gotcha demands: `Podfile.lock`
  (5 refs), `Pods.xcodeproj` (49 refs) and `Target Support Files/` all checked
  by hand, then `nm -u <binary> | grep -ci skia` = **0** on the archived
  Release binary, then an actual on-device launch watched for a dyld failure.
  It links STATICALLY (no entry in `.app/Frameworks/`, which is correct here —
  unlike LibSignalClient it vendors no archive needing `OTHER_LDFLAGS`), so
  don't "fix" a missing Frameworks entry. Peer deps are real and already
  satisfied: reanimated ≥4 and `react-native-worklets` ≥0.7 — an upgrade that
  drops either breaks Skia. **Anything Skia draws that must be SAVED has to be
  re-rendered offscreen at full resolution** (`Skia.Surface.MakeOffscreen`),
  never `makeImageSnapshot()` on the on-screen `<Canvas>`: that canvas is sized
  to the screen, so snapshotting silently downscales a 12MP photo to ~1200px
  and the quality loss looks like the compressor's fault. See
  `src/services/mediaEditorRender.ts`. Gestures inside the editor need their
  own `GestureHandlerRootView` because it renders in a `Modal` — gesture-handler
  does not traverse RN's modal boundary.
- **Chat media sends are a two-stage pipeline, not a loop** — compression is
  sequential (CPU; concurrent transcodes on a phone are slower than serial and
  starve the UI thread) while uploads run on a chained promise so item N uploads
  WHILE N+1 compresses. The optimistic bubble is written by
  `useMediaSendPipeline` BEFORE compression starts, not by `sendMessage`; that
  ordering is the fix for "I tapped Send and nothing happened" and must survive
  any refactor. Per-message progress lives in an external store
  (`mediaSendProgress.ts` + `useSyncExternalStore`), deliberately NOT context —
  upload ticks arrive tens of times a second and context would re-render every
  mounted bubble in a virtualized list on each one. Upload progress must come
  from `createUploadTask`, never `uploadAsync` (no progress callback and no
  cancel — the old code faked 10%→90% around an opaque await).
- **App Intents run headless** (Siri invokes them without launching JS) — their Swift `perform()`
  cannot call into React Native at all. They read the on-disk SQLite index
  (`modules/splitcircle-ai/ios/SplitCircleIndexReader.swift`) directly instead. That pod links
  system `libsqlite3` while expo-sqlite vendors its own statically-compiled copy — unverified
  linker risk, see [ai_layer/docs/18](ai_layer/docs/18_app_intents_siri_pcc_indexing.md) §3.1.
- **App Shortcuts (Siri) has real gaps — catalogued 2026-07-20, not yet fixed.**
  `SplitCircleShortcuts: AppShortcutsProvider`
  ([SplitCircleIntents.swift:471](modules/splitcircle-ai/ios/SplitCircleIntents.swift:471)) is
  already at Apple's 10-shortcut cap — don't add an 11th `AppShortcut` without retiring one.
  `AppShortcuts.updateAppShortcutParameters()` is never called anywhere in the repo, so Siri's
  group picker can drift stale after a group is created/renamed/left. Cross-module App Intent
  discovery (every `AppEntity`/`AppIntent`/`AppShortcutsProvider` is `public` because the pod is
  a separate Swift module from the app target) is unverified without a real device build — if a
  shortcut silently doesn't register, the fallback is moving the files into `ios/SplitCircle/`.
  Neither doc 18 §6 nor doc 19 §5's device-verification checklist has ever been run — treat this
  whole surface as spike-quality until it has.
- **Private Cloud Compute entitlement GRANTED 2026-07-18** (capability on the App ID + provisioning
  profile; `com.apple.developer.private-cloud-compute` in `SplitCircle.entitlements`). Builds from
  before that date report `isAvailable=false` — that's the binary, not a bug. On sim it stays
  unavailable by design (hard-excluded, see the FM serialization gotcha below).
- **Foundation Models calls MUST stay serialized** — two concurrent model constructions (on-device
  OR PCC) race the expo module plumbing and corrupt the Hermes heap: SIGSEGV inside the VM, seen
  on the physical iPhone 17 Pro 2026-07-18 (two `askOnDevice` racing on Group Stats open). The
  global `serializeFm` queue in `modules/splitcircle-ai/index.ts` is the enforcement point — route
  any NEW FM-touching native fn through it, never call `NativeModule.*` directly.
- **Narrative/free-text FM work goes through `generateOnDeviceText`, never `askOnDevice`** —
  askOnDevice natively installs a numbered-lines Q&A persona + citation struct that made the
  stats narrator deflect ("I don't have enough expense data") and drift. Model output is never
  rendered verbatim: `src/utils/aiText.ts` strips/validates it (doc 22 "Narrative-tier reliability").
- **Widgets need a one-time Xcode step** — the Widget Extension target + App Group
  (`group.com.splitcircle.app`) are NOT in `pbxproj`/entitlements yet; all source is on disk
  (`ios/SplitCircleWidgets/`). Follow the runbook in
  [ai_layer/docs/19](ai_layer/docs/19_widgets_and_siri_control.md) §4 before expecting widgets to
  build. Do NOT add `application-groups` to `SplitCircle.entitlements` until the capability is
  provisioned on the portal — it will break `ship:ios` signing otherwise. Until then the widget
  snapshot write no-ops and Siri intents fall back to the SQLite index (safe).
- **`vitest.unit.config.ts` (pure-module unit tests) has no `@` alias resolution —
  `vitest.services.config.ts` does.** Both suites run files that pass `tsc --noEmit` cleanly
  (path aliases resolve fine there), but `test:unit` specifically will fail at collection time
  with "Cannot find package '@/...'" the moment a `src/utils/` "pure module, no RN/native
  imports" file (per its own doc-comment convention — `expenseQuery.ts`, `statsInsights.ts`,
  `aiTools.ts`, `onDeviceAiContext.ts`, etc.) adds a REAL (non-`import type`) import via the
  `@/` alias instead of a relative path. `import type` imports are erased before bundling, so
  they never hit this; a real runtime import does. Found 2026-07-24 when doc 30's rollout added
  `import { resolveDisplayName } from '@/utils/identity'` to `expenseQuery.ts`. Fixed at the
  config level (added the same `resolve.alias` block `vitest.services.config.ts` already has),
  not by chasing relative-import conventions file-by-file — before adding a NEW real import to
  any file covered by `vitest.unit.config.ts`'s `include` globs, run `npm run test:unit` to
  confirm collection still succeeds, don't trust `tsc --noEmit` alone to catch this class of bug.
- **An all-or-nothing encryption coverage rule is correct for a real recipient
  and catastrophic for self-sync — and a `console.warn` swallow makes it
  invisible.** `encryptMessageForRecipient`'s default `coveragePolicy:
  'all-devices'` THROWS `EncryptionRequiredError` unless every one of the
  target's devices could be encrypted for. That is right for a peer: it exists
  so nobody can force a downgrade to plaintext by making one device's keys
  unavailable. But `queueMessageToOwnDevices` (self-sync, doc 31 §3.3) took
  that default while `ensureSessionWithDevice` returns `false` *silently* on
  any prekey-claim failure — so ONE sibling device with a broken session threw,
  its own catch swallowed the throw into a `console.warn`, and the user's own
  messages reached NONE of their linked devices, healthy ones included, with no
  signal anywhere. Self-sync has no plaintext fallback, so there is no
  downgrade to defend against; it must use `'available-devices'`. Diagnosed
  only from `firebase functions:log --only fanOutQueuedMessage`, where the
  self-mirror's signature (`skippedOrigin: true`, set only by
  `queueMessageToOwnDevices`) appeared ONCE across a whole session while peer
  fan-outs to the same 3-device account succeeded continuously — the client
  logs proved nothing because **a Release bundle's `console.warn` never reaches
  the device log** (use `console.error` for anything a non-fatal path must
  still be diagnosable by). Before adding any new fan-out that encrypts to
  multiple devices, decide explicitly which coverage policy it needs, and never
  let a catch swallow the strict policy's throw. See
  [ai_layer/docs/32](ai_layer/docs/32_nearby_messaging_offline_sync.md) §10.1.
- **Never tear down the shared `MCSession` to fix ONE peer.** MultipeerConnectivity's
  session is multi-peer (up to 8), so `replaceSessionLocked()` disconnects
  *everyone*. Two paths in `SplitCircleMeshModule.swift` did it for
  single-peer reasons — `beginInvitation`'s 15s timeout handler (to clear a
  possibly-wedged session) and `updateTrustedPeers` on trust EXPANSION (to
  re-find previously-ignored radios). With two devices both self-heal and look
  fine; with three or more, invitation timeouts and routine trust refreshes
  (the latter fires on EVERY `threads` change) collapsed the mesh constantly
  and it could never converge — "more than 2 devices won't mesh up". Replacing
  the session is only justified for a trust REVOCATION (MCSession cannot
  selectively evict a peer) or when `connectedPeers.isEmpty` (nothing to lose).
  For anything else restart discovery only — `rebuildTransportLocked(replacingSession: false)`.
  See [ai_layer/docs/32](ai_layer/docs/32_nearby_messaging_offline_sync.md) §10.2.
- **A native state mutation that doesn't go through the one callback that emits
  both events will silently starve whatever only listens to the other one.**
  `SplitCircleMeshModule.swift`'s `MeshController` has two independent,
  unsynchronized emission paths — `emitPeerCount()` → `onPeersChanged` and
  `emitState()` → `onStateChanged` — and only `session(_:peer:didChange:)`
  calls both. `updateTrustedPeers(_:)` (promotes a peer from pairing/untrusted
  to `trustedDeviceIds`) calls `emitState()` only; when the promoted peer is
  *already* connected (the `promotedConnectedPair` branch — true right after a
  pairing ceremony completes, or after a `threads`-array change re-derives
  trust for an already-connected peer), no `didChange` callback follows
  either, so `onPeersChanged` never fires for that transition at all.
  `nearbyMessageService.ts`'s `peerSubscription` is the ONLY consumer of
  `onPeersChanged` in the app and the only thing that calls
  `broadcastQueuedNearbyMessages()` off a peer-count change — so a freshly
  trusted, already-connected peer's queued nearby messages sit unbroadcast
  until some unrelated topology event happens to fire one later (see
  [ai_layer/docs/32](ai_layer/docs/32_nearby_messaging_offline_sync.md) §5f).
  This is the exact same failure shape as this file's own
  `isGroupJoinUpdate`/`isGroupDepartureUpdate` Firestore-rules gotcha above —
  a state-mutation path added later than the "canonical" one and never given
  its matching signal — except here nothing (compiler, lint, test) can catch a
  missing `emitPeerCount()` call, so it is easy to reintroduce in any NEW
  native function that changes trust/connection state without routing through
  `session(_:peer:didChange:)`. Before adding one, call both `emitPeerCount()`
  and `emitState()`, or route through the existing callback instead of a new
  one-off.

## Backlog ideas (user's own notes)

- Chat "stalk mode": pin-guarded incognito view — no read receipts, sending disabled.
- **`expo-image-picker` downloads every selected asset from iCloud INSIDE the
  picker call** — the cause of "selecting a video freezes/crashes the app" on
  any library using Optimize iPhone Storage. `launchImageLibraryAsync` does not
  resolve until every asset is materialized, and its video fast path calls
  `PHAssetResourceManager.writeData` with **no `progressHandler` and no
  cancellation** (`MediaHandler.swift` ~line 416). For a large iCloud video
  that is minutes of frozen UI, then a watchdog kill or OOM. `modules/
  splitcircle-media` replaces it for the gallery path by splitting that one
  call in three: `pickAssets` (identifiers + metadata, reads no file data),
  `requestThumbnail` (small local render — Photos keeps these on-device even
  under Optimize Storage), and `materializeAsset` (the real fetch, with
  progress + cancel, deferred to send time where the pipeline already has a
  ring and a Cancel). Uses `requestData`, NOT `writeData`: it streams chunks
  (a 2GB video never sits in memory) and returns an id `cancelDataRequest`
  accepts. **`PHPickerConfiguration(photoLibrary:)` is mandatory** — the bare
  initialiser returns results with `assetIdentifier == nil` and the identifier
  is the whole point. Consequence to respect everywhere: while `assetId` is
  set, `uri` is only a ~1280px THUMBNAIL. Editing, trimming, or sending it
  as-is is silent permanent quality loss, so each of those materializes first
  and then clears `assetId` (leaving it set makes the pipeline re-download the
  original and discard the edit/trim).
- **A native picker/sheet that resolves its promise BEFORE its dismissal
  animation finishes will silently kill whatever modal JS presents next.**
  `PHPickerViewController` is presented FROM the attachment sheet's own RN
  modal (`RCTFabricModalHostViewController`), so calling
  `picker.dismiss(animated: true)` and resolving in the same breath leaves a
  ~300ms transition in flight; JS then tears down the sheet and presents
  MediaPreview on top of it, and UIKit **refuses that presentation with no
  error**. React still believes `visible === true`, so every JS-side signal
  looks healthy — the component renders, props are correct, effects fire — and
  nothing is on screen. Resolve from `dismiss`'s completion block instead.
  This cost three debugging rounds because it is invisible from JS: a render
  pass does NOT prove presentation. **Use `Modal`'s `onShow` to tell "React
  set visible" apart from "UIKit put it on screen"** — that one line is what
  finally distinguished them. Note it did not affect `expo-image-picker`,
  whose call took seconds to return (it was busy downloading), by which point
  every transition had settled; returning fast is what exposed it. Camera kept
  working throughout because it presents via a different path, and that
  asymmetry (camera fine, gallery dead) is the fingerprint of this bug.
- **Never `rm -rf ios/build`** — it is not scratch output. React Native's
  codegen writes `ios/build/generated/ios/` there, and deleting it fails the
  next archive with `RCTAppDependencyProvider.h couldn't be opened` from a
  target you never touched. `pod install` regenerates it. (Note `xcodebuild
  -project ios/Pods/Pods.xcodeproj` defaults `BUILD_DIR` to that same
  `ios/build`, which is what makes deleting it look safe.)
