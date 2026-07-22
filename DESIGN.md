# DESIGN.md — binding UI rules

Current design contract. Rules only — history lives in git.

## Theme & tokens

- One theme source: `src/theme/` (`useTheme()` returns Paper MD3 + semantic tokens).
  **Zero hardcoded hex/rgba in screens** — replace on touch.
- Semantic tokens: `success/warning/danger` families, `moneyPositive/moneyNegative/
  moneyNeutral` (all money coloring goes through these), `appBackground`,
  `glassTint/glassBorder`, `skeleton`, `chart[8]`, `theme.blob.*` (LiquidBackground),
  `spacing.{xs..xxl}`, `radius.{xs..pill}`, `typography.{display..label}`.
- User customization: mode System/Light/Dark + 6 accents (`ocean` default), persisted
  offline in AsyncStorage `appearance_v1`. iOS native chrome syncs via `RNThemeIsDark`.
- UI kit: `src/components/ui/` (GlassCard, ScreenScaffold, AppButton, AppTextInput,
  ListRow, EmptyState, OfflineState, SyncBadge, MoneyText, SectionLabel). Reuse these;
  no new UI libraries; keep react-native-paper.

## One surface class

**EVERY screen/overlay ships GLASS-FIRST** (LiquidBackground canvas + glass cards,
bubbles, chrome) — lists, home, settings, chats, browsing, stats, conversational
surfaces, and `BillSplitScreen` (`src/components/BillSplit/`, the split-method editor
a "Split options" tap opens). There is no solid exception anymore: `BillSplitScreen`
used to ship a deliberate near-opaque "dense editor" treatment (rationale: legibility
at high row density, blobs never competing with dense data) — reverted 2026-07-22 after
user feedback that the split editor read as visibly un-glass next to the rest of the
app; it's ambient like everything else now. Its OTHER dense-editor behavioral rules
(docked footer, zero reserved clearance, page-swipe between modes — see "Dense editors"
below) still apply; only the material changed. Any popup/menu/dialog a screen presents
directly (payer picker, category picker, receipt picker, etc.) MUST be glass. When in
doubt: glass.

**Full-screen overlays are gesture-dismissable.** Anything that covers the screen
(chat overlays, full-screen results) closes on a swipe-down: grabber bar + 1:1 finger
tracking on the drag zone, rubber-band upward, committed fling/distance dismisses —
in addition to an explicit close control. Never a modal the user can only ✕ out of.
ALSO a **left-edge swipe-back** (iOS back-gesture semantics: activate from the left
~28px, track the finger, commit on distance/fling) — overlays behave like pushed
screens, not traps. Grab targets are generous (grabber zone ≥ 20px tall).

**Floating header chrome is GLASS, title included.** Buttons over content are glass
circles; the title/subtitle block is a glass pill (StickyHeaderPill DNA) — text never
floats bare over scrolling content.

**The composer hugs the keyboard.** When the keyboard is up, the safe-area bottom
margin is swapped for a small gap (~6px) — never a dead inset floating the input
above the keys.

**AI disclosure is mandatory.** Any surface that renders model output labels the
engine per message (On-device / Private Cloud Compute / Exact-deterministic badge)
and shows the live engine where a conversation is ongoing. Context injections
(fresh facts into an old thread) are disclosed inline, never silent.

## Liquid glass DNA (binding)

**One primitive.** ALL glass goes through `GlassCard` (`src/components/ui/GlassCard.tsx`);
`GlassView` is a deprecated shim over it. Never hand-roll BlurView + rgba tints for a
surface that should be glass — that's how the Calls tab drifted. Three-tier material,
resolved once at startup:

| Tier | Path | Notes |
|---|---|---|
| iOS 26+ | expo-glass-effect native `GlassView`, `glassEffectStyle="regular"` | REAL liquid glass; carries its own rim highlight — no manual border |
| older iOS | `BlurView` + theme-crossfaded tint/border (`themeProgress` worklet) | tint/border from `NEUTRALS.*.glassTint/glassBorder` |
| Android | near-opaque tinted card + `elevation: 4` | BlurView can't render there |

expo-glass-effect is required DEFENSIVELY (try/catch require) because registering its
native view manager throws at splash on binaries missing the module — keep that guard.

**Self-audit — how a violation hides from review (2026-07-21 incident: a full branch
review scored 45 confirmed bugs and missed EVERY instance of this; only a screenshot
caught it).** A violation reads as "normal-looking dark UI" in code review and even in
a screenshot glanced at quickly — it only reads as wrong next to a real glass surface,
or to someone who knows the rule. Don't eyeball it; grep for the signatures on EVERY
screen, with no exceptions (the BillSplitScreen family was the one exception and it
was reverted 2026-07-22 for exactly this reason — it read as un-glass next to the rest
of the app):
- `backgroundColor:` set to a hardcoded hex (`#1c1c1e`, `#1c1c20`, ...) or an
  `rgba(...)` literal with alpha ⪆ 0.5, on anything that floats/overlays/pops up
  (menu, dialog, dropdown, dropdown-under-header, winner/result reveal) — GlassCard
  replaces this for a bounded card; a full-bleed `BlurView` backdrop for a full-screen
  reveal (see "Dense editors" below).
- A direct `import { BlurView } from 'expo-blur'` OUTSIDE `GlassCard.tsx` itself, UNLESS
  it's a deliberate full-bleed backdrop (a context-menu or celebratory-reveal scrim
  behind bounded glass content, e.g. `MessageActionSheet`, `BillSplitScreen`'s winner
  overlays) — every bounded card should get blur BY WAY OF GlassCard, never call
  BlurView directly for a surface with its own border/radius (that's the exact shape of
  the Calls-tab drift this rule already names, and it recurred in `ScreenScaffold.tsx`'s
  sticky header after the rule was written).
- `react-native-paper`'s `Dialog`, `Menu`, or `Snackbar` used to present a picker,
  action list, or popup. These render Material-style opaque library chrome — they are
  never glass and don't take a `GlassCard`-shaped fix, they need rebuilding as a
  custom sheet/menu the way `BillSplitScreen`'s payer/participant dropdowns are (or,
  simpler, wrapping their content in `GlassCard` and driving visibility yourself
  instead of `Portal`/`visible`). `AddExpenseScreen`'s payer/category/receipt pickers
  were exactly this.
- Before touching any modal/menu/dropdown/sheet: does it call `GlassCard` (or
  `StickyHeaderPill`) somewhere in its own render tree? If not, that's the bug — there
  is no screen left where a solid/hand-rolled surface is the documented answer.
- One narrow, deliberate exception: the roulette/weighted-roulette wheel's center
  **hub** (`RouletteWheel.tsx`/`WeightedRouletteWheel.tsx`, `hubBg`/`hubBorder`) stays
  a small solid circle — it reads as the wheel's physical spin button, not a floating
  panel, and liquid glass over a colorful spinning wheel muddies both. If this ever
  gets revisited, it's a deliberate call, not a miss.

**Native-material kill list.** The iOS 26 material silently drops out (renders as
nothing) when composited under:
- a Reanimated **opacity/layout** animation (`FadeIn/FadeOut/Layout`) anywhere above it
  → either pass `forceBlur` (blur-tier fallback) or, better, animate **transforms only**
  (`pressScaleStyle`, translateY slides are safe — SwipeableGroupCard is the exemplar);
- any ancestor with **fractional opacity** (kills UIVisualEffectView — StickyHeaderPill
  slides in via transform, never opacity).
Prefer restructuring the animation over `forceBlur`; forceBlur rows visibly don't match
native-glass cards on the same screen.

**Ambient composition per tab root:** `LiquidBackground` (animated theme blobs) at the
screen root → GlassCard content cards → `StickyHeaderPill` for the scroll-collapsed
title → floating circular actions are GlassView-filled (GroupListScreen
`glassActionInner`). Small chrome (Edit pills, segmented filters, icon buttons) is glass
too — not hardcoded `rgba(255,255,255,0.12)` boxes.

**Sheet DNA.** Every bottom sheet: `Modal transparent animationType="fade"
statusBarTranslucent` — the fade carries the full-screen scrim (`rgba(0,0,0,0.4–0.45)`)
in/out. The sheet itself is bottom-anchored (overlay `flex-end`, or
`position:absolute; bottom:0`) and slides with a **native-driver translateY** (timing
260–320ms `Easing.out(cubic)` against measured height, or `SlideInDown.springify()` for
gesture sheets), top radius 24–28, grabber bar, `paddingBottom: insets.bottom`. NEVER
`animationType="slide"` — it slides the scrim along with the sheet and stutters.
Sheets that stage a choice get a docked footer: summary/subline left, Cancel + one
always-working primary CTA right; commit work happens on Save, never per-row-tap
(per-tap context writes re-render the whole app behind the modal — that reads as lag).

**Dense editors** (the BillSplitScreen split-method editor family — NOT the ambient
Add Expense screen that opens it; see the note above): glass like everywhere else, but
still governed by these density/behavior rules unique to a high-row-count editor:
- Cards are `GlassCard` (`SolidCard` in `AdvancedModeContent.tsx` is the shared wrapper —
  one edit there covers every mode). Full-screen celebratory reveals (winner overlays)
  use a full-bleed `BlurView` backdrop, not a bounded card — same pattern as
  `MessageActionSheet`'s context-menu backdrop.
- Every vertical pixel works: footers dock in normal flow (header / flex ScrollView /
  footer), zero reserved clearance; pageSheets get ~14px top padding, not 56.
- **Primary actions dock, never scroll away.** A form's commit/cancel (e.g. Add Expense
  Save/Cancel) lives in a docked bar below a flex ScrollView, always in reach — the user
  never scrolls to the bottom of the fields to find Save.
- Row lists live in iOS inset-grouped solid cards with hairline dividers — never naked
  on the canvas. Last row drops its divider.
- Content > chrome: no per-section title banners when a selector already names the
  surface; hints are single quiet lines.
- **The footer earns its place or it's gone.** It is the ONE docked commit: a compact
  bar with the live headline figure + inclusion/validity subline on the left and a
  single, *always-working* CTA on the right — never a dead disabled control. It shows
  **Done**, enabled the moment the split is valid, with the left subline naming what's
  still needed. Roulette is the one game that keeps the footer: its **Spin** drives the
  wheel (same trigger as the hub). The **Double Wheel and Karma HIDE the footer
  entirely** — they spin/apply on their own hardware and commit via the full-screen
  result's "Lock it in", so a docked Spin/Done there is dead weight. The header carries
  NO Done. Never a second payer control, method chip, or duplicate action.
- **Real data only, never placeholders.** Editors start empty (no invented "Pasta /
  Steak" receipt rows, no seeded tax/tip). Empty modes show a purposeful empty state,
  not fake content. New sub-items default to the sensible common case (e.g. a new
  receipt line is shared by everyone currently included).
- **Visible borders.** Inputs, steppers, and outlined buttons carry a real hairline
  (`inputBorder(isDark)` = `rgba(255,255,255,0.16)` / `rgba(15,23,42,0.18)`), not the
  near-invisible `palette.border`. A field the user must tap must look tappable. On
  ambient surfaces (Add Expense), outlined inputs and buttons carry an **accent tint**
  at rest (`theme.colors.primary` at ~44% light / ~52% dark), never a neutral near-black
  outline that reads as hidden.

## Selection & interaction

- Selectors are single-level; selection state always visible (e.g. MethodRail).
- Horizontal selectors scroll ONLY when the selection is clipped, minimally (28px edge
  peek). Tapping a visible item never shifts the row. Reveal on mount via onLayout retry.
- **Swipe between modes.** The whole editor pages between modes on a horizontal swipe
  (Robinhood-stock feel): the content tracks the finger 1:1 (`dragX`); on a committed
  swipe the outgoing mode *flings the rest of the way off-screen*, the mode swaps *in
  place* (no `key`/remount — so it's one continuous motion, no spring-back, and game
  state survives a mis-swipe), and the new mode *slides in* from the opposite edge.
  A Pan claims only deliberate horizontal drags (`activeOffsetX ±24`, `failOffsetY ±16`)
  so vertical scroll and in-mode controls keep working; a rubber-band resists swiping
  past the first/last mode; the method rail stays fixed as the position indicator.
  Swipe order == rail order == `METHOD_ORDER`.
- **Include/exclude is a whole-row (or whole-chip) tap, everywhere.** Anywhere a person
  can be in or out of the split — the Add Expense summary chips, income rows, consumption
  rows, game player chips — the entire row/chip toggles it. Excluded rows stay visible
  and dimmed with a "Not splitting" + add cue; the one editable child (a weight/amount
  input) captures its own tap so editing never flips the row.
- **Global roster selector in the editor header.** Beside "Paid by" sits a people-count
  control (`included/total`) that opens a multi-select overlay to include/exclude anyone
  in *any* mode. It stays open across taps (multi-select), leads with Select/Clear
  everyone, and mirrors the per-row toggles — one place to manage who's in. It is the
  *single* roster control: modes do NOT carry their own player rail (the game modes rely
  on this selector; the wheel already shows who's playing).
- Haptics on every meaningful interaction (selection/medium/heavy/success — `utils/haptics`).
- Press feedback: `usePressScale` squish on cards.
- Mid-flow game/wizard states are guidance (muted), never red errors; red is reserved
  for genuinely broken input.

## Celebration & games

- Payoff moments own the FULL screen (overlay above all chrome incl. footer) — never a
  card that scrolls behind the bottom bar.
- Multi-step game outcomes (including Double Wheel) keep intermediate state on the
  game hardware; the final allocation is a full-screen result with its own bounded
  list and fixed actions. Never substitute a progress bar or an editor-scrolling
  result list for the final outcome.
- A multi-round game (Double Wheel) offers an **Auto** toggle that continues the run
  for the user. Auto does NOT start the game — the user checks it, taps Spin *once*,
  and from then on every remaining round fires on its own until the split is complete
  (gated on at least one landed spin). Drive the loop off a ref so an incidental
  re-render can't cancel the queued spin. Randomness stays crypto-grade
  (`crypto.getRandomValues`) with a long deceleration; a preselected target is never
  revealed before its animation lands.
- A multi-round game shows its **running tally live** during play — each share as it
  lands plus what's left — not only at the end. Progress is never invisible.
- The full-screen result list **fills the space between the header and the actions**
  (`flex: 1`), never a fixed slice that strands rows behind a scroll while the screen
  sits half-empty.
- Never visually reveal a preselected random target before its animation has landed.
- Game hardware is modern iOS, not casino: harmonized muted palette, canvas-colored
  separator strokes, hairline outer ring, accent rounded pointer, solid hubs showing
  live data (pot / % left). No rim dots, no emoji hubs, no gold-on-black. Winner state:
  losers dim to ~28%, winner strokes white.
- No emoji in chrome (footers, buttons, headers). Emoji only where it's content.

## Smart features must be real

Anything labeled smart/suggested derives from actual on-device data
(`splitHistoryService`: per-group, recency-weighted) and improves with use.
No hardcoded placeholder suggestions, ever. No data → zero pixels.

## Offline-first UX (every screen)

1. Cache-first render; skeletons only when cache is empty.
2. Nothing spins forever — timeouts → OfflineState with retry.
3. Optimistic outbox items show SyncBadge; online-only actions disable with a hint.
4. Errors are themed + friendly copy — never raw Firebase strings in Alert.alert.
5. Pull-to-refresh refreshes or doesn't exist.

## Hard don'ts

- No navigation-structure or data-context API changes during styling work.
- Don't break the three-tier storage DNA (CLAUDE.md).
- All in-app brand copy via `APP_NAME` (`constants/appInfo.ts`).
