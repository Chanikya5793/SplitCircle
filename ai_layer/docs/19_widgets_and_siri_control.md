# SplitCircle — Widgets + Siri App-Control (build log & runbook)

> Companion to [`18_app_intents_siri_pcc_indexing.md`](18_app_intents_siri_pcc_indexing.md).
> Doc 18 scaffolded the read-only Siri surface (balance/list intents, Spotlight index).
> **This doc is the build-out**: home/lock/Control-Center **widgets**, Siri intents that
> **control the app** (open group / add expense / settle up / ask), and the deep-link
> plumbing that lands them on the right screen. iOS 27 target, iOS-app-only.
>
> Built 2026-07-13. Everything here **compiles on the pinned EAS ship image (Xcode 26.4 /
> iOS 26 SDK)** — iOS-27-only symbols stay behind `#if compiler(>=6.4)`, and the widget
> baseline is iOS 16–18 APIs. **Nothing here is device-verified** (no Xcode/device in the
> build env); treat it as spike-quality, same honesty bar as doc 17's spike log. §5 is the
> verification checklist.

---

## 0. What shipped in code vs. what needs one manual Xcode step

| Area | State |
|---|---|
| Siri **reads** app data (balance, group list) | Code complete (doc 18) — headless, deterministic |
| Siri **controls** the app (open group, add expense, settle up, ask) | Code complete — App Intents open the app prefilled via a deep link |
| **Shortcuts app** accessibility | Code complete — `AppShortcutsProvider` donates 6 shortcuts + phrases |
| **Widgets** (home small/medium, lock-screen accessory, Control Center) | Swift source complete; **needs the one-time Xcode target + App Group step in §4** |
| App Group data channel for widgets | Code complete on both sides; **entitlement intentionally NOT yet in the shipping app** (§3.3) |
| PCC for complex compute | Unchanged — still doc 17 Phase C; **file the entitlement request** (doc 18 §0) |

**The one blocking manual step** (§4): a Widget Extension is a separate Xcode *target* and
needs an *App Group* capability. Neither can be safely hand-written into the 668-line
`project.pbxproj` without risking every future `ship:ios` — so the source is all here, and
§4 is a ~15-minute one-time Xcode + developer-portal procedure you run once. After that, all
the code below is already in place and builds.

---

## 1. Architecture — three surfaces, two data channels

```
                     ┌──────────────────────────── app process ───────────────────────────┐
   JS (RN)           │  groupCache.persistGroups(user, groups)                              │
   expenseAnalytics ─┼─▶ widgetService.publishWidgetSnapshot ─▶ writeWidgetSnapshot (native)│
                     │        │                                    │                        │
                     │        │ (balances, same engine as the app) │                        │
                     │        ▼                                    ▼                        │
                     │   App Group container            UserDefaults.standard               │
                     │   group.com.splitcircle.app      (shared w/ JS Settings)             │
                     │   └ widget.json                  ├ SplitCircleCurrentUserId          │
                     │        ▲          ▲              └ SplitCirclePendingDeepLink         │
                     └────────┼──────────┼──────────────────────▲──────────────────────────┘
                              │          │                       │ set by in-process App Intents
              ┌───────────────┘          └──────────┐            │ read by deepLinkService (JS)
              │ (separate process)                  │            │
     ┌────────┴─────────┐                 ┌──────────┴────────┐   │
     │ Widget Extension │                 │ App Intents (pod) │───┘
     │ reads widget.json│                 │ headless reads +  │
     │ renders balances │                 │ open-app controls │
     └──────────────────┘                 └───────────────────┘
```

**Two channels, chosen by process visibility (the key design constraint):**

- **App Group container** (`group.com.splitcircle.app` → `widget.json`) — the ONLY store a
  Widget Extension (separate sandbox) can read. Holds the compact balance snapshot.
- **`UserDefaults.standard`** — shared between the JS runtime (`Settings`) and App Intents
  that run *in the app process*. Holds the current-user id (doc 18) and the pending
  deep-link handoff. A widget can't see this; that's why balances go through the App Group.

**Numbers rule holds everywhere:** balances are computed once by the JS `expenseAnalytics`
engine and only *relayed* to native/widget — no Swift and no LLM recomputes a balance.

---

## 2. Files

### Native (compiled into the app via the SplitCircleAI pod — auto-globbed, no pbxproj edit)
- `modules/splitcircle-ai/ios/SplitCircleSharedStore.swift` — App Group writes (`widget.json`
  + `WidgetCenter.reloadAllTimelines`) and the `UserDefaults` pending-deep-link setter.
- `modules/splitcircle-ai/ios/SplitCircleIndexReader.swift` — **refactored** to read the App
  Group snapshot first (extension-safe, carries balance + currency), SQLite `ai_index.db`
  as fallback.
- `modules/splitcircle-ai/ios/SplitCircleIntents.swift` — read intents (balance/list) +
  **new** control intents `OpenGroupIntent`, `AddExpenseIntent`, `SettleUpIntent`,
  `AskSplitCircleIntent`, all opening the app prefilled; `SplitCircleShortcuts` donates 6.
- `SplitCircleAIModule.swift` — **new** JS bridge fns `writeWidgetSnapshot` / `reloadWidgets`
  / `getAppGroupId`.

### Native (the Widget Extension target — source ready, target created in §4)
- `ios/SplitCircleWidgets/SplitCircleWidgetBundle.swift` — `@main` bundle.
- `ios/SplitCircleWidgets/BalanceWidget.swift` — small/medium/accessory families, iOS-26
  Liquid-Glass container background, deep-link taps via `.widgetURL`/`Link`.
- `ios/SplitCircleWidgets/SplitCircleControl.swift` — iOS 18 Control Center control.
- `ios/SplitCircleWidgets/WidgetSharedStore.swift` — minimal, self-contained App Group
  reader (intentional read-only duplicate — a widget can't link the Expo pod).
- `ios/SplitCircleWidgets/Info.plist`, `ios/SplitCircleWidgets/SplitCircleWidgets.entitlements`.

### JS
- `src/services/widgetService.ts` — projects group balances → `writeWidgetSnapshot`.
- `src/services/deepLinkService.ts` — `useDeepLinks()` hook: parses `splitcircle://…`, drains
  the pending App-Intent link on foreground, navigates via `navigationRef`.
- `src/navigation/navigationRef.ts` — extracted container ref (avoids an import cycle).
- Wired: `groupCache.persistGroups` (snapshot), `AppNavigator` (`<DeepLinkHandler/>`),
  `AddExpenseScreen`/`AddExpenseRoute` (`initialAmount`/`initialTitle` prefill).

### Deep-link vocabulary (authored in Swift + widget, consumed in `deepLinkService.ts`)
```
splitcircle://group/<groupId>
splitcircle://groups
splitcircle://add-expense?group=<id>&amount=<n>&title=<t>
splitcircle://settle?group=<id>
splitcircle://ask?group=<id>&q=<question>
```

---

## 3. Design decisions worth knowing

### 3.1 Why control intents *open the app* instead of writing headlessly
"Siri controls the app" v1 = Siri gathers params → opens the real, tested Add-Expense /
Settle-Up / group screen **prefilled** → the user reviews and taps Save through the existing
validated outbox path. Rationale: (a) the confirmation happens in known-good UI, not a
version-sensitive `requestConfirmation` API we can't compile-check against the pinned Xcode
26.4 SDK; (b) an expense needs payer/participants/split-method that a one-line Siri phrase
doesn't carry — the prefilled screen lets the user complete them; (c) it reuses the whole
offline outbox + validation stack unchanged. **Truly-headless queued writes** (Siri adds an
expense with the app fully closed, syncing later) remain the documented Phase 2 in doc 18 §4
— defer until the open-app path proves its value.

### 3.2 Widget refresh is push, not poll
The app calls `WidgetCenter.reloadAllTimelines()` inside `writeWidgetSnapshot` every time
balances change, so the timeline is a single entry + a lazy 1-hour safety refresh — no
budget-burning polling.

### 3.3 Why the App Group entitlement is NOT in the shipping app yet
The moment `com.apple.security.application-groups` lands in `ios/SplitCircle/SplitCircle.entitlements`,
the next production build **requires** that capability provisioned on the `com.splitcircle.app`
App ID or **signing fails** — which would break `ship:ios`. Since the widget target doesn't
exist in `pbxproj` until §4 anyway, nothing widget-related can build regardless. So the app
entitlement addition is deferred into §4, kept as a comment in the entitlements file. Until
then: `writeWidgetSnapshot` finds no App Group container and no-ops; Siri intents fall back to
the SQLite index; everything degrades gracefully and the ship pipeline is untouched.

---

## 4. RUNBOOK — one-time widget enablement (~15 min, run once)

Do these in order. Steps A–B are the developer portal; C–E are Xcode; F is the ship pin.

**A. Register the App Group (developer portal).**
1. Certificates, IDs & Profiles → Identifiers → **App Groups** → **+** → `group.com.splitcircle.app`.
2. Identifiers → `com.splitcircle.app` → enable **App Groups**, assign the group above. Save.

**B. Create the widget App ID.**
3. Identifiers → **+** → App ID `com.splitcircle.app.SplitCircleWidgets`, enable **App Groups**,
   assign `group.com.splitcircle.app`. Save.

**C. Add the Widget Extension target (Xcode — open `ios/SplitCircle.xcworkspace`).**
4. File → New → Target → **Widget Extension**. Product name **SplitCircleWidgets**, uncheck
   "Include Live Activity" and "Include Configuration Intent" (we ship a StaticConfiguration).
   Embed in **SplitCircle**. This creates the target + updates `project.pbxproj` correctly.
5. **Delete the auto-generated sample files** Xcode adds (its `SplitCircleWidgets.swift`,
   sample bundle, assets you don't need) so `@main` isn't declared twice.
6. **Add the real source** (already on disk in `ios/SplitCircleWidgets/`): right-click the
   target group → Add Files → select `SplitCircleWidgetBundle.swift`, `BalanceWidget.swift`,
   `SplitCircleControl.swift`, `WidgetSharedStore.swift` — target membership = **SplitCircleWidgets only**.
   Point the target's Info.plist build setting at the provided `ios/SplitCircleWidgets/Info.plist`.
7. Widget target Build Settings: **iOS Deployment Target = 17.0** (containerBackground +
   interactive widgets; the Control Center control self-gates to iOS 18).

**D. Wire the App Group capability (Xcode).**
8. Target **SplitCircle** → Signing & Capabilities → **+ Capability → App Groups** → check
   `group.com.splitcircle.app`. This flips the commented block in `SplitCircle.entitlements`
   live (or just uncomment it to match).
9. Target **SplitCircleWidgets** → Signing & Capabilities → **+ App Groups** → same group.
   Set its entitlements file to `ios/SplitCircleWidgets/SplitCircleWidgets.entitlements`.

**E. Build & smoke-test (simulator is fine for rendering; Siri/headless needs a device).**
10. Build the app scheme; then run the **SplitCircleWidgets** scheme to preview the widget.
    Add the widget from the home screen; it shows the empty state until the app writes a
    snapshot (open the app once while signed in).

**F. EAS credentials for the ship (before the next `ship:ios`).**
11. `eas credentials` → iOS → production → let EAS create/sync a provisioning profile for the
    new `com.splitcircle.app.SplitCircleWidgets` App ID **and** re-sync the main app profile so
    both carry the App Group. (EAS generally auto-detects the extension target from the
    committed `pbxproj`; confirm both profiles list the App Group capability.)
12. `npm run ship:ios --build-only` first to confirm signing is green before submitting.

> If step 12 fails on a provisioning/entitlement mismatch, the App Group isn't fully synced —
> revisit A/B/F. Do NOT ship the app entitlement (D8) without A/B done, or signing fails.

---

## 5. Verification checklist (fill in on the first real build — don't trust this doc until then)

- [ ] `pod install` clean (done in the build env: yes).
- [ ] App + widget targets both build on Xcode 26.4 (the ship image) — no iOS-27-symbol leak.
- [ ] Widget added to home screen renders a real balance after opening the app once.
- [ ] Medium widget rows deep-link to the right group on tap.
- [ ] Lock-screen accessory + Control Center control appear and open the app.
- [ ] "Hey Siri, add an expense in <group>" opens Add-Expense **prefilled** (amount/title).
- [ ] "Hey Siri, open <group>" lands on that group with the app previously killed (headless
      launch → pending-deep-link drained on foreground).
- [ ] All 6 shortcuts appear in the Shortcuts app after a cold install + first launch.
- [ ] Signed-out: intents/widgets show empty/"sign in" states, never crash.
- [ ] `ship:ios --build-only` green with the App Group capability provisioned.

---

## 5b. Advanced Shortcuts / Siri intents (added 2026-07-14)

The read surface was expanded from "open the app" + basic balance into a set of
**data-returning** intents that Shortcuts can chain and Siri can reason over. All
headless, all sourced from the enriched App Group snapshot (below).

**Enriched snapshot** — `widget.json` now carries, per group (all optional, widget
ignores extras): `totalSpend`, `count`, `members[{name,balance}]`,
`categories[{category,total}]`, `youOwe[{name,amount}]`, `owesYou[{name,amount}]`,
`recentExpenses[{id,title,amount,category,date,paidByName}]`. Built in
`widgetService.ts` from `getGroupAnalytics` (`debts` split into you-owe / owes-you
relative to the current user; ids as `<groupId>::<expenseId>`). Capped: 12 groups,
8 recent expenses, 8 categories.

**New intents** (`SplitCircleIntents.swift`) — all `ReturnsValue` so they compose:
| Intent | Returns | Siri phrase |
|---|---|---|
| `GetGroupBalanceIntent` (upgraded) | `Double` (signed) + dialog | "what do I owe in \<group\>" |
| `GetNetBalanceIntent` | `Double` net across groups | "what's my overall balance" |
| `GetRecentExpensesIntent` | `[SplitCircleExpenseEntity]` | "show my recent expenses" |
| `GetAmountOwedIntent` | `Double` (+ you owe them) | "what do I owe in \<group\>" (asks who) |
| `GetCategorySpendIntent` | `Double` | "check category spending in \<group\>" |

**New entity** — `SplitCircleExpenseEntity` (`SplitCircleExpenseEntity.swift`):
`AppEntity` + `EntityQuery`/`EntityStringQuery` (Shortcuts "Find", by-id, text search)
+ `IndexedEntity` (iOS 27, Spotlight semantic index). Recent expenses are now also
Spotlight-indexed (`SplitCircleSemanticIndex.indexExpenses…`), so Siri can resolve
"the dinner expense".

**Two constraints learned/enforced:**
- `AppShortcutsProvider` allows **max 10** shortcuts — we're now at exactly 10.
- An `AppShortcut` phrase may interpolate **one AppEntity/AppEnum** parameter, never a
  `String` or an optional — so `person`/`category`/`count` are prompted at run time,
  not spoken inline. (This was a build-blocking rule; phrases were adjusted.)
- Access-level trap: a `public` AppEntity init can't take an `internal` parameter type
  (`SplitCircleExpenseEntity.init(from:)` is `internal`; the type stays `public`).

## 6. Deferred (documented, not built)

- **Headless queued writes** (Phase 2, doc 18 §4) — Siri adds an expense with the app closed,
  synced on next launch via a `siri_inbox` App Group table → existing outbox.
- **Interactive widget actions** beyond deep-link taps (e.g. an in-widget "add expense" Button
  running an AppIntent without leaving the home screen) — needs a shared AppIntent target the
  widget links; revisit if users want it.
- **Live Activities** (a running "trip tab" total) — real WidgetKit surface, no current ask.
- **Richer read intents** (per-person "what do I owe Sarah") — easy follow-on once the base
  intents are device-verified.
- **PCC** — unchanged; doc 17 Phase C + the entitlement application (doc 18 §0).
