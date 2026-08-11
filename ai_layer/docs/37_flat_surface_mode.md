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
(2026-08-07) — "zero dividers anywhere"; see §11, and note it was REVERSED
the same day and never shipped.** **Phase 9 (2026-08-07, current) — dividers
RESTORED and properly implemented for the first time, group rows compacted
3 lines → 2, press feedback rebuilt per-platform from Paper's actual source.
See §12, and §12.4 before touching dividers again.**

**VISUALLY VERIFIED 2026-08-09 — see §13. iOS screen coverage is complete**
except `InsightChatOverlay` (needs a device — §13.4). Flat mode was swept on the
iOS 27 simulator across Settings, Expenses, Group Detail, Chats, Calls, Add
Expense, Group Stats, BillSplit, the AI assistant, a bottom sheet and a picker
sheet, in both dark and light. Borderless, `role="floating"` and `role="glass"`
all render as designed — **`role="floating"` held on every surface, zero
misses** — the contrast fixes are legible, `BillSplitScreen` visibly matches its
dense-editor contract, and the mandatory AI engine disclosure is present.
**Two findings:** a status-bar collision on scrolled group detail (§13.3), and
**Material purple leaking through the accent system** (§14, fixed in `7da394f`)
— chips and group avatars had been rendering Material lavender under all six
accents for the app's entire life, in glass mode as well as flat.

**ANDROID VERIFIED 2026-08-09 on a Pixel 7 — see §15.** Flat mode works there,
including `role="glass"`'s Android fallback. It also turned up a third finding
the eye could not catch: **the group action dock is invisible to screen
readers** — root-caused to a zero-height absolutely-positioned parent, **still
OPEN** (§15.2; `fe21654` was a wrong fix, kept because it is independently
correct). `InsightChatOverlay` is the one screen still unseen and can only ever
be checked on a physical iPhone — it does not exist on Android at all (§13.4).

> Every "not visually verified" note in §7/§8/§11/§12 predates that sweep and
> was written on the premise that no simulator runtime existed on this machine.
> **That premise is false** — the runtime is back. Read §13 before repeating it.

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
type SurfaceRole = 'section' | 'floating' | 'glass';  // 'glass' added in Phase 5, §8
```

- **`'section'`** (default) — a content card. Goes fully borderless when flat.
- **`'floating'`** — keeps an opaque fill + hairline when flat.
- **`'glass'`** — added later (§8): a deliberate glass ACCENT that ignores
  `surfaceStyle` entirely and always renders the real material. For the small
  named set of hero containers. Not part of the original two-way split.

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
> ~~Not changed: `moneyNeutral` is still `#64748B`.~~ **Superseded the next day**
> — `moneyNeutral`, `moneyPositive`, `moneyNegative`, `success`, `warning`,
> `danger` and the accent `primary` were ALL found to fail AA in light mode and
> were all darkened (`9a3a85b`→`e501046`). `moneyPositive` was the worst at
> 3.64:1 on the DEFAULT background — it had never passed anywhere, glass or
> flat. See §7.

> Caveat, stated honestly: these numbers model the blur tier as a flat tint
> composite. Real iOS 26 `UIGlassEffect` also blurs and applies adaptive
> vibrancy, so true glass contrast is better than the "Glass tint" row. The
> borderless rows involve no material and are exact.

---

## 3. Architecture

Mirrors how `mode` and `accent` already work — no new pattern.

```
tokens.ts            SurfaceStyle = 'glass' | 'flat'  +  flatRadius scale
surfaceRole.ts       SurfaceRole  = 'section' | 'floating' (+ 'glass', §8)
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

**[SUPERSEDED 2026-08-09 — see §13; this was verified on a simulator.]**
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
- **[SUPERSEDED — see §13. The runtime is back and this was verified.]**
  **Not visually verified anywhere.** No simulator runtime is currently
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
"along the way." **Not visually verified** *(superseded — see §13)* — same gap as Phases 5–6; nobody
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

> **REVERSED THE SAME DAY. Do not re-apply §11 (or the divider half of §9).**
> See §12. Phase 8 shipped nothing; it was undone before any build reached a
> device. This section is kept only so the next person understands what the
> code used to do and why it is gone.

---

## 12. Phase 9 — dividers RESTORED, rows compacted, press states rebuilt (2026-08-07)

The user saw the result on a screen and reversed the direction: **"there are
no dividers whatsoever" was a complaint, not the goal.** This phase undoes all
divider suppression, adds dividers where the flat UI genuinely lacked them,
compacts the list rows further, and rebuilds press feedback from the actual
root cause. Phases 5–8 were never shipped — the `ship:ios` run carrying them
was aborted mid-dependency-install.

### 12.1 Dividers restored, then actually implemented

Every suppression point from §9 and §11 is gone — ~56 sites across 32 files.
`Divider.tsx` no longer returns `null` in flat mode. The wrapper itself was
KEPT rather than reverting 11 files back to bare `react-native-paper`
imports: it is now the one place that colors dividers from
`theme.colors.divider` (the app's own token) instead of Paper's MD3 default,
which is derived from a stock Material-You palette this app doesn't use.
A reverted-suppression comment sits at the top of that file so this doesn't
get re-litigated a third time.

**But restoring suppression was only half the ask.** The main lists — groups,
expenses, chats — never had dividers *at all*; they were spaced cards, and
flat mode removed the card without putting anything in its place, which is
exactly what "no dividers whatsoever" was describing. So they now get real
ones, via a new `ListSeparator` (`src/components/ui/ListSeparator.tsx`):

- **glass** → renders nothing. Each row is a floating card with a gap; a
  hairline in that gap reads as a stray line, not structure.
- **flat** → renders an inset hairline. The rows butt together, so the line
  IS the structure, same as a native iOS grouped list.

Rows collapse their bottom margin in flat mode (`containerGlass` /
`rightActionGlass` in `SwipeableGroupCard`) so the separator sits *between*
rows rather than floating inside a row's own margin. `GroupListScreen` hangs
it off `ItemSeparatorComponent`; the expense/settlement/chat lists render
through `.map()` or several different parent screens, so those rows draw
their own bottom hairline instead — noted at each site.

### 12.2 Press states: the real root cause, found by reading Paper's source

§10 fixed the press *color* (Paper was deriving it from MD3's stock
purple-tinted `onSurface`, since this app never overrode that token). That
was real, and it stays. But the user reported the result still "not perfect
at all", so this pass went to `TouchableRipple`'s implementation instead of
guessing at colors again. `TouchableRipple.supported` is
`Platform.OS === 'android' && Version >= ANDROID_VERSION_LOLLIPOP` — **iOS
never gets a ripple**. It takes a fallback branch that paints a plain `View`:

```js
underlay: { ...StyleSheet.absoluteFillObject, zIndex: 2 }
```

Three independent defects, which compound:

1. `zIndex: 2` puts the tint **on top of** the row's own content — over the
   title, avatar and amount, not behind them.
2. No `borderRadius`, so on a rounded row (group cards 24pt, chat rows 16pt)
   it paints **square corners** over a rounded surface. Only rows whose
   parent happened to clip (`overflow: 'hidden'`) hid it — which is why it
   looked fine in some places and wrong in others.
3. It is binary: appears and vanishes with no fade, while the cards
   underneath are running a smooth 110ms scale via `usePressScale`.

No choice of grey fixes any of that. New `usePressFeedback`
(`src/hooks/usePressFeedback.ts`) settles it per-platform, once:

- **iOS** — no painted overlay at all (`rippleColor`/`underlayColor` →
  `'transparent'`). The scale IS the feedback: the platform idiom, and
  something this app already did on its group/expense/call cards.
- **Android** — a real ripple, the platform idiom there, in the app's own
  `pressed` token.

Applied to every row a user actually taps: `ListRow` (all settings/info
rows), `SwipeableGroupCard`, `ChatThreadRow`, `SwipeableExpenseCard`,
`SettlementCard`, `FriendsScreen`, `CallHistoryScreen`. Rows that had no
press feedback at all on iOS (`ListRow`, `ChatThreadRow`, `SettlementCard`)
gained the scale, so they now respond to touch where before they did nothing
but flash a grey box.

### 12.3 Group rows compacted (three lines → two)

The row spent a full line of height on a right-aligned `Total spent ₹X`
under the name/members line. The amount now sits at the END of the meta row
where a list amount belongs, the `Total spent ` label is dropped (the
currency beside it already says what it is), the avatar goes 48 → 40, and
`IconButton` (which carries 48pt of its own touch padding) is replaced with a
plain `Icon`. Net: one line shorter and visibly tighter per row, which is
what "they are so wide and taking more space" was about.

### 12.4 Standing rule, so this stops flip-flopping

**Dividers are part of this app's design. Flat mode means no card fills — it
does NOT mean no separators.** The two surface styles differ in what
separates rows (glass: a gap between floating cards; flat: a hairline), not
in whether rows are separated at all. Anyone reading §9/§11 and thinking
about removing hairlines again should read this line first.

**Verification:** `tsc --noEmit` clean, 1,083 tests green (590 unit + 466
services + 27 dom). **Still not visually verified** *(superseded — see §13,
which verified this phase's dividers, compacted rows and press states on a
real screen)* — the sim runtime is
gone from this machine, so as with every phase in this session, the pixel
values and the press behavior are reasoned from source, not seen.

---

## 13. Visual verification — actually seen on a screen (2026-08-09)

**Every "not visually verified" note above (§7, §8, §11, §12) was written on a
premise that is no longer true, and several are now simply wrong.** They say
some version of *"no simulator runtime is available on this machine (wiped by an
Xcode update), so every number is a reasoned guess."* Checked 2026-08-09:

- `xcrun simctl list runtimes` → **iOS 27.0 (24A5390f) is present.**
- `xcrun simctl list devices` → **ManaSplit-iPhone17Pro**
  (`10CA4824-C3FB-465D-B6B7-AB787036B32E`), bootable.
- The physical **iPhone 17 Pro** also works end-to-end via `devicectl` — Release
  was built, installed and launched on it repeatedly on 2026-08-07 (see
  [[ios-visual-verification-gap]], which has been corrected; it previously
  asserted the opposite and would have kept propagating this).

So the blocker that six phases of pixel decisions were reasoned around had
already lifted. **Read this section before repeating the "cannot verify" claim.**

### 13.1 How

JS-bundle hot-swap onto the already-installed simulator build, per CLAUDE.md's
JS-only path — valid here because the ONLY change under `ios/`, `modules/` or
`package.json` since that build was an `Info.plist` edit for Google sign-in
(`1daaa1d`) plus a JS-side module change (`b500f77`, in the bundle). Everything
visual was current HEAD.

```
APP=$(xcrun simctl get_app_container <sim-udid> com.splitcircle.app app)
npx expo export:embed --entry-file index.ts --platform ios --dev false \
  --bundle-output "$APP/main.jsbundle" --assets-dest "$APP"
xcrun simctl terminate <sim-udid> com.splitcircle.app
xcrun simctl launch  <sim-udid> com.splitcircle.app
```

### 13.2 Confirmed working

**iOS screen coverage is now complete**, in **flat** mode, in both dark and
light: Settings, Expenses (`GroupListScreen`), Group Detail, Chats, Calls,
Add Expense, Group Stats, `BillSplitScreen`, the AI assistant, a bottom sheet
(Filters) and a picker sheet (Category).

**`role="floating"` held on every one — zero misses.** No surface anywhere in
the sweep came up without its background. That was the single likeliest thing to
be wrong after Phase 2's classification (§1.1), and it is now checked on real
screens rather than by grep.

Screen-specific notes from the later passes:

- **Calls** — clean; empty state, chrome keeps its fills.
- **Add Expense** — structurally correct (sectioned, accent-tinted outlined
  inputs at rest, docked Cancel/Save, real "50% match" split suggestion, anomaly
  warning). It is also where the §14 bug surfaced.
- **Group Stats** — fully borderless; outlined timeframe pills, severity-tinted
  insight icons, AI narrative skeleton loading correctly.
- **`BillSplitScreen`** — visibly matches DESIGN.md's dense-editor contract:
  floating glass header pill with the roster selector, single-level MethodRail
  with the selection visible and the deliberate ~28px edge peek on the clipped
  last item, borderless participant rows with inset dividers, and the docked
  footer carrying the live figure (`$40.00/person`, `3 of 3 included`) beside a
  single enabled **Done**.
- **AI assistant** — all four surfaces keep their fills, and **DESIGN.md's
  mandatory AI disclosure is present and correct**: the response carried the
  engine badge ("Exact calculation · How this was answered"), a tappable
  citation row, and 👍/👎. The engine correctly fell through to the
  deterministic tier, since neither Foundation Models nor PCC exists on a
  simulator. The answer itself was accurate.
- **Category picker** — DESIGN.md names this as a former react-native-paper
  `Dialog`/`Menu` violation. It now renders as a proper opaque sheet with a
  grabber and row dividers; that violation is genuinely gone.
- **Observation, not filed as a bug:** the per-person `AVATAR_COLORS` identity
  palette (`#059669`, `#D97706`, `#DC2626`, …) still holds the pre-darkening
  hexes, so white initials on those circles run ~3.2–3.8:1. Fine if two-letter
  initials in a circle are read as a graphical element (3:1), under the line if
  read as text (4.5:1). Left deliberately — these are identity colours, not
  semantic ones — but it is a choice, not an oversight.

- **Borderless renders correctly** everywhere it was applied — content on the
  canvas, grouped by inset hairlines, visibly tighter than glass.
- **`role="floating"` holds.** The Filters sheet came up fully opaque with its
  grabber. This was the likeliest thing to be wrong (§1.1) and the Phase 2
  classification did its job.
- **`role="glass"` reads as intended.** On group detail the balances card and
  "Who owes whom" keep real Liquid Glass while the activity list below is
  borderless — they read as hero containers, not leftover cards. Phase 5's core
  bet is sound.
- **The contrast work is visible and correct in light mode** — the deepened
  `moneyNegative`/`moneyPositive` are clearly legible on the canvas, and the
  accent swatches are visibly deeper from `e501046`.
- **Dividers are present and correctly inset** (Settings/Expenses inset past the
  icon, Chats full-width), consistent with §12.4's standing rule.
- **The group-detail action bar collapses on scroll** into one
  `Settle · Stats · Chat · Bills · Add` row, and the list scrolls clear of it —
  `a0d212a` / `c591433` work.

### 13.3 One real finding: status-bar collision on group detail

Scrolled, the balances-card text runs up into the status bar and collides with
the system glyphs at full opacity — the member name overlapping the clock, and
`-$1,382.14` rendering through the wifi and battery icons. Both become
unreadable. Much more obvious in light mode.

Content passing under the status bar and behind the tab bar is a **deliberate**
decision in this app ([[content-bleed-behind-chrome-is-intended]]), so this is
recorded as an observation, not filed as a layout bug. But two things make this
case unlike the tab bar, and worth a decision rather than an assumption:

- The floating header **pills are fine** — "Multi Device Test" stays perfectly
  legible, because it has glass behind it. It is specifically the status-bar
  strip, which has nothing backing it, that fails.
- CLAUDE.md records that the iOS 26 **scroll-edge effect is deliberately patched
  out** (`patches/react-native+0.83.2.patch`) because it fogged the colorful
  backdrops. That effect is exactly the mechanism that would normally keep the
  status bar legible over scrolling content — so removing it is what turns a
  soft bleed into a hard collision here.

If it should be fixed, the narrow fix is a scrim/glass backing behind the status
bar strip on scrolled screens, NOT re-enabling the patched-out edge effect.

### 13.4 Still unverified

- **`InsightChatOverlay` — the one screen still unseen, and it can ONLY be
  verified on a physical iPhone.** It is the largest glass file in the app (14
  surfaces, all `role="floating"` from Phase 2) and mixes content bubbles with
  chrome, so it is the biggest remaining role-classification risk.

  It renders only when a narrative exists (`GroupStatsScreen.tsx`, `{narrative &&
  …}`), and the narrative tier is documented in that file as **"on-device → PCC
  → nothing"**. Both are iOS-only:
  - **Simulator** — no Foundation Models, no PCC. Narrative never generates.
  - **Android** — same, structurally. Confirmed empirically on a Pixel 7 by
    sweeping the whole of Group Stats: no narrative card, and no AI affordance
    anywhere in the accessibility tree. The overlay never mounts on that
    platform *at all*, so it is not an Android gap to close — it does not exist
    there.

  Do not attribute this to tooling. It is a platform constraint, and the
  physical iPhone (PCC entitlement granted 2026-07-18) is the only way.

---

## 14. Material purple leaking through the accent system (2026-08-09, `7da394f`)

Found while sweeping the last screens for §13. **Not a flat-mode bug** — it had
been wrong in glass mode for the app's entire life, under all six accents.

### 14.1 The mechanism

`buildTheme` opens with `...base.colors` (`MD3LightTheme` / `MD3DarkTheme`), so
**every** Material role is already populated before this app assigns anything.
A role the app does not override does not error, does not fall back to a
neutral, and does not read as missing in review — it silently keeps Material's
stock baseline palette, which is **purple**.

`secondaryContainer` was in exactly that state. Rendering Material lavender
regardless of the selected accent:

- Add Expense participant chips (the "included" state)
- **Group avatar circles** on the Expenses list
- Expense category chips (`ExpenseDetailsScreen`)
- Media-gallery document icons
- Group-info action icons

### 14.2 Why nothing caught it

`tsc`, lint and 603 passing tests were all green with it broken, and they always
would have been — `theme.colors.secondaryContainer` is a perfectly valid
expression that resolves to a real colour. It was found by **looking at the
running app**: the Add Expense chips were visibly lavender next to an Ocean-blue
accent.

This is the same root cause **Phase 7 already hit and fixed** for `onSurface` /
`onSurfaceVariant` (§10, the purple press-state bug). That fix stopped at the
two tokens producing its symptom instead of sweeping the role set, which is why
this survived another 30 commits. *When you find one un-overridden MD3 role,
audit all of them.*

### 14.3 The fix

Defined per accent across all 12 scheme blocks: `secondaryContainer`,
`onSecondaryContainer`, `onSecondary`. Derived as the accent hue at low chroma,
with the on-colour pushed to the **lightest** value that still clears WCAG AA —
searching from the accent outward rather than from black, so it stays hue-tinted
instead of collapsing to pure black/white (the first attempt produced `#000000`
for every accent, which is legible and off-brand).

Plus the neutral roles `surfaceVariant`, `outlineVariant`, `surfaceDisabled`.

Left alone deliberately: `tertiary` (1 use, an archive button that already has a
hardcoded `'#FF9500'` fallback and wants a semantic colour, not an MD3 role) and
`elevation` (1 use, already guarded by `?? theme.colors.surface`).

### 14.4 The guard

`accentContainerContrast.test.ts` (51 tests) asserts **two independent** things,
because they fail independently:

1. **The app actually SETS these roles.** A hardcoded list of Material's stock
   hexes (`#E8DEF8`, `#4A4458`, `#E7E0EC`, `#CAC4D0`, …) fails the test if one
   reappears. This is the check that would have caught the original bug; a pure
   contrast test would NOT have, because Material's purple pair is itself
   perfectly readable.
2. **Every on/container pair clears AA.**

### 14.5 Two process failures worth keeping

**A grep-derived count was wrong by 20×.** The first audit reported 1,153
leaking usages *including* `onSurface`/`onSurfaceVariant` — i.e. the app's
primary and secondary text colours. It sliced the colours block with
`bt.index('spacing,')`, which matched the word in the **import line above it**,
read an empty block, and flagged every token as un-overridden. Real figure: ~49.
Caught only because "your primary text colour is Material purple" contradicted
the screenshot on screen. Same lesson as §4.1: read the code, don't trust the
count.

**A negative control silently tested nothing.** The controls for the new guard
used `sed -i '' "0,/pat/s//repl/"`, which is a **silent no-op on BSD sed** — the
file was never modified, both "controls" passed, and that briefly looked like
evidence the guard worked. A guard test that cannot fail is worse than no test,
because it stops you looking. Verify a control by asserting the mutation landed
(the redo patched via python with an `assert pattern in source`), not by
observing that the suite still runs.

---

## 15. Android verified (2026-08-09) — Pixel 7, Android 17

First look at flat mode on Android, on a physical Pixel 7 (`28181FDH200F7K`,
Android 17 / SDK 37, arm64-v8a) against the 10:42 release APK. Android is fully
drivable (`adb` + `uiautomator dump` gives the real accessibility tree with node
bounds), which is what made §15.2 findable at all.

### 15.1 Flat mode works on Android

Swept Expenses, Group Detail and Group Stats, in flat + dark + sunset accent:

- **Borderless renders correctly** — rows on the canvas with inset hairlines.
- **`role="glass"` degrades correctly.** The two hero containers fall back to
  Android's near-opaque tinted card + `elevation` (BlurView cannot render
  there), and still read as hero containers against the borderless list. The
  Android fallback path was the least-examined branch of `GlassCard` and it
  holds.
- Group Stats is clean end to end — insight rows, Momentum bars, the
  who-pays/who-spends donut, top merchants and the trajectory bar.

Two things carried over from iOS, both expected:

- **Avatar circles are lavender** — the §14 Material-purple leak, confirming it
  was cross-platform (it is a JS theme bug, not a platform one). That APK
  predates the fix; not a regression.
- **Content passes under the status bar** — the Spending Trend chart's data
  point bleeds into the status area when scrolled. Same class as §13.3, so that
  finding is not iOS-specific either.

### 15.2 Real finding: the group action dock is invisible to screen readers
(**NOT fixed** — `fe21654` was a wrong fix; root cause below)

`Settle Up`, `Add Expense`, `Stats`, `Chat`, `Bills` — **visible on screen and
absent from the accessibility tree.** Screenshot and dump taken at the same
instant, so not a timing artifact. These are the primary actions of the app's
main screen.

Two causes, both fixed across the expanded grid and the compact Android dock
(10 controls):

1. Each button used Paper's **`IconButton` as a decorative icon**. `IconButton`
   is itself interactive and focusable, so nesting it inside `TouchableRipple`
   breaks the accessible grouping (and it carries 48pt of its own touch
   padding). Replaced with the plain `Icon` already imported in that file.
   **§12.3 made exactly this swap for group ROWS, for the same reasons — the
   dock was missed.** Same shape as §14: a fix applied to the instance that
   produced the visible symptom rather than to the pattern.
2. Zero `accessibilityRole`/`accessibilityLabel` in the entire dock block.

What made this readable as a real gap rather than a `uiautomator` quirk: every
other interactive element on the screen dumps a rich composed label
(`"Budget, 8 members, you are owed $714.32"`), because the app does this
deliberately elsewhere. The dock had nothing — and commit `b4f724f` was
literally *"Make rows reachable and named for screen readers"*, so the intent
existed and this surface was skipped.

**`fe21654` did NOT fix it, and the verification is what caught that.** After
pruning archives and rebuilding (7m42s), installing, and re-dumping the tree on
the same screen: all five controls **still absent**. The labels are provably in
the shipped bundle and the source is correct — so the cause was never the
labels.

**Actual root cause — a zero-height absolutely-positioned parent:**

```
<View style={styles.floatingActions}>            // position:'absolute', left/right/bottom, NO height
  <Animated.View style={styles.expandedContainer}>   // ALSO position:'absolute'
```

An absolutely-positioned child contributes nothing to its parent's layout, so
`floatingActions` measures **zero height**. The buttons still draw (Android does
not clip by default) and still receive touches (RN's touch handling walks the JS
tree, not native bounds) — but Android derives accessibility bounds from the
native view hierarchy, so children outside a zero-height parent are
`visible-to-user=false` and are dropped from the tree.

That accounts for all three symptoms at once: **visible, tappable, invisible to
accessibility.** Corroborated in the same dump — `Filters` (normal flow inside
the ScrollView) is present, the native tab bar is present, and only the
absolutely-positioned dock is missing.

**Keep `fe21654` anyway.** The `IconButton` → `Icon` swap is independently
correct (it removes a nested focusable and 48pt of phantom touch padding, per
§12.3), and the labels are required once the bounds are fixed — they are simply
not sufficient on their own.

**The real fix touches load-bearing layout** — `floatingActions` needs real
bounds, but the expanded container is anchored by `bottom:
expandedActionsAnchorBottom` and animated by three recently-tuned commits
(`a0d212a`, `c591433`, `1daaa1d` — action-bar height, list clearance, and the
glass/flat lurch). It should not be changed blind; it needs a deliberate pass
with a device dump after.

**Lesson, and the reason this section reads the way it does:** the first fix
addressed the most *visible* deficiency (no labels — real, and real in the
source) without establishing that it was the *operative* one. Nothing in `tsc`,
the suite, or code review distinguishes those two. Only re-running the exact
check that found the bug did.

### 15.3 Method note

`uiautomator dump` exposes what a screen reader can actually reach, which is a
strictly stronger check than a screenshot — §15.2 is invisible to the eye and
obvious in the tree. **Do accessibility verification on Android first**, even
for an iOS-led feature; iOS has no equivalent one-command tree dump here.
