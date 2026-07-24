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
verified end-to-end on Simulator with a real Apple ID; App Store Guideline 4.8 compliance
since Google is already offered; the actual bug wasn't the nonce/entitlement code, it was
a missing GCIP Identity Providers registration — see the CLAUDE.md gotcha above and doc 27's
"Real bug found & fixed" section; NOT yet verified on a real device or via `ship:ios`) ·
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
doc 28's Cloud Function, which still needs the matching balance check doc 29 added).

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
  itself is a separate, still-unresolved bug** — `joinGroup`'s
  `where('inviteCode', '==', code)` query against `groups` requires read access
  (`allow read: if request.auth.uid in resource.data.memberIds`) that a non-member
  provably can never satisfy; Firestore rejects the entire query outright (it
  evaluates rules against a query's *potential* result set, not the actual matched
  docs — a rule Firestore can't statically prove safe for a query denies unconditionally,
  regardless of what the data actually contains). No fix has been applied — the
  correct pattern is a separate `groupInvites/{code}` doc (or similar) with an
  `allow read: if isSignedIn()` rule holding only what's needed to resolve
  code→groupId, since the sensitive full group doc shouldn't be broadly readable.
  Manually editing a group's `memberIds`/`members` via the Firebase Console (or an
  Admin SDK script) is the only way to add a second account to a group for testing
  until this is fixed.
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

## Backlog ideas (user's own notes)

- Chat "stalk mode": pin-guarded incognito view — no read receipts, sending disabled.
