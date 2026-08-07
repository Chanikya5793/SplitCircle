# 37 — Flat surface mode (borderless UI behind a toggle)

**Status:** Decisions LOCKED 2026-08-06. **Phases 1–4 BUILT.** Phases 1–3
committed as `9a957e9` on `ui-revamp` (67 files); Phase 4 follows it. Typecheck
clean, 993 tests green, and `9a957e9` was verified to typecheck *in isolation*
in a detached worktree — the working tree also carries unrelated in-progress AI
work, so a green tree does not by itself prove the commit is self-consistent.
Four WCAG follow-ups landed after that (status/money/danger-token/accent-primary
tokens, commits `716ab46`→`e501046`). **Phase 5 (2026-08-07) — new design
direction, scoped to `GroupListScreen`/`GroupDetailsScreen`/`DebtsList` as a
starting point.** **Phase 6 (2026-08-07, same session, "keep going, apply
consistently") — generalized Phase 5 app-wide: zero dividers (~40 sites, 20
files), compact spacing (~20 files), 2 more glass-accent containers. See §8.**
**Phase 7 (2026-08-07) — tap/press-state color root-cause fix.** **Phase 8
(2026-08-07, user: "zero dividers anywhere, no exceptions") — final divider
audit, 16 more sites across 12 more files. See §11.** Uncommitted as of
writing.

**Installed and launched on a physical iPhone 17 Pro (iOS 27), but the visual
result has NOT been reviewed on a screen.** The app starts and stays up; that is
all that has been shown. Per this repo's own "verify the user-facing path" rule,
flat mode is not proven until someone actually looks at it.

**Goal:** a second, **borderless** UI the user can switch to, the same way they
already switch light/dark and accent. The shipping liquid-glass UI is untouched
and stays the default.

**Locked decisions (user, 2026-08-06):**

1. **Borderless**, not inset-grouped. No fills, no borders — content sits on the
   canvas, grouped by section labels and dividers.
2. **The current shipping UI stays.** Flat is purely additive, behind a toggle.
3. **Do not touch the wallpaper/background system.** Blob and photo behavior is
   unchanged.
4. **Add solid colour background options** — additively, as new entries in the
   existing wallpaper picker.
5. Chat bubbles stay bubbles (they are not cards).
6. Light-mode `muted` is darkened for contrast headroom (§2).

---

## 1. Why this is cheap (the one-primitive lever)

Every glass surface in the app funnels through one component.

| Symbol | Usages | Notes |
|---|---:|---|
| `<GlassCard>` | 109 | the real primitive (`src/components/ui/GlassCard.tsx`) |
| `<GlassView>` | 135 | **pure re-export of GlassCard** (`src/components/GlassView.tsx`) |
| **Total** | **244** | across **61 files** |

`GlassView` is a deprecated shim whose whole body renders a `GlassCard`. So the
flat treatment is one branch inside `GlassCard`, and all 244 surfaces follow.
This is DESIGN.md's "One primitive. ALL glass goes through `GlassCard`" rule
paying off.

Checked mechanically: **0** call sites set `backgroundColor` on the glass
element itself, and only ~15 of 118 passed style keys touch fill/border/
elevation. The primitive owns the material.

### 1.1 …but not every surface is a card

**The single most important finding for borderless.** Of the 244 surfaces,
roughly **54 (27 files) are floating chrome**, not content: bottom sheets,
toasts, menus, dropdowns, autocompletes, circular icon buttons, sticky header
pills, modals, loading overlays.

A borderless toast is an invisible toast. A borderless bottom sheet is
unreadable text over whatever is scrolling behind it. **Borderless cannot be a
blanket primitive-level change** — that would have broken every sheet and menu
in the app.

So `GlassCard` takes a structural role (`src/components/ui/surfaceRole.ts`):

```ts
type SurfaceRole = 'section' | 'floating';
```

- **`'section'`** (default) — a content card. Goes fully borderless when flat.
- **`'floating'`** — keeps an opaque fill + hairline when flat.

Rule of thumb: *if removing the surface entirely would leave content floating
over unrelated scrolling content, it is `'floating'`.*

`role` is **ignored entirely in glass mode**, which is what makes decision (2)
enforceable: whatever the role says, the shipping UI renders identically.

`GlassView` forwards `role` too — without that, 135 of the 244 surfaces could
never opt out of borderless.

---

## 2. Contrast: why the background matters more in flat mode

In glass mode the blur/liquid material sits between the ambient blobs and the
text and is doing real **legibility** work, not just decoration. Borderless
removes it entirely — there is no card fill left on a content screen, so
**whatever the user picks as their background is literally the background the
body text sits on.**

Measured (WCAG 2.1, worst-case blob per scheme, shipped blob opacity `0.45`):

| Scenario | Light — body / muted | Dark — body / muted |
|---|---|---|
| Text on plain `appBackground`, no blobs | 14.17 / **4.59** | 17.02 / 7.38 |
| Borderless over blobs | 9.01 / **2.92 ✗** | 9.85 / **4.27 ✗** |
| Glass tint over blobs | 9.85 / **3.19 ✗** | 10.75 / 4.66 ✓ |
| Borderless on a solid background | 14.68 / **4.76 ✓** | 14.07 / 6.10 ✓ |

Solving for the maximum blob opacity that keeps `muted` AA-compliant with no
material: **0.021** light, **0.311** dark.

**This is why solid backgrounds exist** — and why they are offered rather than
forced. Per decision (3) the blob system is untouched: a user can absolutely run
borderless over animated blobs, and body text stays fine (9:1). It is secondary
/`muted` text that degrades. Picking a solid background is the fix, and it is
theirs to make.

**`muted` darkened (decision 6).** Light-mode `muted` was `#64748B` — only
**4.59:1** on `appBackground` *with no blobs at all*, i.e. already on the AA line
before anything is layered over it, and under it on any tinted solid background.
Now `#5A6675` (5.62:1 on `appBackground`, 5.82:1 on white).

> **This is the one change that touches the shipping glass UI.** Light-mode
> secondary text gets slightly darker everywhere. It was explicitly approved,
> and it is a pre-existing accessibility bug that glass was masking — but it is
> not invisible, so it should be eyeballed on device before shipping.
>
> Not changed: `moneyNeutral` is still `#64748B` and has the same issue in the
> same places. Left alone deliberately — money colouring is its own decision.

> Caveat, stated honestly: these numbers model the blur tier as a flat tint
> composite. Real iOS 26 `UIGlassEffect` also blurs and applies adaptive
> vibrancy, so true glass contrast is better than the "Glass tint" row. The
> borderless rows involve no material and are exact.

---

## 3. Architecture

Mirrors how `mode` and `accent` already work — no new pattern.

```
tokens.ts            SurfaceStyle = 'glass' | 'flat'  +  flatRadius scale
surfaceRole.ts       SurfaceRole  = 'section' | 'floating'
palette.ts           flatSurface / flatSurfaceAlt / flatBorder / divider
                     + muted darkened (light)
buildTheme.ts        buildTheme(scheme, accent, surfaceStyle = 'glass')
ThemeContext         surfaceStyle + setSurfaceStyle, persisted in the SAME
                     `appearance_v1` blob as mode/accent
GlassCard.tsx        flat+section → borderless · flat+floating → opaque fill
                     · glass → completely unchanged
GlassView.tsx        forwards `role`
SettingsScreen       SegmentedButtons [Glass | Flat] beside mode/accent
solidBackgrounds.ts  SOLID_BACKGROUNDS presets (own module, zero imports)
wallpaperService     + kind 'solid'  (blob/photo paths untouched)
LiquidBackground     + solid branch  (blob/photo paths untouched)
```

Decisions worth recording:

- **Default is `glass`.** An existing install must not silently reskin on
  upgrade. A stored `appearance_v1` written before this key existed has no
  `surfaceStyle` and falls through to `'glass'` — no migration needed.
- **Borderless neutralizes horizontal padding.** In glass mode a card's padding
  sat *inside* a visible box; with the box gone it reads as a stray indent that
  pushes content out of line with the screen gutter and with its own section
  label. `GlassCard` flattens the caller's `style`/`contentStyle` and zeroes
  horizontal padding; margins, width and layout survive. Vertical padding
  survives too — it becomes the rhythm between rows.
- **A numeric `radius` prop survives flattening.** `radius={50}` on a circular
  icon button is an explicit geometric requirement; flattening it would turn
  circles into squares.
- **Borderless renders plain `View`s, not `Animated.View`.** Nothing in it
  animates, so there is no reason to pay for Reanimated on ~190 surfaces.
- **Flat drops Android `elevation`.** A flat surface that casts a shadow is
  just a card again.
- **`GlassCard` reads `surfaceStyle` defensively** (`theme?.surfaceStyle`).
  Several component tests mock `useTheme()` with partial themes; undefined must
  mean glass, not crash and not silently flatten.
- **`SOLID_BACKGROUNDS` lives in its own module**, not `wallpaperCatalog.ts`,
  which `require()`s JPEG thumbnails at module scope that a node test runner
  cannot resolve. Keeping it standalone lets the contrast test import the real
  values instead of a copy that can drift.

### 3.1 A real bug the type system caught

Adding `kind: 'solid'` to the wallpaper union surfaced that `copyWallpaper`
assumed *"not photo ⇒ blob"* and did `[...source.light]`. For a solid, `light`
is a hex **string**, so that would have spread `'#F9FBFF'` into seven
single-character array entries and written a corrupt entry. Now branches on the
actual kind. Worth noting because it is the shape of bug this repo keeps
hitting: a discriminated union grown by one variant, with an older path still
assuming the old binary.

---

## 4. What does NOT route through the primitive

| Surface | Count | Notes |
|---|---:|---|
| `<BlurView>` outside `GlassCard` | 7 sites, 4 files | All deliberate full-bleed **scrims**. Resolved in Phase 3 — see §5. |
| ~~`react-native-paper` `<Card>`~~ | ~~9~~ | **This entry was wrong.** See the correction below. |
| Hand-rolled card-ish styles | 53 blocks, 21 files | Mostly **not** cards. See the correction below. |
| `MessageBubble` chat bubbles | ~20 rgba literals | **Out of scope** — decision (5), bubbles stay bubbles. |
| `SkeletonLoader` | 9 | Needed **no change** — it uses `GlassCard` at the default `role="section"`, so it already goes borderless with the content it mirrors. |
| Native tab bar (UITab/UISearchTab) | — | **Out of scope.** System material, not ours; see doc 20 before touching tabs. |

### 4.1 Two corrections to this table (found while building Phase 3)

Both came from trusting a grep instead of reading the code, and both would have
caused wrong work. Recorded rather than quietly fixed.

**There are no `react-native-paper` `<Card>`s in this app.** The original audit
matched `<Card\b` in `PrivacyGuardSheet.tsx` and attributed it to paper without
checking the import — paper's `Card` is never imported there (line 47 imports
only `Switch, Text`). `Card` is a *local* 14-line component defined in that
file, rendering a translucent inset `View` from local `cardTint()`/`hairline()`
helpers. So the "standing DESIGN.md violation" claimed here never existed. The
real (smaller) issue was that this local card ignored `surfaceStyle`.

**The "53 hand-rolled card styles" are overwhelmingly not cards.** Re-triaged by
reading each style body rather than pattern-matching `borderRadius` +
`backgroundColor`: **30** are round/pill geometry (avatars, badges, dots, chips,
progress bars, grabbers) and of the remaining 24, nearly all are media or
overlay chrome — photo-grid cells (`AlbumBubble`, `ChatMediaGalleryScreen`),
video PiP, image placeholders, swipe-delete actions, busy scrims, buttons, and
tab-bar accessories that are already `transparent`. **Flattening those would
break them** — a borderless photo-grid cell or swipe-delete action is a bug, not
a flatter UI. Exactly one is a genuine content surface
(`NotificationSettingsScreen.callDebugLogBox`, a debug-only box), and it was
left alone deliberately. The honest count for this row is ~1, not 53.

---

## 5. Phased plan

**Phase 1 — foundation. BUILT (spike, validated).**
Tokens, roles, palette, `buildTheme`, `ThemeContext`, the `GlassCard` branch,
`GlassView` forwarding, the Settings toggle, solid backgrounds end-to-end
(service + catalog + picker + `LiquidBackground` + Settings preview).
12 files. Flips all 244 surfaces.

**Phase 2 — role classification. BUILT.** Every one of the 244 call sites was
classified from an explicit per-site decision table (file → floating style
names), not a filename heuristic:

| | Count |
|---|---:|
| `role="floating"` (chrome) | **100**, across 48 files |
| `role="section"` (default, borderless) | 143 |
| `GlassView` shim internal | 1 |

**The filename estimate of ~54 was wrong by nearly half** — chrome lives in
content-named files. `ChatRoomScreen` alone had 8 (header pills, composer,
balance pill, nav buttons), `GroupListScreen` 6, `BillSplitScreen` 5,
`CallSessionScreen` 3 (pills over live video), `AiChatScreen` 4. Sizing this by
filename would have shipped every one of them borderless.

Three independent checks were run for **misses**, which are the dangerous
direction (a missed sheet renders with no background):

1. Unmarked sites whose own style carries floating signals
   (`position:'absolute'`, `zIndex`, `shadowOpacity`, `bottom:0`) — **0 found**.
2. Unmarked sites rendered inside a `<Modal>` — 5 found, all in
   `NearbyMessagingSheet`, all correctly nested inside its `role="floating"`
   sheet (opens L243, closes L682). Content going borderless on top of a
   floating sheet's own fill is the intended nesting, not a miss.
3. Every insertion verified to have landed on a glass tag (0 malformed).

Guarded permanently by `surfaceRoleCoverage.test.ts` (§7).

**Phase 3 — the stragglers. BUILT.** Much smaller than scoped, for the reasons
in §4.1. What actually shipped:

- **`PrivacyGuardSheet`'s local `Card`** now branches on `surfaceStyle`: flat
  drops the tint/border entirely and lets the rows' existing hairline dividers
  carry the grouping. Its `Row` also drops its own 14pt horizontal inset when
  flat — the enclosing card no longer has a box, so that inset would have sat
  row content at 34pt while the section headings beside it sat at the body's
  20pt gutter. One gutter now governs the sheet.
- **`ScrimBackdrop`** (`src/components/ui/ScrimBackdrop.tsx`) — a new primitive
  for full-bleed backdrops: `BlurView` in glass, a plain dim layer using the
  existing `overlay` semantic token in flat. All 7 scrim sites moved onto it.
  DESIGN.md's carve-out for scrims stands; this just stops it being a
  judgement call re-made at each site. In flat mode the sheet in front is
  `role="floating"` and already opaque, so the scrim only has to separate — and
  a blurred backdrop would otherwise have been the one glass signature to
  survive flat mode.
- **Four dead/newly-unused `expo-blur` imports removed**, including a
  pre-existing orphan in `GroupDetailsScreen` that imported `BlurView` and
  never used it.
- **`SkeletonLoader`: no change needed** — already correct via the primitive.
- **The 53 hand-rolled blocks: deliberately not touched** (§4.1).

Net effect: `expo-blur` is now imported in exactly **two** files, `GlassCard`
and `ScrimBackdrop` — which makes DESIGN.md's hand-grep self-audit rule
mechanically checkable for the first time, and it is now a test (§7).

**Phase 4 — DESIGN.md + dividers. BUILT (docs); dividers mostly unnecessary.**

DESIGN.md rewritten: "One surface class / when in doubt: glass" became **"Two
surface styles, ONE primitive"** — the binding rule is now *everything goes
through the primitive, and the primitive decides the material*, with the glass
contract preserved beneath it as the default treatment. The self-audit checklist
was re-scoped (a flat-token fill resolved BY the primitive is correct; a fill the
call site chose is still the bug), the BlurView carve-out was deleted now that
`ScrimBackdrop` exists, and the `role` requirement was added to the
before-you-touch-a-sheet checklist. Without this the next audit would have
reported flat mode as 244 violations.

**Dividers turned out to be largely unnecessary** — worth recording, because the
plan assumed otherwise. The existing structure already survives flattening:

- `SettingsScreen` and friends are already SectionLabel + one card + inner
  `{divider}` rows; the labels and hairlines group with no card edge needed.
- `GroupStatsScreen` / `PersonalStatsScreen` stack cards that each carry their
  own `sectionTitle`, so the headings separate them.
- Borderless **keeps vertical padding** (only horizontal is zeroed), so the
  rhythm between stacked sections survives on its own.

Only one hand-rolled divider colour existed app-wide (`SettingsScreen`); it is
now `theme.colors.divider`, which matters more in flat where the hairline IS the
grouping rather than a detail inside a card.

No speculative `divided` prop was added to `GlassCard`. Whether stacked
*list-row* screens (group list, friends) need explicit separators is a visual
judgement that needs a real screen — inventing an unused API ahead of that would
be guessing.

Phase 1 alone is coherent and shippable-to-yourself: body text stays legible in
every combination. Phase 2 is required before anyone else sees it.

---

## 6. Risks and gotchas

- **DESIGN.md becomes partly wrong the day flat ships.** It currently binds
  "EVERY screen/overlay ships GLASS-FIRST … There is no solid exception anymore"
  and "When in doubt: glass." That must be rewritten as *"every surface goes
  through the primitive; the primitive decides the material"* — otherwise the
  next audit reports flat mode as 244 violations. Required deliverable, not a
  follow-up.
- **The glass self-audit grep gets a false-positive class.** DESIGN.md tells
  reviewers to grep for `backgroundColor:` + hardcoded hex on floating surfaces.
  Flat mode legitimately introduces opaque fills for `role="floating"`. Re-scope
  the rule to "opaque fill *not* sourced from a flat token".
- **`role="section"` is always valid TypeScript.** A new sheet added without a
  role compiles, passes review, and renders with *no background at all* in flat
  mode — invisible in glass mode, where role is ignored. This is the same shape
  as this repo's `isGroupJoinUpdate` gotcha: a path added later than the
  canonical one, with nothing mechanical to catch the omission. That is exactly
  why `surfaceRoleCoverage.test.ts` exists; keep it green.
- **The `muted` change is visible in glass mode.** See §2 — it is the one thing
  here that alters the shipping UI.
- **The iOS 26 native-material kill list stops applying in flat mode.** The 8
  `forceBlur` sites become no-ops when flat — harmless, but they are still
  load-bearing in glass mode. Don't "clean them up".
- **Android already looks half-flat** (near-opaque tint + `elevation: 4`), so
  the visual delta there is much smaller. That is not the feature failing.
- **Toggling re-renders all 244 surfaces.** `GlassCard` is memoized on props but
  `surfaceStyle` arrives via context. Fine for a settings toggle (same cost as
  changing accent today); never drive it from anything high-frequency.
- **Green does not mean rendered.** Per this repo's own history — the `nm`-on-a-
  stripped-binary and `isGroupJoinUpdate` gotchas — `tsc` and 989 passing tests
  say nothing about whether a surface draws correctly.

---

## 7. Validation performed

| Check | Baseline | After Phase 1 |
|---|---|---|
| `npx tsc --noEmit` | clean (exit 0) | clean (exit 0) |
| `npm run test:unit` | 42 files / 472 | **45 / 499** ✓ |
| `npm run test:services` | 46 files / 466 | 46 / 466 ✓ |
| `npm run test:dom` | 8 files / 27 | 8 / 27 ✓ |

CLAUDE.md's "4 pre-existing test-lib errors are known" for `tsc` is **stale** —
`tsc --noEmit` is completely clean.

Two new test files, 24 tests:

- `flatSurfaceContrast.test.ts` (8) — flat fills are opaque hex (never rgba);
  body **and muted** text clear AA per scheme; the fill is distinguishable from
  the canvas. **Negative-controlled:** making the fill translucent, or setting a
  low-contrast dark fill, each fail it correctly.
- `solidBackgroundContrast.test.ts` (16) — every preset is opaque hex in both
  schemes, ids unique, body and muted text clear AA on all of them, and light
  presets are actually light (catches a light/dark field swap, which contrast
  alone would not).

- `surfaceRoleCoverage.test.ts` (4) — the Phase 2/3 guards. Scans all 244 call
  sites and asserts every glass surface inside a `<Modal>` is either
  `role="floating"` itself or nested inside one that is, resolving nesting with
  a real open/close stack rather than proximity. Also asserts the scan still
  finds >200 surfaces and >50 floating ones, so it can't silently degrade into
  a test that checks nothing. **Negative-controlled:** un-marking
  `EmojiPickerSheet`'s sheet fails it with the exact `file:line`.
  Nothing in the type system can catch this class of bug — `role="section"` is
  always valid TypeScript; it is just invisible at runtime in flat mode.
  It also asserts **blur is confined to `GlassCard` and `ScrimBackdrop`**,
  turning DESIGN.md's manual grep rule into a real check.
  **Negative-controlled:** adding a stray `expo-blur` import to an unrelated
  screen fails it by name.

**The solid-background test failed on first run and caught four real defects in
presets written minutes earlier** (`solid-mist` 4.37:1, `solid-ink` 4.21:1, and
two more — all light-mode `muted`). Fixed by the `muted` darkening in §2 rather
than by loosening the threshold.

**Not verified: nothing has run on a simulator or device.** Per this repo's
"verify the user-facing path" rule, flat mode is not proven until someone flips
the toggle on a real screen. The spike proves it compiles and type-checks.

---

## 8. Phase 5 — compact density + a third role, `'glass'` (2026-08-07)

New direction from the user, on top of Phases 1–4: no dividers between list
items, a materially more compact layout ("iOS Settings density, not
card-based spacing"), and a small set of hero containers that should read as
real Liquid Glass even in an otherwise flat/borderless UI. Scoped to
`GroupListScreen`, `GroupDetailsScreen`, and `DebtsList` ("who owes whom")
first, per the user's own "start here, then apply consistently" instruction —
**not yet applied app-wide.**

**A third `SurfaceRole`, `'glass'`** (`src/components/ui/surfaceRole.ts`).
`'section'` and `'floating'` are both flat-mode-dependent; `'glass'` opts OUT
of `surfaceStyle` entirely — it always falls through to `GlassCard`'s
existing native-liquid-glass-or-BlurView path (`expo-glass-effect` /
`ExpoGlassEffect`, the same mechanism glass mode already used everywhere,
already wired — no new native module work). One-line change in `GlassCard.tsx`:
the flat-opaque-fill branch's guard became `if (isFlat && role !== 'glass')`.
Applied to exactly two containers: `GroupDetailsScreen`'s `headerCard`
(group name/avatar + `BalanceSummary` — a single existing container, so
"group header" and "balance section" from the request are the same surface)
and `DebtsList`'s outer `GlassView` ("who owes whom"). Use sparingly — this is
a named accent, not a new default treatment; doc comment says so explicitly.

`surfaceRoleCoverage.test.ts`'s Modal-chrome safety check was extended to
also treat `role="glass"` as safe (same invariant as `floating`: it always
renders a real, visible material, so it can never be the "invisible sheet in
flat mode" bug the test exists to catch). Neither of the two `'glass'` sites
added here are inside a `<Modal>`, so this didn't change today's pass/fail —
it's forward coverage for whoever uses `'glass'` inside a sheet later.

**Dividers:** audited before assuming there was work to do. `theme.colors.
divider` (the only divider token) turned out to be used in exactly one screen
app-wide (`SettingsScreen`) — Phase 4 already found dividers "largely
unnecessary" (§5) and that held up under a fresh grep. The one real separator
in this session's three target files was `DebtsList`'s debt-breakdown modal
transaction rows (`borderBottomWidth: 0.5`) — now `0` in flat mode, kept in
glass mode. `GroupListScreen`/`GroupDetailsScreen`/the main `DebtsList` rows
never had divider lines to begin with (row-to-row separation is spacing, via
`gap`/`marginBottom`, not a hairline) — "remove all dividers" cost one edit,
not a sweep.

**Compactness — exact deltas** (all `src/components/SwipeableGroupCard.tsx`
unless noted): card `marginBottom` 12→6, `content.padding` 16→11,
`total.marginTop` 12→6, `rightAction.marginBottom` 12→6 (kept equal to the
card's own, or the swipe action drifts out of alignment with the card).
`GroupDetailsScreen.tsx`: `container.padding`/`gap` 8→6, `headerCard.padding`
10→8, `header.marginBottom` 6→4, `sectionHeader` margins 4→2. `DebtsList.tsx`:
`container.gap` 16→10, `list.gap` 10→8. These are literal, hand-picked pixel
deltas, not a new spacing-token scale (unlike `flatRadius`, there is no
`flatSpacing` — most of this app's screens use raw numbers in
`StyleSheet.create`, not `theme.spacing`, so a token-driven density switch
would be a much larger refactor than these two screens needed).

**Not done / open questions for whoever picks this up next:**
- **Not visually verified anywhere.** No simulator runtime is currently
  available on this machine (wiped by an Xcode update, see
  [[ios27-sim-verification-workflow]]) — every number above is a reasoned
  guess, not something anyone has looked at. Treat this phase as unverified
  until it's actually seen on a screen, same as Phases 1–4.
- **"Apply consistently" is not done.** Only the three named files were
  touched. No other screen's spacing or divider usage was audited or changed.
- The user described a screenshot showing the current state; it was never
  actually received in this session, so the exact compactness/glass-placement
  target was inferred from the written description alone.
- No test suite covers spacing/density (there's no pixel-value test
  methodology in this repo, unlike the contrast tests) — `tsc` and the
  existing suites passing here says nothing about whether the new density
  reads right.

---

## 9. Phase 6 — generalizing Phase 5 app-wide (2026-08-07, same session)

User: "keep going... apply consistently across all other screens in the app,
don't limit to just the two screens from Phase 5." This is the actual
app-wide sweep — 43 files touched, `tsc --noEmit` clean and 1,083 tests green
throughout (checked after every batch, not just at the end).

**The real divider scope was bigger than Phase 5's audit found.** Phase 5
only grepped for the `theme.colors.divider` token and concluded dividers were
basically a non-issue outside `SettingsScreen`. That grep missed two other
patterns entirely: bare `<Divider>` from `react-native-paper` (found in 11
files, ~50 individual call sites — `NotificationSettingsScreen` alone had 16,
`GroupInfoScreen` had 7) and ad-hoc `View`s with `borderBottomWidth` used as
row separators (another ~10 files). Correcting course rather than
under-reporting it: the true count is **~40 real list-item dividers across
~20 files**, not "one edit."

**Fix: a themed `Divider` wrapper** (`src/components/ui/Divider.tsx`), same
"one primitive" lever as `GlassCard` — rather than hand-editing ~50 call
sites, it wraps `react-native-paper`'s `Divider` and renders `null` when
`surfaceStyle === 'flat'`. Every file importing bare `Divider` from
`'react-native-paper'` was switched to import it from `@/components/ui`
instead (11 files: `DeviceRetirementScreen`, `LinkedDevicesScreen`,
`NotificationSettingsScreen`, `ExpenseDetailsScreen`, `BackupSettingsScreen`,
`MessageInfoScreen`, `GroupInfoScreen`, `FriendInfoScreen`,
`ReceiptScannerSheet`, `DeviceSetupChoice`, `BackupInsightCards`). Two DOM
tests (`expenseDetailsFallback.test.tsx`, `groupInfoFallbackRecovery.test.tsx`,
plus `groupLoadingFallback.test.tsx` pre-emptively) hand-mock `@/components/ui`
and needed `Divider: () => <div />` added to their mock object — a real
`vi.mock` gap this change exposed, not a design flaw.

The ~10 ad-hoc `borderBottomWidth` sites (`CallInfoScreen`'s detail rows,
`ChatMediaGalleryScreen`'s info panel, `SearchScreen`'s recents list,
`AiChatScreen`/`InsightChatOverlay`'s history rows, `GlassPickerSheet`'s
options, `DisplayCurrencySheet`/`CurrencyConvertSheet`'s currency rows, and
three Chat floating menus — `HeaderMenu`, `MessageActionSheet`,
`MentionAutocomplete`) can't route through a shared primitive (they're plain
`View`s, not a paper component) — each was individually gated on
`theme?.surfaceStyle === 'flat'` inline. **Deliberately NOT touched:** the
`headerRow` `borderBottomWidth` in `LockedChatsScreen`/`StarredMessagesScreen`/
`ArchivedChatsScreen`/`ArchivedGroupsScreen` — that's a sticky header
separating itself from the scrolling list below, not a divider *between list
items*, so it's out of scope for this specific instruction. Also not touched:
`BillSplit/*` (`ParticipantList`, `BillSplitScreen`, `AdvancedModeContent`) —
CLAUDE.md's dense-editor DNA override locks those to opaque/solid by a
separate, earlier user mandate; this pass doesn't touch it. Also not touched:
crop-tool guide lines, input underlines, tab-bar/menu structural borders —
none of those are list separators.

**Compactness — leverage-first, not file-by-file.** Tightened the shared
row components first since they're reused everywhere (`ChatThreadRow`:
`marginBottom` 12→6 across all 4 style variants, matching
`SwipeableGroupCard`'s Phase-5 numbers). Found `SwipeableExpenseCard.tsx` and
`SettlementCard.tsx` were **already** "ultra-compact" from an earlier,
undocumented pass (`padding: 10`, `marginBottom: 1-4`) — left untouched, no
regression to a looser number. Found `src/components/ExpenseCard.tsx` (the
non-swipeable variant) is dead code, imported nowhere — skipped rather than
polishing something unreachable. `CallHistoryScreen` was already denser than
this session's new baseline (`marginBottom: 2`) — also left alone. Then
tightened container-level `gap`/`marginBottom` on every remaining screen with
a `GlassCard`/`GlassView` (main tabs: `FriendsScreen`, `PersonalStatsScreen`;
secondary: `ExpenseDetailsScreen` *(spacing left alone — see below)*,
`SettlementsScreen`, `GroupStatsScreen`, `FriendInfoScreen`, `CallInfoScreen`,
`MessageInfoScreen`, `GroupInfoScreen`; settings: `AiIndexScreen`,
`AiMemoryScreen`, `AiEvalsScreen`, `BackupPassphraseScreen`,
`BackupSettingsScreen`, `DeviceRetirementScreen`, `NearbyMeshScreen`,
`NotificationSettingsScreen`, `OfflineSyncScreen`). Pattern: container
`gap: 12` or `16` → `8`; `card.padding: 16` → `12`; row `marginBottom` in the
16–24 range → roughly half. Single-form screens (`EditNameScreen`,
`LinkDeviceScreen`, one settlement-entry card in `SettlementsScreen`) were
deliberately left at their original padding — that's form breathing room, not
list density, and tightening it would fight the form's own legibility for no
list-density benefit. `LinkedDevicesScreen` needed no spacing change: its
device list is a single card with `Divider`-separated rows, so the divider
fix alone tightened it.

**`ExpenseDetailsScreen` is the one screen using `theme.spacing.*` tokens
instead of raw numbers** (`spacing.lg`/`.md`/`.sm`/`.xs` throughout) — every
other screen in this pass used literal pixel values, which is what made the
"hand-pick a smaller literal" technique consistent across ~20 files. Doing
the same to this one file would mean either inventing a `flatSpacing` scale
(mirrors `flatRadius`, but is real, unscoped, unverified new infrastructure
for a single call site) or hardcoding literals into an otherwise
token-disciplined file (worse hygiene than leaving it alone). Left untouched
this session — a real `flatSpacing` token is the correct fix if/when more
screens move onto the token system, not a one-off.

**Glass-accent: two more containers**, both found by the same test Phase 5
used — is there an existing container that already plays the "hero summary"
role. `FriendInfoScreen`'s `heroCard` (avatar/name/actions — literally named
"hero" in a pre-existing comment) and its `Balance` section directly mirror
`GroupDetailsScreen`'s header+balance and `DebtsList`, so both got
`role="glass"`. **`GroupInfoScreen` was checked and skipped** — its
group-photo/name header was never wrapped in a `GlassView` to begin with (the
identity block renders bare), so there's no existing container to convert;
wrapping bare content in a brand-new glass container would be inventing UI,
not applying an existing pattern consistently. **`ChatRoomScreen`'s header
pills, balance pill, and composer were checked and left as `role="floating"`**
— they're already correctly classified per Phase 2's audit (opaque chrome
over a scrolling message list), and upgrading them to `role="glass"` would
mean real blur material on VERY frequently re-rendered chrome during active
scrolling/typing, a performance/complexity tradeoff this pass didn't have the
verification budget to sign off on. `role="glass"` stayed at 4 containers
total app-wide (2 from Phase 5, 2 from Phase 6) — deliberately, per the
user's own "don't put Liquid Glass on every element" instruction.

**Explicitly still not covered** (a genuine "app-wide" claim would need
these, and none of them were touched):
- `AddExpenseScreen`/`BillSplit/*` — out of scope by the dense-editor DNA
  override, not an oversight.
- Auth screens (`SignInScreen`, `RegisterScreen`, etc.), onboarding, call
  session/live-call UI, chat message bubbles themselves (decision (5), out of
  scope from Phase 5 onward), and the native search tab (doc 20, system
  material, not this primitive).
- No `flatSpacing` token — see the `ExpenseDetailsScreen` note above. Every
  compactness number in Phases 5–6 is a literal, independently hand-picked
  per file/style-block, not driven by a shared scale. Two files styled
  identically could plausibly have picked slightly different deltas.
- Same visual-verification gap as Phase 5: nothing in Phase 6 has been seen
  on a screen either. The scope grew considerably (43 files); the risk that
  something reads wrong in practice grew with it.

---

## 10. Phase 7 — tap/press-state colors (2026-08-07, same session)

User report: "grey tap feedback... was designed for the card-based UI and
looks wrong now." Went looking for it rather than tuning components blind,
and found a real, one-line-fix bug rather than 800 call sites to touch.

**Root cause.** `src/theme/buildTheme.ts` never overrode MD3's `onSurface`/
`onSurfaceVariant` color tokens — react-native-paper's `TouchableRipple`
(`TouchableRipple/utils.ts`, `getRippleColor`/`getUnderlayColor`) computes its
press-state color as `color(theme.colors.onSurface).alpha(0.12)`, and with no
override that fell through to MD3's STOCK Material-You palette
(`rgba(28,27,31,1)` light / `rgba(230,225,229,1)` dark — both carry a purple
hue bias baked into Material 3's default neutral tones), never this app's own
`neutral.text`/`neutral.muted`. Worse on iOS specifically:
`TouchableRipple.supported` checks `Platform.OS === 'android'`, so iOS never
gets the native ripple at all — it falls back to an absolute-fill `View`
painted with that same color, i.e. a full-row purple-tinted grey wash on
every tap, on a design system with zero purple anywhere else in its palette.
That's what read as "wrong against the flat/glass UI."

**Fix:** two lines in `buildTheme.ts` — `onSurface: neutral.text`,
`onSurfaceVariant: neutral.muted`. Every `TouchableRipple` (~90 call sites)
and every `List.Item` (which wraps one internally — confirmed by reading
`ListItem.tsx`: its `Props` type extends `TouchableRipple`'s) picks this up
automatically. No per-component sweep needed for the *color-mismatch* half of
the bug — this is the same "one primitive" shape as the `GlassCard`/
`Divider` fixes, just one level lower (a theme token feeding a *third-party*
component's internal default, not one of this app's own primitives).

**On top of the root-cause fix, explicit tuning on the named surfaces**
(per the request: "tuning underlayColor... SwipeableGroupCard, ChatThreadRow,
expense rows, settings rows"). Rather than leaving these on Paper's now
correctly-hued-but-still-generic 12%-alpha default, they now pass
`rippleColor`/`underlayColor` explicitly using `theme.colors.pressed` — the
semantic token this app already had sitting unused for exactly this purpose
("neutral interactive/divider fill", added earlier in the flat-mode work but
never wired to anything). Touched: `src/components/ui/ListRow.tsx` (the
shared primitive `SettingsScreen` and other info screens use instead of
per-screen `List.Item` — fixes every settings row in one place),
`SwipeableGroupCard.tsx`, `ChatThreadRow.tsx` (its `List.Item`),
`SwipeableExpenseCard.tsx`, `SettlementCard.tsx`, `FriendsScreen.tsx`'s row,
`CallHistoryScreen.tsx`'s row.

**Checked and deliberately left alone:**
- `MessageBubble.tsx`'s one `android_ripple={undefined}` — already correct,
  a deliberate opt-out (a system ripple over a bubble shape would look
  wrong; consistent with chat bubbles being out of scope since Phase 1's
  decision (5)).
- `DebtsList`'s swipeable debt rows use `TouchableOpacity` (activeOpacity
  dimming), not `TouchableRipple` — a different mechanism, not the reported
  "grey overlay" bug, so not touched.
- The other 650+ `TouchableOpacity` and 78 `Pressable` call sites app-wide —
  `TouchableOpacity` has no ripple/underlay concept at all (only
  `activeOpacity`, which dims the child, not an overlay tint), so it was
  never a candidate for this specific bug. Not audited for consistency of
  `activeOpacity` values themselves — a different, smaller-stakes ask than
  what was reported.

**Verification:** `tsc --noEmit` clean, full suite green (590 unit + 466
services + 27 dom = 1,083), no failures and no bugs surfaced by the change —
reported as found, not invented, per the instruction to fix anything broken
"along the way." **Not visually verified** — same gap as Phases 5–6; nobody
has watched a real tap on a real screen since this landed.

---

## 11. Phase 8 — final divider audit, "no exceptions" (2026-08-07, same session)

User, after seeing the app-wide sweep and shipping two builds: "there should
be zero dividers anywhere in the app, no exceptions... grep for any remaining
Divider usage, borderBottomWidth separators, or any visual line separators
that might still be rendering." A genuine re-audit, not a rubber stamp —
Phase 6's own sweep (§9) had already found real gaps in Phase 5's original
divider audit, so the expectation going in was that another pass would find
more, and it did: **16 more sites across 12 files**, none of which route
through `@/components/ui/Divider` and so were invisible to a plain "grep for
Divider" check.

**What the fresh grep covered that earlier passes didn't:**
- `ItemSeparatorComponent` (the FlatList/SectionList divider prop) — never
  grepped for in Phases 6–7. Found one live site:
  `FailedItemsSheet.tsx` (an unconditional hairline between failed-upload
  rows). Fixed by making the prop itself `undefined` in flat mode rather than
  conditioning the rendered View — cheaper, and avoids rendering a
  zero-height separator component per row for no reason.
- `borderTopWidth` app-wide — Phases 6–7's sweep was `borderBottomWidth`-
  only; a divider built as the NEXT item's top border is functionally
  identical and was completely unaudited until now. Found real, live,
  unconditional dividers in `RecurringBillsScreen.tsx` (2: a bill card's
  action-row separator, a sheet footer), `MoneyInChatSheet.tsx` (7: six
  `switchRow` settings toggles + a footer), `NearbyMessagingSheet.tsx` (a
  delivery-note callout — `fallbackNote` shares the same style but is dead
  code, never rendered, left alone), `ChatMediaGalleryScreen.tsx` (a
  multi-select action bar), `ReceiptScannerSheet.tsx` (2: an advanced-split
  panel, a bottom actions bar), `DisplayCurrencySheet.tsx` (a rate-info
  panel).
- **A real, pre-existing bug independent of this session's work:**
  `PrivacyGuardSheet.tsx`'s `Row` component already computed
  `const flat = theme?.surfaceStyle === 'flat'` and used it for
  `styles.rowFlat` padding — but the row's OWN divider right below that,
  `!last && {borderBottomColor...}`, never checked `!flat` too. The
  surrounding comment even documented this as deliberate: "Rows keep their
  own dividers, which is what carries the grouping" — a real design decision
  from the original Phase 3 build, now explicitly overridden by the user's
  "no exceptions." Three more unguarded dividers in the same file
  (`scopeHeader`, `scopeRow`, `previewChatRow`) followed the same pattern.

**Judgment call, resolved toward "no exceptions" rather than my own earlier
narrower reading.** Phases 6–7 drew a line between dividers *between list
items* (fixed) and structural chrome separators — a sticky header's edge
against scrolling content below it, a card's action row separated from its
own content above, a sheet's fixed footer separated from its scrollable body
(left alone, reasoned as a "different UI pattern" in §9). Given this
session's explicit, repeated "no exceptions," that distinction is no longer
being applied — Phase 8 removed ALL of these too, including the sticky-
header separators in `LockedChatsScreen`/`StarredMessagesScreen`/
`ArchivedChatsScreen`/`ArchivedGroupsScreen` and the currency-picker dropdown
divider in `GroupListScreen`'s create-group dialog that §9 had explicitly
deferred as "minor, leave for now." If a future session wants the structural
distinction back, this paragraph is the place that changed it and why.

**Deliberately still NOT touched, and why:**
- Full-perimeter `borderWidth` (all four sides) app-wide — a box outline on
  a card/chip/pill/tile, not a one-sided separator LINE between adjacent
  items. Different visual concept; not what "divider" means here. (Grepped
  and manually triaged; the ~70 hits are overwhelmingly BillSplit option
  tiles, chip borders, and card outlines.)
- `src/components/Chat/editor/CropOverlay.tsx`'s rule-of-thirds grid lines
  and `ScanningAnimation.tsx`'s scanner-viewfinder corner brackets — not
  dividers at all, just non-list UI chrome that happens to use
  `border*Width`.
- `BillSplit/*` — still excluded by the CLAUDE.md dense-editor DNA override,
  unchanged by any instruction in this session.

**Verification:** `tsc --noEmit` clean, full suite green (1,083 tests), same
as every prior phase this session. Still nothing visually verified.
