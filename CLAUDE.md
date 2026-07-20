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
locked contract, sequenced AFTER doc 25 Q1→Q3).

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
