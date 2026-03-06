# Native Tabs Phase 2 (SDK 55)

Date: 2026-02-28

## What changed

- Migrated from custom floating tab bar to native tabs:
  - `@react-navigation/bottom-tabs/unstable` via `createNativeBottomTabNavigator`
- Reworked navigation architecture so tab-hidden routes are outside tabs:
  - `ROOT` screen hosts tabs
  - detail screens (`GROUP_CHAT`, `CALL_DETAIL`, etc.) live in `AppStack`
- Updated call info deep-linking:
  - `CallInfoScreen` now navigates directly to `GROUP_CHAT`

## Why this architecture

- Native tabs render platform-native UI:
  - iOS: UIKit tab bar behaviors (including iOS 26 minimize behavior support)
  - Android: Material-native tab host behavior
- Moving detail routes out of tab navigator avoids brittle `tabBarStyle: { display: 'none' }` hacks.

## Native icon strategy

- iOS tabs use SF Symbols (`tabBarIcon` with `type: 'sfSymbol'`).
- Android tabs use image sources generated from `MaterialCommunityIcons.getImageSource(...)`.
- If icon generation is delayed or unavailable, fallback image source is used temporarily.

## Files touched

- `src/navigation/stacks.ts`
- `src/navigation/AppNavigator.tsx`
- `src/screens/calls/CallInfoScreen.tsx`

## References

- Expo SDK 55 upgrade post:
  - https://expo.dev/blog/upgrading-to-sdk-55
- Expo Router native tabs docs (API and platform behavior reference):
  - https://docs.expo.dev/versions/v55.0.0/sdk/router-native-tabs/
- React Navigation native bottom tabs docs:
  - https://reactnavigation.org/docs/native-bottom-tab-navigator
- React Navigation bottom tabs docs (v8 notes on native implementation direction):
  - https://reactnavigation.org/docs/bottom-tab-navigator
