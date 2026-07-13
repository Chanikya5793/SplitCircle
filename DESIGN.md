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

## Two surface classes

**Ambient surfaces** (lists, home, settings): liquid animated background + glass cards
(GlassCard; native liquid glass on iOS 26+, graceful fallbacks).

**Dense editors** (split options, any form-heavy sheet): SOLID.
- Canvas dark `rgba(13,15,20,0.94)` / light `rgba(250,250,252,0.96)`; cards dark
  `rgba(28,31,38,0.96)` / light `rgba(255,255,255,0.97)` with hairline borders
  (`rgba(255,255,255,0.08)` / `rgba(15,23,42,0.08)`). Blobs whisper through the canvas
  only, never through cards.
- Every vertical pixel works: footers dock in normal flow (header / flex ScrollView /
  footer), zero reserved clearance; pageSheets get ~14px top padding, not 56.
- Row lists live in iOS inset-grouped solid cards with hairline dividers — never naked
  on the canvas. Last row drops its divider.
- Content > chrome: no per-section title banners when a selector already names the
  surface; hints are single quiet lines.
- **The footer earns its place or it's gone.** It is the ONE docked commit: a compact
  bar with the live headline figure + inclusion/validity subline on the left and a
  single, *always-working* CTA on the right — never a dead disabled control. An
  un-landed wheel game shows **Spin** and actually spins (same trigger as the hub);
  karma is applied on its own slider so the footer only ever shows **Done** for it
  (never "Spin"); otherwise it's **Done**, enabled the moment the split is valid with
  the left subline naming what's still needed. The header carries NO Done — exactly one
  commit exists, and it's thumb-reachable. Never a second payer control, method chip,
  or duplicate action.
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
  (Robinhood-stock feel): the content *follows the finger* (`dragX`) and the incoming
  mode *slides in* from the swipe direction (`pageDir`, keyed by method), never a hard
  instant swap. A Pan claims only deliberate horizontal drags (`activeOffsetX ±24`,
  `failOffsetY ±16`) so vertical scroll and in-mode controls keep working; the method
  rail stays fixed as the position indicator. Swipe order == rail order == `METHOD_ORDER`.
- **Include/exclude is a whole-row (or whole-chip) tap, everywhere.** Anywhere a person
  can be in or out of the split — the Add Expense summary chips, income rows, consumption
  rows, game player chips — the entire row/chip toggles it. Excluded rows stay visible
  and dimmed with a "Not splitting" + add cue; the one editable child (a weight/amount
  input) captures its own tap so editing never flips the row.
- **Global roster selector in the editor header.** Beside "Paid by" sits a people-count
  control (`included/total`) that opens a multi-select overlay to include/exclude anyone
  in *any* mode. It stays open across taps (multi-select), leads with Select/Clear
  everyone, and mirrors the per-row toggles — one place to manage who's in.
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
