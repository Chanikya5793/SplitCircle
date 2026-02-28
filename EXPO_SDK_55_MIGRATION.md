# Expo SDK 55 Migration Audit (Tab Bar)

Date: 2026-02-28

## Current Project State

- Project has been upgraded to Expo SDK 55 (`expo@55.0.4`).
- Existing tab bar implementation in `src/components/GlassTabBar.tsx` had no OS split and used a single `BlurView` path for both iOS and Android.
- This file was audited and refactored to support explicit platform-specific tab surfaces.

## What Was Updated

### 1. OS-specific surface abstraction

- Added `src/components/tabbar/TabBarSurface.tsx`.
- iOS path: uses `expo-glass-effect` (`GlassView`) when native glass APIs are available, with automatic fallback to `BlurView`.
- Android path: uses a Material-style elevated surface (no blur dependency in this component path).

### 2. GlassTabBar platform branching

- Updated `src/components/GlassTabBar.tsx`:
  - Uses `TabBarSurface` instead of directly rendering `BlurView`.
  - Adds `Platform.OS` bottom offset tuning (`ios: -18`, `android: +8`).
  - Keeps existing indicator/gesture logic intact.

### 3. SDK package alignment

- Core runtime upgraded:
  - `expo@55.0.4`
  - `react-native@0.83.2`
  - `react@19.2.0`
  - `react-dom@19.2.0`
- Expo modules and RN ecosystem packages aligned to SDK 55-compatible versions.
- Added `expo-glass-effect@55.0.7`.
- Added required `expo-sharing` config plugin in `app.config.ts`.

## Independent SDK 55 Research Findings

The following was validated from official docs/changelogs:

- `expo-glass-effect` is available and designed for iOS liquid glass effects.
- `expo-glass-effect` received SDK 55 patch updates (including tab-navigation related rendering fixes in `55.0.7`).
- Expo SDK 55 introduced `@expo/ui` (alpha) and Expo Router native tabs APIs, but those are not a drop-in replacement for this project’s current React Navigation custom tab bar architecture.
- Android blur behavior in newer Expo docs/changelog has moved toward explicit target-based blur (`BlurTargetView` / `blurTarget`) patterns for best results.

## Migration Decision

For the current branch:

- Keep stable React Navigation custom tab bar architecture.
- Use native iOS glass via capability gate; fallback automatically when unavailable.
- Keep Android on explicit Material surface in the custom tab bar path.
- Keep fallback behavior deterministic so the tab bar remains stable on unsupported iOS builds/simulators.

## Verification Status

1. `npx expo install --check` passes.
2. `npx expo-doctor` passes (React Native Directory warnings for known packages are explicitly excluded in `package.json`).
3. `npx tsc --noEmit` passes.
4. `npx pod-install` completed successfully after removing forced iOS Google Maps pod wiring.

## Recommended Next Steps

1. Run `npx expo run:ios` and verify iOS tab bar behavior on a device/simulator that supports liquid glass APIs and one that does not.
2. Run `npx expo run:android` and validate Android Material fallback tab bar visuals.
3. Keep Android tab bar on Material fallback unless blur-target architecture is explicitly adopted and benchmarked.

## References

- https://expo.dev/changelog/sdk-55
- https://docs.expo.dev/versions/v55.0.0/sdk/glass-effect/
- https://docs.expo.dev/versions/v55.0.0/sdk/router-native-tabs/
- https://docs.expo.dev/versions/v55.0.0/sdk/blur-view/
- https://raw.githubusercontent.com/expo/expo/main/packages/expo-glass-effect/CHANGELOG.md
- https://raw.githubusercontent.com/expo/expo/main/packages/expo-router/CHANGELOG.md
