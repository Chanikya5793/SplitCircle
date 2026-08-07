# 37 — Flat surface mode (borderless UI behind a toggle)

**Status:** Decisions LOCKED 2026-08-06. **Phases 1, 2 and 3 BUILT** (uncommitted
on `ui-revamp`): typecheck clean, 993 tests green. Phase 4 (dividers +
DESIGN.md rewrite) not started.
Nothing device-verified.

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

**Phase 4 — polish.** Dividers where card edges used to do the grouping, and the
DESIGN.md rewrite (§6).

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
