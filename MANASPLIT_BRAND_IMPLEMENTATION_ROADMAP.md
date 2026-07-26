# ManaSplit Muggu Brand Implementation Roadmap

Status: implemented and locally validated; signed-device launch validation pending
Source package: `/Users/chanakya/Downloads/ManaSplit logo`

## Implementation snapshot — 2026-07-26

Completed:

- Preserved the supplied SVG/HTML sources under `assets/brand/source/` with
  SHA-256 checksums.
- Added deterministic generation for Expo, iOS, and Android icon, splash,
  monochrome, favicon, and notification assets.
- Added fixed brand tokens and one canonical geometry/timing module.
- Added static, animated, reversed, simplified, and Reduce Motion-aware React
  Native muggu components.
- Added the native-splash-to-React handoff, branded auth/bootstrap state,
  branded blocking overlay, and glass-shell skeleton presets.
- Wired light, dark, tinted, adaptive, and notification identity configuration.
- Updated checked-in iOS asset catalogs/storyboard and the current generated
  Android resource tree.

Validated:

- Source checksums, 53 required PNG dimensions, opaque iOS icons, palette
  samples, asset-catalog references, Expo config references, and Android
  duplicate-resource checks pass through `npm run validate:brand`.
- TypeScript, 387 pure unit tests, 144 service tests, and 14 DOM component tests
  pass.
- Xcode `actool` compiles the complete iOS asset catalog without warnings.
- Gradle `:app:processDebugResources` completes successfully.
- Default icon and light/dark splash artwork pass direct visual inspection.

Still required before release sign-off:

- A signed preview/TestFlight build and clean-install cold-launch recordings on
  representative iPhone/iPad devices.
- Android launcher mask/themed-icon checks on representative devices.
- Reduce Motion and VoiceOver/TalkBack checks on real hardware.

## Outcome

Replace the current legacy photographic icon/splash treatment with the ManaSplit
muggu system, then reuse the muggu drawing motion for meaningful loading states
without turning every small spinner into a logo.

The finished launch sequence should be:

1. The OS shows a static, appearance-aware launch frame.
2. React Native mounts an identical first frame with no flash or size jump.
3. If startup is still busy after a short grace period, the muggu begins drawing.
4. The branded frame crossfades into the restored app/auth screen as soon as it is
   ready; animation never delays real content.

## Package audit

The package contains:

- `manasplit-muggu-draw.svg`: primary light-background animated mark, including
  traveling pen dots.
- `manasplit-muggu-draw-clean.svg`: primary light-background production loader,
  without traveling pen dots.
- `manasplit-muggu-draw-reversed.svg`: dark-background animated mark using the
  reversed palette.
- `manasplit-muggu-final.html`: the full brand specification, product mockups,
  static variants, construction rules, sizing guidance, and animation timings.

### Brand geometry and rules

- Canvas: `120 x 120`.
- Construction: one petal rotated four times around the center in 90-degree steps.
- Interlace: every petal passes over its clockwise neighbor and under its
  anti-clockwise neighbor.
- Primary mark: one gold petal, three ink petals, ink center, four gold pulli dots.
- Symmetric mark: four same-color petals with a gold center; use for app icons,
  favicons, and patterns.
- Reversed mark: `#F5C15C` and `#E9D5FF` on plum/deep backgrounds.
- Clear space: at least one pulli-dot diameter on every side.
- Full mark minimum: about 28 px. Below that, use the simplified cut: no outer
  dots, heavier 9-unit stroke, tighter weave breaks.
- Never flatten the interlace, color every petal gold, skew the mark, or rotate it
  off its square construction.

### Canonical brand palette

| Token | Value | Intended use |
|---|---:|---|
| Ink | `#3B1259` | Primary structure on light backgrounds |
| Plum | `#2A0B40` | Branded dark background |
| Deep | `#1B0730` | Deeper dark background |
| Gold | `#E8A13D` | Money/share accent |
| Cream | `#FBF7F0` | Branded light background |
| Reversed gold | `#F5C15C` | Gold on plum |
| Reversed ink | `#E9D5FF` | Structure on plum |

These are fixed identity tokens. They must not replace ManaSplit's user-selectable
runtime accent schemes. UI continues to use semantic `useTheme()` colors; the
fixed palette is reserved for identity assets and branded loading moments.

### Animation contract

The supplied motion is a 5.5-second loop:

| Time | Event |
|---:|---|
| 0.00 s | First petal starts at its crown |
| 0.55 s | Crown stroke reaches the center |
| 0.65 s | Short inner stroke closes the first loop |
| 0.78 s | Second petal begins |
| 3.12 s | Fourth petal completes; center starts |
| 3.38 s | Outer dots begin landing clockwise |
| about 4.10 s | Mark is complete |
| about 5.05 s | Hold ends |
| 5.50 s | Fade/reset completes |

The apparent pen speed remains constant through the hidden interlace gap. Preserve
the split path lengths and timing percentages rather than approximating the motion
with a rotating spinner.

## Current app audit

### Native identity

- `assets/icon.png` is a non-square `1125 x 1194` legacy photographic image.
- `assets/adaptive-icon.png`, `assets/splash-icon.png`, and `assets/favicon.png`
  are the same `882 x 913` legacy image.
- The built iOS marketing icon is a separate `1024 x 1024` PNG.
- The iOS splash uses a full `393 x 393` image with `scaleAspectFill` on
  `#101010`.
- Android launcher and splash resources are already generated from the same
  legacy treatment.
- The native iOS and Android directories are hand-maintained, so changing only
  `app.config.ts` will not update the binaries.

### Runtime loading

- Auth readiness renders `src/screens/onboarding/LoadingScreen.tsx`, currently a
  generic Paper `ActivityIndicator`.
- App-wide blocking work renders `src/components/LoadingOverlay.tsx`, also a
  generic `ActivityIndicator`.
- `src/components/SkeletonLoader.tsx` supplies group, expense, chat/call, and
  profile skeletons.
- `src/components/stats/AiNarrativeSkeleton.tsx` supplies the on-device AI
  narrative placeholder.
- Skeletons are correctly gated to cache-empty states in the screens that use
  them, matching the local-first design contract.
- The package does not actually include dedicated skeleton-screen specimens.
  Its rounded cards, cream/plum palette, and loading copy can inform the polish,
  but existing glass-first and cache-first rules remain binding.

## Architecture decisions

### 1. Keep the native launch frame static

iOS and Android own the earliest launch frame. Do not attempt to run the supplied
CSS animation inside the native launch screen. The animation starts only after
React Native has mounted.

Use an appearance-aware static frame:

- Light: cream background with the primary/symmetric light mark.
- Dark: plum background with the reversed mark.

The React boot screen must initially reproduce the same background, mark size,
and alignment exactly. It begins in the completed state. If boot continues beyond
roughly 400-600 ms, it can fade/reset into the full draw loop. This avoids a
blank-to-logo flash and avoids making fast launches wait for animation.

### 2. Rebuild the SVG motion as native components

Embedded SVG `<style>`, CSS keyframes, and CSS `offset-path` are web features and
are not the runtime contract for `react-native-svg`. Implement the geometry once
with `react-native-svg` and drive `strokeDashoffset`, dot scale/opacity, and group
opacity with Reanimated. Both libraries already exist in the app; add no UI or
animation dependency.

Create:

- `MugguMark`: static primary, symmetric, reversed, mono, and simplified variants.
- `MugguLoader`: animated drawing with `variant`, `size`, `showPen`, `loop`,
  `initialState`, and accessibility options.
- `BrandedBootScreen`: the native-to-React handoff and startup copy.
- `InlineMugguLoader`: the simplified 26 px clean treatment.

One canonical geometry module should feed static and animated components so icon,
splash, loader, and in-app marks cannot drift.

### 3. Respect Reduce Motion

When Reduce Motion is enabled, show the completed static mark with a gentle
crossfade at most; do not run stroke drawing, traveling pen dots, scale pops, or
an infinite loop. Subscribe to runtime changes so the behavior updates without
restarting the app.

### 4. Keep branding proportional

- Full-screen boot and app-wide blocking overlays: branded loader.
- Long inline work at 26 px or larger: simplified clean loader.
- Tiny button spinners, media-buffering indicators, map internals, and native
  control progress below 26 px: keep platform indicators.
- Skeleton rows remain skeletons; do not stamp a logo into every placeholder.

### 5. Preserve glass-first and local-first behavior

- Use `GlassCard` for bounded loading overlays.
- Never place a Reanimated opacity animation above native glass. Animate the
  muggu contents, not the glass ancestor.
- Continue cache-first rendering. Skeletons appear only when the cache is empty.
- Existing 12-second route-fallback timeout and honest empty/offline states remain.
- Styling work must not change navigation or data-context APIs.

## Phased implementation

### Phase 0 — Ingest and normalize the source assets

Effort: small

1. Copy the three supplied SVGs and the HTML specification into
   `assets/brand/source/` so the build no longer depends on Downloads.
2. Add a short provenance/readme file recording the original filenames, checksums,
   palette, geometry, and animation timeline.
3. Extract canonical static SVG variants from the HTML: primary, symmetric,
   reversed, mono, and simplified.
4. Generate deterministic PNG deliverables from those vectors rather than editing
   raster files by hand.

Exit gate:

- Source assets are preserved byte-for-byte.
- Generated assets are square, centered, correctly padded, and reproducible.
- The symmetric icon and primary loader are clearly different intentional variants.

### Phase 1 — Add the runtime brand primitives

Effort: medium

1. Add fixed identity tokens under `src/theme/brand.ts`.
2. Add canonical muggu path, circle, dash, and timing constants.
3. Implement `MugguMark` with a single `120 x 120` viewBox.
4. Implement `MugguLoader` with Reanimated animated props.
5. Implement the clean/simplified branch for sizes below 28 px.
6. Add the Reduce Motion hook and static fallback.
7. Export the components through the normal component barrel.

Exit gate:

- All supplied timing milestones match within one animation frame.
- Primary and reversed loaders share geometry and differ only through tokens.
- No JS interval drives per-frame animation.
- Animation cancels cleanly on unmount and does not continue offscreen.

### Phase 2 — Build a seamless startup handoff

Effort: medium

1. Hold the native splash in module scope using `preventAutoHideAsync()`.
2. Render `BrandedBootScreen` as soon as the root view can paint.
3. Start with the completed mark to match the native static frame.
4. Hide/fade the native splash only after the matching React frame has laid out.
5. Start the draw loop only if auth/bootstrap work outlasts the grace period.
6. Crossfade to navigation immediately when auth is ready; never wait for a cycle.
7. Keep the current route-fallback timeout behavior for stale deep links.

Likely files:

- `index.ts`
- `App.tsx`
- `src/navigation/AppNavigator.tsx`
- `src/screens/onboarding/LoadingScreen.tsx`
- new `src/components/brand/BrandedBootScreen.tsx`

Exit gate:

- No black/white flash, logo size jump, or background mismatch.
- Cached/offline auth reaches usable UI as soon as it does today.
- Warm resume does not replay the cold-launch sequence.
- Deep links, notification launches, PushKit/CallKit launches, and App Lock are not
  delayed by decorative motion.

### Phase 3 — Adopt the loader and refine skeletons

Effort: medium

1. Replace the full-screen `LoadingScreen` spinner with the 88-96 px branded loader.
2. Replace `LoadingOverlay`'s spinner with a 40-48 px clean loader inside
   `GlassCard`.
3. Use the 26 px simplified loader only for longer inline operations with space.
4. Keep native indicators for compact buttons and media/map internals.
5. Refactor skeleton presets so the glass/card shell is visible and individual
   avatar/text/amount shapes pulse inside it. Do not paint the entire outer card
   with the skeleton color.
6. Share one subtle pulse phase per skeleton screen to avoid a field of unrelated
   flickers.
7. Preserve truthful screen structure and existing cache-empty gating.

Likely files:

- `src/components/LoadingOverlay.tsx`
- `src/components/SkeletonLoader.tsx`
- `src/components/stats/AiNarrativeSkeleton.tsx`
- current group/chat/call/expense/profile screen call sites only where spacing
  needs correction

Exit gate:

- Skeletons match the real destination layout at common phone widths.
- No fake values or rows are introduced.
- Glass remains visible on iOS 26+.
- Loading messages are concise and use `APP_NAME` for app-name copy.

### Phase 4 — Replace native and distribution identity assets

Effort: medium to large because it requires a native build

1. Generate a `1024 x 1024`, full-square iOS app icon using the symmetric mark on
   plum. Do not pre-round corners.
2. Add dark/tinted appearance variants while keeping the core muggu geometry fixed.
3. Generate Android adaptive foreground, monochrome/themed foreground, background,
   legacy icon, and density resources with correct adaptive-icon safe zones.
4. Generate appearance-aware splash PNGs and update:
   - `app.config.ts`
   - iOS app-icon, splash-logo, and splash-background asset catalogs
   - `SplashScreen.storyboard` sizing/content mode if still required
   - Android drawable/mipmap/color resources
5. Generate the simplified favicon from the 16 px cut, not the full dotted mark.
6. Update notification accent/icon resources where Android uses them.
7. Keep source config and checked-in native resources synchronized because this
   repository does not rely on prebuild regeneration.

Exit gate:

- iOS icon is exactly square, fills the canvas, and has valid appearance variants.
- Android adaptive icon survives circle, squircle, rounded-square, and themed masks.
- Splash imagery is centered, contained, and appearance-aware.
- App Store/TestFlight, Settings, Spotlight, notification, home-screen, and widget
  contexts all show a recognizable mark.

### Phase 5 — Product-language follow-through

Effort: optional follow-up, separate from launch correctness

Use the logo package as inspiration without replacing the established UI system:

- Empty-state pattern at very low contrast.
- Muggu mark in about/profile surfaces.
- Selective gold money accents through semantic tokens.
- Widget/shortcut brand labels migrated from visible “SplitCircle” copy to
  `ManaSplit` where appropriate.
- Onboarding lockup using the horizontal or stacked treatment.

Do not fold a global UI recolor into the launch/logo patch. It would mix brand asset
correctness with a larger design-system migration and make regressions harder to
isolate.

## Validation plan

### Automated asset checks

- Verify every iOS marketing icon is `1024 x 1024`.
- Verify required opaque/default and appearance-specific icon properties.
- Verify splash PNGs are square, transparent where expected, and contain no
  accidental crop.
- Verify the same canonical geometry/checksum feeds app icon, splash, and runtime.
- Verify Android density outputs and adaptive/monochrome resource references exist.
- Verify no checked-in file still points at the legacy photographic image.

### Component and behavior tests

- Static snapshot/structure tests for each `MugguMark` variant.
- Timeline tests at 0.00, 0.55, 0.65, 0.78, 3.12, 3.38, 4.10, 5.05, and 5.50 s.
- Reduced Motion renders a completed, non-looping mark.
- Unmount cancels animation.
- Boot readiness wins immediately over animation.
- Loading timeout still swaps to the existing honest unavailable/offline state.
- Loader messages expose a progress/busy accessibility role and one readable label;
  decorative SVG children are hidden from the accessibility tree.

### Static code gates

```bash
npx tsc --noEmit
npm run validate:brand
npm run test:unit
npm run test:services
npm run test:dom
```

If the full repository typecheck is blocked by the known unrelated `ai_layer`
test-library errors, run the documented app-only temporary tsconfig check and record
both results.

### Visual matrix

Validate at minimum:

| Dimension | Cases |
|---|---|
| Platform | iOS 26/27 target, current supported Android API |
| Appearance | Light, dark, iOS tinted/clear icon, Android themed icon |
| Device | Small phone, current Pro phone, iPad, Android circle/squircle masks |
| State | Signed out, signed in cached, cold offline, slow auth, stale deep link |
| Entry | Home icon, notification, deep link, VoIP/CallKit path, warm resume |
| Accessibility | Reduce Motion on/off, VoiceOver/TalkBack, larger text |
| Performance | Fast boot, deliberately delayed boot, repeated loader mount/unmount |

### Native launch validation

Do not sign off from Expo Go or a development build. Expo documents that those
surfaces do not faithfully reproduce the standalone splash.

Because identity assets are native changes:

1. Validate runtime components in the simulator during JS development.
2. Produce the project-approved native build with `npm run ship:ios` or the
   corresponding EAS build path; do not run the banned local simulator Release build.
3. Test a clean install and several cold launches from TestFlight/preview.
4. Capture launch at high frame rate and inspect frame-by-frame for flashes, jumps,
   stale cached splash imagery, or a mismatch at the native-to-React handoff.
5. Confirm App Store Connect accepts the icon assets and the app displays the new
   icon after processing.

### Performance and stability

- Compare time-to-first-interactive before and after; branding must add no intentional
  wait.
- Confirm 60/120 Hz animation remains smooth with Hermes and New Architecture.
- Confirm no infinite animation remains mounted behind the app.
- Confirm memory/CPU settle after navigation becomes ready.
- Confirm the startup path remains safe when optional native glass modules are absent.

## Rollout and rollback

Split delivery into two commits/build-risk groups:

1. Runtime brand components, boot handoff, loader/skeleton adoption.
2. Native icon/splash/Android resources.

This keeps the JS behavior independently reviewable and makes the native identity
swap easy to isolate. Retain the previous native assets for one release branch or
tag so rollback is a resource/config revert rather than a startup-logic rollback.

## Research basis

- Apple Human Interface Guidelines: launch instantly, keep the native launch screen
  close to the first app frame, and avoid treating it as a promotional splash.
- Expo SDK 55 splash API: native splash is static, can be manually held/hidden, and
  supports a fade; production/preview builds are required for faithful validation.
- Expo asset guidance: splash input is PNG; iOS icons must be square and fill the
  canvas; Android adaptive icons need separate foreground/background and can provide
  a monochrome layer.
- React Native AccessibilityInfo: query and subscribe to Reduce Motion.

References:

- https://developer.apple.com/design/human-interface-guidelines/launching/
- https://developer.apple.com/design/human-interface-guidelines/app-icons/
- https://docs.expo.dev/versions/v55.0.0/sdk/splash-screen/
- https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/
- https://reactnative.dev/docs/accessibilityinfo
