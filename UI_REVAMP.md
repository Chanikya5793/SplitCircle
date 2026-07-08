# SplitCircle UI Revamp — Design System v2 ("Liquid Glass, Offline-First")

> **For AI agents & contributors**: this is the contract for the app-wide UI revamp.
> Read `ARCHITECTURE.md` first — the local-first DNA is unchanged. This doc defines
> the token system, component kit, customization surface, and offline-UX conventions
> every screen must follow.

## Goals

1. **Keep the DNA**: liquid animated backgrounds, glass surfaces, native iOS tabs
   (SF Symbols, iOS 26 accessories), Paper MD3 base, local-first storage, Firebase backend.
2. **Tokenize everything**: no new hardcoded hex/rgba in screens. One theme source.
3. **Customizable**: user-selectable theme mode (System/Light/Dark) + accent palette,
   persisted offline in AsyncStorage — no network required, applies instantly.
4. **Offline-first UX**: every screen renders from local cache, communicates sync
   state honestly, and never spins forever.
5. **Native where it counts**: iOS 26 liquid glass via `expo-glass-effect`,
   UIKit appearance sync via `Settings` (existing `RNThemeIsDark` bridge).

---

## 1. Token layer — `src/theme/`

New module (replaces the 61-line `src/constants/theme.ts`; a compat re-export stays
so old imports don't break during migration).

```
src/theme/
  palette.ts    — accent palettes + neutral ramps (raw colors, no logic)
  tokens.ts     — spacing, radius, typography, elevation, animation durations
  buildTheme.ts — buildTheme(scheme: 'light'|'dark', accent: AccentId): AppTheme
  index.ts      — public exports + AppTheme type
```

### AppTheme shape (what `useTheme().theme` returns)

Extends the Paper MD3 theme so **all existing `theme.colors.*` reads keep working**,
and adds semantic tokens:

```ts
theme.colors.{...all MD3 roles}            // primary now = selected accent
theme.colors.success / onSuccess / successContainer
theme.colors.warning / onWarning / warningContainer
theme.colors.danger  / onDanger  / dangerContainer     // alias of error family
theme.colors.moneyPositive   // "owes you" green
theme.colors.moneyNegative   // "you owe" red
theme.colors.moneyNeutral    // settled/muted
theme.colors.appBackground   // replaces every '#121212'/'#FDFBFB' literal
theme.colors.glassTint / glassBorder / glassFallback   // GlassCard surfaces
theme.colors.skeleton        // skeleton fill matching glass surfaces
theme.colors.chart[8]        // theme-aware chart palette
theme.blob.{settled|balanced|debts}   // LiquidBackground palettes (3 colors each)
theme.spacing.{xs:4, sm:8, md:16, lg:24, xl:32, xxl:48}
theme.radius.{xs:8, sm:12, md:16, lg:20, xl:24, pill:999}
theme.typography.{display, headline, title, subtitle, body, caption, label}
                 // each: fontSize, lineHeight, fontWeight
```

### Accent palettes (`AccentId`)

Six presets; each defines light+dark `primary`, `secondary`, container colors, and a
balanced blob tint. `ocean` is the default and matches today's blue.

| id      | light primary | dark primary |
|---------|--------------|--------------|
| ocean   | `#1F6FEB`    | `#58A6FF`    |
| violet  | `#7C3AED`    | `#A78BFA`    |
| emerald | `#059669`    | `#34D399`    |
| sunset  | `#EA580C`    | `#FB923C`    |
| rose    | `#E11D48`    | `#FB7185`    |
| mono    | `#334155`    | `#CBD5E1`    |

**Rules**
- Screens must not import `colors`/`darkColors` statics (deleted). Use `useTheme()`.
- Money semantics always via `moneyPositive/moneyNegative/moneyNeutral` — never raw greens/reds.
- `#fff`-on-primary → `theme.colors.onPrimary`. Overlay scrims → `theme.colors.backdrop`.

## 2. ThemeContext v2 — `src/context/ThemeContext.tsx`

```ts
{
  theme: AppTheme,
  isDark: boolean,
  mode: 'system' | 'light' | 'dark',   setMode(mode),
  accent: AccentId,                     setAccent(id),
  themeProgress: SharedValue<number>,  // kept — powers animated crossfades
  toggleTheme(),                        // kept for compat (flips mode light/dark)
}
```

- Persisted as one JSON blob `appearance_v1` in AsyncStorage (offline-native).
  Legacy `theme_preference` is migrated on first load.
- `mode: 'system'` (default) follows `Appearance.addChangeListener` live.
- iOS: keeps `Settings.set({ RNThemeIsDark })` so the native UITabBarController matches.
- Hydration happens before first paint of the app UI (gate alongside AuthContext loading).

## 3. Component kit — `src/components/ui/`

| Component | Replaces / purpose |
|-----------|--------------------|
| `GlassCard` | Unified glass surface: `expo-glass-effect` GlassView on iOS 26+, BlurView fallback on older iOS, tinted opaque card on Android. Radius/tint from tokens. Old `GlassView` becomes a thin wrapper (deprecated). |
| `ScreenScaffold` | LiquidBackground + large title + sticky glass header + scroll wiring — replaces the 4 copy-pasted collapsing-header implementations (GroupList, GroupDetails, GroupInfo, Friends). |
| `AppButton` | PrimaryButton superset: `variant: primary/secondary/destructive/ghost`, sizes, built-in haptics, keeps double-submit prevention. |
| `AppTextInput` | Themed Paper TextInput (outlined, tokens). `FloatingLabelInput` deprecated → wrapper. |
| `ListRow` | Icon + title + subtitle + trailing content row used by settings/info screens. |
| `EmptyState` | Icon + title + hint + optional CTA. |
| `OfflineState` | EmptyState variant for "offline & nothing cached" with retry. |
| `SyncBadge` | Small "pending" chip for optimistic outbox items. |
| `MoneyText` | Formats currency via `formatCurrency` and colors by sign via money tokens. |
| `SectionLabel` | Uppercase section header used across list screens. |

All exported from `src/components/ui/index.ts` and re-exported from `src/components/index.ts`.

## 4. Customization — Settings ▸ Appearance

New section on `SettingsScreen` (top-level card):
- **Theme**: segmented System / Light / Dark.
- **Accent**: 6 tappable swatches with checkmark, live preview (haptic on select).
- Everything persists locally; works fully offline; no Firebase write.

## 5. Offline-first UX conventions (every screen)

1. **Cache-first render**: hydrate from local cache (GroupContext cache, profileCache,
   local message/call storage) before any network state. Skeletons only when cache is empty.
2. **Never spin forever**: any loading state that can hang offline gets a timeout →
   `OfflineState` with retry. (Fixes: FriendsScreen infinite spinner, join-group modal,
   LoadingScreen-as-fallback deep links.)
3. **Honest sync state**: outbox-backed optimistic items show `SyncBadge`; online-only
   actions are disabled with a hint when `useOfflineSync` reports offline.
4. **Errors are themed, not `Alert.alert` with raw Firebase strings**: map error codes
   to friendly copy (auth screens especially) and show inline/HelperText/Snackbar.
5. Pull-to-refresh must actually refresh or be removed (no `onRefresh={() => undefined}`).

## 6. Brand

`src/constants/appInfo.ts` exports `APP_NAME` (from `Constants.expoConfig?.name`,
fallback `'SplitCircle'`). All in-app copy uses it (kills the ManaSplit/SplitCircle/SC drift).

## 7. Native surface

- `expo-glass-effect` (`isLiquidGlassAvailable()`) powers GlassCard on iOS 26+.
- Existing `RNThemeIsDark` NSUserDefaults bridge stays; accent flows through JS-side
  tab options (`tabBarActiveTintColor`).
- `modules/my-module` (QuickLook) and `modules/splitcircle-ai` unchanged.
- No new native module required for this phase; MMKV is a noted future option for
  synchronous theme hydration.

## Status (2026-07-02, branch `ui-revamp`)

**Shipped**
- Token layer (`src/theme/`), ThemeContext v2 (system/light/dark + 6 accents,
  offline-persisted, migrated from legacy key), Settings ▸ Appearance UI.
- UI kit (`src/components/ui/`): GlassCard (native iOS 26 liquid glass w/ fallbacks —
  all GlassView consumers upgraded via shim), ScreenScaffold/StickyGlassHeader/LargeTitle,
  AppButton, AppTextInput, ListRow, EmptyState, OfflineState, SyncBadge, MoneyText, SectionLabel.
- Shell tokenized (App.tsx, AppNavigator backgrounds/tints), LiquidBackground accent-aware
  + render bugs fixed, SkeletonLoader tokenized, charts themed (GroupStats, SpendingChart).
- Auth revamp: friendly error mapping (`utils/authErrors.ts`), ForgotPassword silent-failure
  fix, password visibility + AutoFill + field chaining, offline-aware submits, Google-signup
  parity, brand unification via `APP_NAME` (`constants/appInfo.ts`), LoadingScreen themed +
  timeout fallback.
- Honesty fixes: fake pull-to-refresh removed (3 tabs), Friends offline spinner timeout,
  duplicate pinned rows, MessageInfo offline notice, money colors unified onto tokens,
  invite-code copy/share, FriendInfo entry point from Friends list, owner-badge contrast.
- Dead code removed: GlassTabBar, TabBarSurface, GroupCard.
- **Launch-crash root cause + fix (2026-07-03, verified on both simulators)**: iOS 27
  kills apps built with the **iOS 26 SDK or later** that use the classic UIApplication
  lifecycle — `UIScene life cycle is required for apps built with this SDK` (TN3187,
  SIGTRAP before first frame; looked like a splash crash). Affected ALL modern builds
  (local Xcode 27 and remote EAS alike) on iOS 27 devices, while iOS 26.x kept working.
  Fixed by adopting the UIScene lifecycle (`ios/SplitCircle/Info.plist` scene manifest +
  `SceneDelegate` in `AppDelegate.swift`, links forwarded through the delegate chain,
  `launchOptions[.url]` synthesized for cold-start deep links). Keep this intact through
  Expo upgrades — if a future Expo SDK ships its own scene support, reconcile rather
  than duplicate.
- **Build fix (2026-07-03)**: EAS production builds failed compiling the iOS 27 FM spike
  (`PrivateCloudComputeLanguageModel`/`ContextOptions` don't exist in stable Xcode's SDK —
  `#available` is runtime-only). Gated with `#if canImport(FoundationModels) && compiler(>=6.4)`
  in `modules/splitcircle-ai/ios/SplitCircleAIModule.swift`. GlassCard also loads
  expo-glass-effect defensively (try/catch require) so older binaries can't crash at bundle-init.
- SyncBadge wired: `GroupContext.pendingSyncIds` (reactive outbox id set) → ExpenseCard +
  SettlementCard show a "Pending" chip until the server acks.
- Offline guards on GroupList create/join (were infinite spinners offline).

**Designed, not yet implemented** (next passes)
- Adopt ScreenScaffold in GroupList/GroupDetails/GroupInfo/Friends (replace hand-rolled headers).
- Disable-or-queue remaining online-only group admin actions (edit/delete expense, member ops).
- ChatRoomScreen/ChatMediaGalleryScreen decomposition; date separators; chat search-across-chats;
  thread avatars; StarredMessages tap-through + unstar.
- Replace remaining FloatingLabelInput uses with AppTextInput; unify the three FilterSortSheet
  variants; member action sheet + ownership transfer in GroupInfo; route profile-photo upload
  through the outbox; currency i18n (device locale, zero-decimal currencies).
- Calls screens restyle (unaudited this round: calls, notification settings detail, AI screens).

## 8. Migration rules for screen work

- Zero new hex/rgba literals in screens; replace on touch. Chart palettes from `theme.colors.chart`.
- Replace per-screen sticky-header implementations with `ScreenScaffold`.
- Keep react-native-paper components; do not introduce new UI libraries.
- Do not change navigation structure, route names, or data contexts' public APIs.
- Do not break the three-tier storage DNA (see ARCHITECTURE.md).

## 2026-07-03 (later): wallpapers, photo integration, calls revamp — VERIFIED ON iOS 27 SIM
- Custom backgrounds: app-wide photo, chat-default, per-chat/per-group overrides
  (wallpaperService + useWallpaper + LiquidBackground photo layer). Verified live:
  app slot renders behind Groups/Settings/Calls; chat-default renders in
  conversations; Settings rows detect set photos; chat header menu shows
  Change/Reset wallpaper. NOTE: iOS 27 beta sim's PHPicker hangs on "Loading…"
  (OS bug — picker is out-of-process); verified by injecting storage directly.
- Profile photos: buildUserProfile precedence fixed (Firestore-first),
  uploader syncs Firebase Auth + propagates to group member entries;
  UserAvatar/GroupAvatar unified components; verified real photo rendering in
  chat list rows + chat header pill.
- Group photos: model + updateGroup + GroupPhotoUploader (Group Info, admin
  camera badge); GroupAvatar across ChatList/GroupDetails/GroupInfo/call header.
- firestore.rules updated (photoURL/description in mutable list + profile-sync
  clause) — MUST run `firebase deploy --only firestore:rules`.
- Calls: session screen shows peer identity (avatar/name) everywhere,
  FaceTime-style CallControls, avatar-led lobby rows.
