# Expo SDK 55 Migration Audit (Tab Bar)

Date: 2026-02-27

## Current Project State

- Project is currently on Expo SDK 54 (`expo@~54.0.32`).
- Existing tab bar implementation in `src/components/GlassTabBar.tsx` had no OS split and used a single `BlurView` path for both iOS and Android.
- This file was audited and refactored to support explicit platform-specific tab surfaces.

## What Was Updated

### 1. OS-specific surface abstraction

- Added `src/components/tabbar/TabBarSurface.tsx`.
- iOS path: uses `BlurView` with iOS material tint and highlight border.
- Android path: uses a Material-style elevated surface (no blur dependency in this component path).

### 2. GlassTabBar platform branching

- Updated `src/components/GlassTabBar.tsx`:
  - Uses `TabBarSurface` instead of directly rendering `BlurView`.
  - Adds `Platform.OS` bottom offset tuning (`ios: -18`, `android: +8`).
  - Keeps existing indicator/gesture logic intact.

## Independent SDK 55 Research Findings

The following was validated from official docs/changelogs:

- `expo-glass-effect` is available and designed for iOS liquid glass effects.
- `expo-glass-effect` received SDK 55 patch updates (including tab-navigation related rendering fixes in `55.0.7`).
- Expo SDK 55 introduced `@expo/ui` (alpha) and Expo Router native tabs APIs, but those are not a drop-in replacement for this project’s current React Navigation custom tab bar architecture.
- Android blur behavior in newer Expo docs/changelog has moved toward explicit target-based blur (`BlurTargetView` / `blurTarget`) patterns for best results.

## Migration Decision

For the current branch:

- Keep stable React Navigation custom tab bar architecture.
- Keep iOS visual glass style.
- Keep Android on explicit Material surface in the custom tab bar path.
- Defer full native iOS liquid glass replacement (`expo-glass-effect`) until the project dependency baseline is upgraded to SDK 55 and validated in this codebase.

## Recommended Next Steps (When Upgrading to SDK 55)

1. Upgrade Expo SDK and align package set (`expo`, `react-native`, `expo-blur`, navigation packages).
2. Add and test `expo-glass-effect` integration in `TabBarSurface` iOS branch.
3. Re-validate against known SDK 55.x patch-level behavior (use at least `expo-glass-effect@55.0.7` equivalent or newer).
4. Keep Android tab bar on Material fallback unless blur-target architecture is explicitly adopted and benchmarked.

## References

- https://expo.dev/changelog/sdk-55
- https://docs.expo.dev/versions/v55.0.0/sdk/glass-effect/
- https://docs.expo.dev/versions/v55.0.0/sdk/router-native-tabs/
- https://docs.expo.dev/versions/v55.0.0/sdk/blur-view/
- https://raw.githubusercontent.com/expo/expo/main/packages/expo-glass-effect/CHANGELOG.md
- https://raw.githubusercontent.com/expo/expo/main/packages/expo-router/CHANGELOG.md
