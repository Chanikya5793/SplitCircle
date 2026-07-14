# SplitCircle — App Intents, Siri, PCC & Indexing Architecture (iOS 27)

> Companion to [`17_chatbot_pipeline_v2.md`](17_chatbot_pipeline_v2.md) (which owns the chat
> *understanding* pipeline and the PCC escalation plan) and [`16_chatbot_handoff.md`](16_chatbot_handoff.md).
> This doc covers the parts those don't: **Siri app-control via App Intents**, the **Spotlight/
> semantic indexing architecture**, a **correction of the PCC access premise**, and the **native
> Swift plugin inventory** needed to reach any of this from React Native/Expo. iOS-27-only,
> iOS-app-only — no Android work is in scope here (per current product direction).
>
> Researched 2026-07-13 via WWDC26 sessions 240/241/242/319/343 and the current Apple Developer
> site (post-training-cutoff — this doc, not my training data, is the source of truth for these
> APIs going forward).
>
> **UPDATE 2026-07-13 (later):** the §4 "Phase 2" write path and §5 "Spotlight tap-through"
> gaps are now **built** — see [`19_widgets_and_siri_control.md`](19_widgets_and_siri_control.md),
> which adds the control intents (open group / add expense / settle up / ask), the
> `splitcircle://` deep-link router, and **home/lock/Control-Center widgets**. This doc's §4/§5
> below describe the *original* decision tree; doc 19 is the current state. The write path
> chosen was "open the app prefilled" (doc 19 §3.1), not the headless inbox — that inbox stays
> the still-deferred Phase 2.

---

## 0. TL;DR for whoever picks this up next

- **PCC is real for us, but it is NOT a general compute platform.** It is one thing: a bigger,
  more-capable *LLM backend* (`PrivateCloudComputeLanguageModel`) that plugs into the SAME
  `LanguageModelSession` API the on-device model already uses. It escalates the **chat**
  understanding path (doc 17 Phase C) — it has nothing to do with Siri, App Intents, or indexing.
  Conflating "PCC" with "the new Siri/indexing stuff" was the wrong framing; they're two unrelated
  iOS 27 capabilities that happen to have shipped in the same OS release.
- **The App Store Small Business Program requirement is real, not outdated.** Doc 17 §3 flagged
  this as possibly stale and asked to re-verify — it's confirmed correct as of WWDC26. The three
  PCC eligibility gates are (1) enrolled in the App Store Small Business Program, (2) < 2,000,000
  first-time downloads across all your apps, (3) the PCC entitlement granted to your account. **You
  (chanikya5793 / chanikya6163) already meet (1).** (2) is almost certainly true for SplitCircle/
  ManaSplit. (3) is **not yet done** — it's a manual application at
  `developer.apple.com/contact/request/private-cloud-compute/`, and per doc 17's spike the runtime
  stays gated until Apple grants it. **Action for you: file that application now** — it has lead
  time and nothing else here blocks on it.
- **App Intents is the new mandatory Siri integration surface**, and SiriKit (`INIntent` classes —
  what `RNCallKeep`'s `INStartCallIntent` handling already uses for Recents redials) is on a
  deprecation clock but NOT gone — the existing call-Recents integration in `AppDelegate.swift`
  does not need to change.
- **There is no Apple-defined "finance" or "bill-splitting" App Intent schema domain.** Existing
  domains are mail/photos/books/journal/spreadsheets/system-style content apps. SplitCircle's
  entities and intents are **custom** (not `@AssistantIntent(schema:)`-conforming) — same pattern
  as most third-party apps outside Apple's own domains.
- **Indexing and PCC don't share plumbing.** The new "Spotlight semantic index" (iOS 27
  `IndexedEntity` + `CSSearchableIndex.indexAppEntities`) is a *search/entity-resolution* feature —
  it makes your app's content findable and referenceable by Siri. It runs entirely on-device, no
  LLM involved, no PCC involved.
- **The hard constraint driving the native-Swift-plugin push:** App Intents can be invoked by Siri
  **headlessly** — without launching your app or its JS runtime. A React Native bridge call is not
  an option in that code path; the Swift `perform()` body must read/write real data on its own.
  That's Section 3.

---

## 1. Corrected PCC facts (supersedes doc 16 §8's uncertainty, confirms doc 17 §3)

| Fact                                  | Detail                                                                                                                                                                                                                                                                                                                              | Source                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Eligibility                           | Enrolled in App Store Small Business Program**+** < 2M first-time downloads (all your apps, App Store Connect Analytics) **+** PCC entitlement granted                                                                                                                                                                  | [developer.apple.com/private-cloud-compute](https://developer.apple.com/private-cloud-compute/) |
| Cost                                  | Free — no API key, no per-call billing, uses the user's iCloud account                                                                                                                                                                                                                                                             | doc 17 §3, confirmed                                                                        |
| Enrollment                            | Request at `/contact/request/private-cloud-compute/`; manage via account capability requests                                                                                                                                                                                                                                      | Apple Developer site                                                                         |
| Grace period                          | If you exceed 2M downloads or leave the Small Business Program,**6 months** to migrate off PCC                                                                                                                                                                                                                                | Apple Developer site                                                                         |
| Testing                               | TestFlight / ad hoc installs do**not** count toward the 2M threshold                                                                                                                                                                                                                                                          | Apple Developer site                                                                         |
| API shape                             | `PrivateCloudComputeLanguageModel()` (no-arg init) → `LanguageModelSession(model:)`; `ContextOptions(reasoningLevel: .light/.moderate/.deep)`; `model.isAvailable: Bool`; `model.quotaUsage`; `contextSize` is `try await`-only (unlike the sync on-device one)                                                      | doc 17 §3/§5, compile-verified on Xcode 27 beta                                            |
| Context window                        | 32K tokens (vs 4096 on-device iOS 26 / 8192 on-device iOS 27)                                                                                                                                                                                                                                                                       | doc 17 §3                                                                                   |
| Restrictions critics raise            | Apple caps this deliberately — "severely limited" framing exists in press coverage (Daring Fireball et al.) around rate limits/quotas for the free tier;**exact quota numbers weren't in what we could confirm** — read `model.quotaUsage` at runtime and surface it (doc 17 C.3) rather than hardcoding an assumed limit | WebSearch, 2026-07-13                                                                        |
| **Current status in this repo** | Compiles (`pccProbe` in `SplitCircleAIModule.swift`); **entitlement not yet granted**, so `isAvailable` is false at runtime today                                                                                                                                                                                       | doc 17 spike log                                                                             |

**What this means for "expand it into chat":** doc 17 Phase C already has the correct plan —
escalate to PCC only when on-device context is exceeded or the router has low confidence on a
complex multi-step question, keep the "LLM never computes numbers" rule, show a transparency badge.
Nothing in this doc changes that plan; it just confirms the premise and flags the one blocking
action item (file the entitlement request).

---

## 2. App Intents / Siri app-control research (iOS 27 / WWDC26)

### 2.1 What Siri gained

Three capabilities, all built on **App Intents** (not a new separate framework):

1. **Entity access** — your app's content (groups, expenses, people) becomes something Siri can
   name, search, and reason about, via `AppEntity` + Spotlight indexing.
2. **Action-taking** — Siri invokes your `AppIntent`s directly, headlessly when possible, without
   opening the app.
3. **Onscreen awareness** — Siri can resolve deictic references ("split *this*", "settle up with
   *them*") to whatever's currently visible, via view-level entity annotations.

SiriKit's old `INIntent` model is being phased out for new integrations; App Intents is "the
mandatory way Siri talks to your app" going forward. This doesn't force us to rip out the existing
`RNCallKeep`/`INStartCallIntent` Recents-redial integration (that's a different, still-supported
surface — Phone app call intents, not general Siri app-control) but it does mean **all new Siri
work should be App Intents, not SiriKit.**

### 2.2 New API surface relevant to us (WWDC26 session 343)

| API                                                                                                               | What it does                                                                                                                                 | Where we'd use it                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AppEntity` / `AppIntent` / `AppShortcutsProvider`                                                          | Base protocols (stable since iOS 16, not new)                                                                                                | `SplitCircleGroupEntity`, `GetGroupBalanceIntent`, `SplitCircleShortcuts` — **scaffolded**, see §3                                                               |
| `IndexedEntity` + `IndexedEntityQuery`                                                                        | New iOS 27 protocol; feeds an `AppEntity` into the **semantic** Spotlight index via `CSSearchableIndex.indexAppEntities([entity])` | `SplitCircleGroupEntity: IndexedEntity` — **scaffolded**, gated `#if compiler(>=6.4)` + `@available(iOS 27, *)`                                                   |
| `OwnershipProvidingEntity`                                                                                      | Lets Siri know an entity is shared/public before acting on it (`.shared`/`.public`/`.unknown`)                                         | Relevant once a "settle up" WRITE intent exists (Phase 2, §4) — a settlement touches other members' data, so this is the right conformance to add then                       |
| `displayRepresentations(for:requestedComponents:)`                                                              | Component-scoped entity display (e.g. text-only) for fast onscreen resolution                                                                | Not needed yet at our entity count/complexity                                                                                                                                  |
| `IntentValueQuery` + `@UnionValue`                                                                            | Structured search input / multi-type parameters                                                                                              | Not needed for the balance/list/ask intents we scaffolded                                                                                                                      |
| Onscreen awareness (`.appEntityIdentifier`, `AppEntityAnnotatable`, `UICollectionViewAppIntentsDataSource`) | Tags visible UI with the entity it represents, so Siri resolves "this"/"that"                                                                | **Not attempted.** SplitCircle's UI is React Native (Fabric-mounted UIViews), and these modifiers are SwiftUI/UIKit-first. See §5 "What we deliberately did not build." |

### 2.3 No finance/money schema domain

Checked the built-in `@AssistantSchemas`/domain list (mail, photos, books, journal, presentations,
spreadsheets, system, etc.) — nothing fits a shared-expense app. **Our entities/intents are custom**,
which is normal (most third-party apps outside Apple's own content types are in the same boat) but
means we get zero "free" Siri phrase training from a shared schema; `AppShortcutsProvider` phrases
(§3) are the whole mechanism for teaching Siri our vocabulary.

---

## 3. What's scaffolded now (native Swift, `modules/splitcircle-ai/ios/`)

All new files live in the **existing** `SplitCircleAI` Expo module pod — not a new Xcode target.
That pod's podspec globs `**/*.swift`, so new files are picked up automatically on the next
`pod install`; no `.pbxproj` surgery. This matches how the whole 609-line `SplitCircleAIModule.swift`
already got there.

| File

```

```

| What it does                       | Confidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |                                                                                                                                             |
| :--------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SplitCircleIndexReader.swift`   | Read-only SQLite bridge into `<Documents>/SQLite/ai_index.db` (the exact file `aiIndexStore.ts` writes via expo-sqlite) — the ONLY way a headless intent sees real data. Links system `libsqlite3` (podspec `s.library = 'sqlite3'`); expo-sqlite vendors its own statically-compiled sqlite3.c with unprefixed symbols, so this is a deliberate, reasoned choice, **not yet build-verified in this environment** — see the file's own header comment and §6. | Medium — standard pattern, real but unverified linker risk flagged inline                                                                  |
| `SplitCircleEntities.swift`      | `SplitCircleGroupEntity: AppEntity` (+ `IndexedEntity` under iOS 27), `SplitCircleGroupQuery: EntityQuery & EntityStringQuery`, `SplitCircleCurrentUser` (reads the signed-in uid from `UserDefaults`)                                                                                                                                                                                                                                                               | High for the iOS 16 baseline; medium for cross-module App-Intents discovery (see below)                                                     |
| `SplitCircleIntents.swift`       | `GetGroupBalanceIntent` (headless, deterministic, reads the SQLite index — **no LLM**, matching the app-wide "model never does arithmetic" rule), `ListSplitCircleGroupsIntent` (headless), `AskSplitCircleIntent` (opens the app; hands off via the existing `donateAskActivity` NSUserActivity path — open-ended Q&A genuinely needs Foundation Models, which needs the app process), `SplitCircleShortcuts: AppShortcutsProvider` with donated phrases    | High                                                                                                                                        |
| `SplitCircleSemanticIndex.swift` | `CSSearchableItem` indexing (iOS 16+, stable) + `CSSearchableIndex.indexAppEntities` (iOS 27, new — spike-quality). Triggered from `SceneDelegate.sceneDidBecomeActive` on every foreground.                                                                                                                                                                                                                                                                            | High for the iOS 16 tier;**low-medium** for the iOS 27 tier — this hasn't been through a device spike the way doc 17's PCC probe was |

**New cross-runtime data contract:** `src/services/aiIndexStore.ts` gained a `groups_meta` SQLite
table (`upsertGroupMeta`/`pruneGroupMeta`), mirrored from `groupCache.ts`'s existing
`persistGroups()` call site. This exists **solely** so Swift can resolve a group's display name
headlessly — the existing `groupCache` (AsyncStorage) isn't safely readable from native code
(private RN storage format), and the existing `ai_index` table has analytics but no name. Treat this
table's schema as a versioned contract between the two runtimes, same spirit as `INDEX_VERSION`.
`npx tsc --noEmit` is clean after this change.

**Also wired:** `AuthContext.tsx` now mirrors the signed-in uid to
`Settings.set({ SplitCircleCurrentUserId })` on every `onAuthStateChanged` firing (same bridge
pattern as `RNThemeIsDark`/`PrivacyGuardEnabled`), and `AppDelegate.swift`'s
`sceneDidBecomeActive` now calls `SplitCircleSemanticIndex.reindexCurrentUserGroups()`.

### 3.1 Real risks in this scaffold — read before shipping

This is **spike-quality code**, matching the honesty level of doc 17's own spike log. Specific,
concrete things a device build must verify (none of this can be checked without Xcode):

1. **Cross-module App Intents discovery.** All new types are marked `public` because App Intents
   declared `internal` in a dependency module are a known cause of "the shortcut silently doesn't
   register." Whether Apple's metadata extractor reliably picks up conformances from a **statically
   linked pod** (vs. the main app target directly) is genuinely uncertain — if the first build shows
   the shortcuts missing from the Shortcuts app / Spotlight, the fallback is moving these four files
   into `ios/SplitCircle/` (the app target) directly, which is Apple's most-documented location.
2. **`libsqlite3` linking.** See the podspec comment and `SplitCircleIndexReader.swift` header —
   theoretically safe (dylib vs. static-archive symbol resolution don't collide the way two static
   archives would), but "theoretically safe" is exactly the kind of claim this codebase's own
   culture (CLAUDE.md's Gotchas list) says to verify, not trust.
3. **iOS 27 `IndexedEntity`/`indexAppEntities` API shape.** Sourced from a WWDC26 session summary,
   not a header file or a compile probe like doc 17 did for PCC. Treat method signatures as
   best-effort until compiled against the actual Xcode 27 SDK.
4. **`Settings.set({ SplitCircleCurrentUserId })` timing.** If a headless intent fires before the
   app has ever launched once post-install (fresh install, Siri Suggestions somehow surfaces it
   early), `UserDefaults` won't have the key yet — already handled (`GetGroupBalanceIntent` returns
   a "sign in first" dialog rather than crashing), but worth a real-device check on a fresh install.

**Recommended next step, mirroring doc 17's own methodology:** run the exact same kind of Phase A0
spike — build on Xcode-beta 27, run on a physical Apple-Intelligence-eligible device, and log
pass/fail per numbered risk above, the same table format doc 17 used for S1–S6.

---

## 4. What's NOT built — the write path, and the port-plan question

The user's brief explicitly allowed for a native iOS port if headless writes turn out to require
it. Here's the actual decision tree, so nobody re-derives it from scratch:

### Phase 2 (documented, not implemented) — headless writes via a Siri inbox

"Settle up with X" / "Add a $20 expense" said to Siri while the app isn't running needs to persist
*something* even though the JS runtime isn't around to run `services/outbox.ts`. **Do not** try to
read/write `outbox.ts`'s AsyncStorage format directly from Swift — that's reverse-engineering RN's
private storage internals, exactly the kind of fragile native/RN coupling CLAUDE.md's Gotchas
section warns about repeatedly.

Instead: add a **new, explicitly-owned** SQLite table (e.g. `siri_inbox` in the same `ai_index.db`,
following the `groups_meta` precedent from §3) that a future write-capable `AppIntent`'s `perform()`
appends a row to. On next launch/foreground, JS drains that table and feeds each row through the
**existing** `enqueueOp`/outbox sync path — so the write still goes through all the existing
idempotency/conflict handling, just with a native-authored entry point. This keeps the Swift/RN
coupling to one well-defined table, not a reverse-engineered format.

### Phase 3 (only if Phase 2's latency is unacceptable) — a real port decision

Phase 2 writes only sync once the app is foregrounded. If the product requirement is "a Siri-added
expense must reach other group members within seconds, even if the adder's app stays closed for
days," that needs native networking independent of RN/JS entirely. Two real options, in order of
recommendation:

1. **(Recommended) Swift calls the existing Cloud Functions HTTPS endpoint directly** via
   `URLSession`, carrying a cached Firebase ID token (refreshed opportunistically when the app *is*
   foregrounded, stored in Keychain). Smallest surface area — reuses all existing server-side
   validation/rules, no duplicate client SDK, no new Firestore security-rule surface to audit.
2. **Add the native Firebase iOS SDK alongside the JS SDK.** **Checked: this app currently has NO
   native Firebase pods and NO `GoogleService-Info.plist`** — `firebase` in `package.json` is the
   pure JS/web SDK only (confirmed via `Podfile.lock` grep). Adding native Firebase would be a real
   second SDK: its own auth session, its own config file, its own dependency surface — a much bigger
   commitment than option 1, and the kind of thing that deserves its own decision doc if it's ever
   pursued. **Not recommended unless option 1 proves insufficient.**

**Recommendation: don't build either Phase 2 or Phase 3 yet.** Ship Phase 1 (this doc's scaffold —
read-only Siri balance/group queries, Spotlight search, "Ask SplitCircle" handoff), see whether
users actually reach for Siri writes, and let real usage decide whether the added complexity of
Phase 2 (let alone Phase 3) is worth it. This mirrors doc 17 §6's own sequencing philosophy: ship
the smallest thing that fixes the visible gap first.

---

## 5. What we deliberately did not build

- **Onscreen awareness** (`.appEntityIdentifier` on live views, so Siri resolves "split *this*
  expense" while looking at it). The API is SwiftUI/UIKit-view-modifier-first; SplitCircle's UI is
  React Native. It's *possible* in principle (Fabric mounts real `UIView`s, and
  `AppEntityAnnotatable`/`UICollectionViewAppIntentsDataSource` are protocol-based, not
  SwiftUI-only) but would mean hand-annotating specific RN native view instances from Swift per
  screen — a much bigger, screen-by-screen undertaking with no existing precedent in this codebase
  to build on. Flagging as a real future capability, not attempting a guess at it now.
- **Spotlight tap-through deep linking.** `CSSearchableItem` results are indexed and searchable
  (§3), but tapping one currently does nothing useful — there's no confirmed React Navigation deep
  link route for "open this specific group" (searched `AppNavigator.tsx` for a `linking` config and
  didn't find one wired up). Deliberately did **not** guess a URL scheme and wire it into
  `AppDelegate.swift`'s `continue userActivity` — that method also carries the CallKit/Recents-redial
  path (CLAUDE.md Gotchas: "cold-start user activities... UIScene lifecycle is mandatory"), which is
  too load-bearing to extend on an unconfirmed assumption. Fix once an actual group deep-link route
  exists.
- **Write intents** (add expense / settle up via Siri) — see §4 Phase 2/3.
- **Visual Intelligence integration** (Camera-app / on-screen content search hooks) — no clear
  SplitCircle use case surfaced during research (it's aimed at "point camera at an object, find it
  in my app," which doesn't map to expense-splitting); not pursued.

---

## 6. Verification checklist for the next device session

Mirrors doc 17's spike-log format — fill this in on the first real build, don't trust this doc's
claims until then:

- [ ] `pod install` after the podspec `s.library = 'sqlite3'` change — no duplicate-symbol linker
  error against expo-sqlite's vendored copy.
- [ ] App builds on Xcode 27 beta (or current stable, whichever has AppIntents `IndexedEntity`).
- [ ] `SplitCircleShortcuts`' three shortcuts appear in the Shortcuts app after a cold install +
  first launch.
- [ ] "Hey Siri, check my SplitCircle balance" resolves a real group and gives a real number, with
  the app **fully killed** (proves the headless path actually works, not just foreground).
- [ ] Spotlight search for a real group name surfaces the indexed `CSSearchableItem`.
- [ ] Fresh install, Siri invoked before first app launch: `GetGroupBalanceIntent` gives the
  "sign in first" dialog, does not crash.
- [ ] File the PCC entitlement application (`developer.apple.com/contact/request/private-cloud-compute/`)
  if not already done — independent of all the above, has its own lead time.
