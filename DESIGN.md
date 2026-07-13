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
- The footer is chrome: one summary line (method · payer), the key figure, a status
  badge, one CTA. Never duplicate controls that exist elsewhere.

## Selection & interaction

- Selectors are single-level; selection state always visible (e.g. MethodRail).
- Horizontal selectors scroll ONLY when the selection is clipped, minimally (28px edge
  peek). Tapping a visible item never shifts the row. Reveal on mount via onLayout retry.
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
