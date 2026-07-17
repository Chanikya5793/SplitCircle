# 20 — Native search tab (UISearchTab): how it works, what not to touch

**Status: SHIPPED and verified 2026-07-16** (sim: split tab bar, native morph, text
bridge, cancel-returns; commits `1f41e36` + `a1b15af` on `ui-revamp`).

The search tab is the iOS 26 Phone/Photos pattern, achieved with **real UIKit
components**: the tab bar renders the four tabs in a pill plus a **detached search
circle**, and tapping the circle makes **the tab bar itself collapse into the system
search field** (Liquid Glass morph, run by UIKit — not an animation we own). This was
built against 60fps frame studies of the real Phone and Photos apps
(`~/Downloads/phoneApp.MP4`, `~/Downloads/photosApp.MP4` — re-extract frames with
ffmpeg before redesigning anything here).

## Why a patch exists

react-native-screens implements native bottom tabs with the **legacy**
`UITabBarController.viewControllers` + `UITabBarItem(tabBarSystemItem:)` API. The
split-circle geometry and the tab-bar→search-field morph are exclusive to the
**iOS 18 `UITab` / `UISearchTab` API**, which **no version of react-native-screens
implements** (verified through 4.27-nightly; upstream issue #3999 closed
not_planned). There is no prop, style, or JS workaround — the geometry is decided by
which native API constructs the tabs. Hence:

**`patches/react-native-screens+4.23.0.patch`** — the single most breakable artifact
of this feature. It must be re-ported by hand if react-native-screens is upgraded.

## Architecture (three layers)

1. **Native (the patch)** — `RNSTabBarController.mm/h` + `RNSTabBarControllerDelegate.mm`:
   - On **iOS 26+**, when any tab screen has `systemItem == search`,
     `updateReactChildrenControllers` builds `UITab` objects (identifier = `tabKey`)
     instead of calling `setViewControllers:`. The search tab becomes a `UISearchTab`
     with `automaticallyActivatesSearch = YES`; everything below iOS 26 (and Android)
     keeps the untouched legacy path.
   - The search tab's content is the RNS tab screen wrapped in a **hidden-bar
     `UINavigationController`** whose root carries a `UISearchController`
     (`navigationItem.searchController`, `preferredSearchBarPlacement = Integrated`).
     UIKit requires this hierarchy for the morph; do not "simplify" it away.
   - `RNSSearchTabBridge` (defined inside `RNSTabBarController.mm`) relays the field's
     activity over **NSNotificationCenter** (`RNSSearchTabTextDidChange` /
     `DidActivate` / `DidDeactivate` / `DidSubmit`, reverse: `RNSSearchTabSetText`).
     Notifications were chosen deliberately: **zero codegen changes**, keeping the
     patch small.
   - Selection in tabs mode goes through `selectedTab` (never
     `setSelectedViewController:` — it doesn't know about the nav wrapper). Loops that
     used to iterate `self.viewControllers` iterate `_tabScreenControllers` instead,
     because in tabs mode `viewControllers` contains the nav wrapper, and casting it
     to `RNSTabsScreenViewController` crashes.
   - The delegate grew `tabBarController:shouldSelectTab:` /
     `didSelectTab:previousTab:` mirroring the controlled-mode logic. The **legacy
     view-controller delegate pair returns early when tabs mode is active** so one
     selection can't emit to JS twice. `didSelectTab` exists for **system-initiated**
     selection: cancelling search makes UIKit reselect the previous tab on its own,
     and JS must be told to follow. The search tab itself must return **YES** from
     `shouldSelectTab:` even in controlled mode, or UIKit never runs the morph.
   - After each appearance pass, `rns_syncTabsFromTabBarItems` copies the
     coordinator-resolved `tabBarItem` title/image onto the `UITab`s — **UITab ignores
     per-controller `tabBarItem`**, so without this sync the icons vanish.

2. **Bridge module** — `modules/splitcircle-ai` (`SplitCircleAIModule.swift`):
   `Events("onSearchTabEvent")` relays the notifications to JS;
   `hasNativeSearchTab()` is the **capability probe** (its presence in a binary
   implies the RNS patch shipped in the same binary — both are native and build
   together); `setSearchTabText(text)` fills the field from JS (recents/suggestion
   taps). JS wrappers: `isNativeSearchTabAvailable` / `subscribeNativeSearchTab` /
   `setNativeSearchTabText` in `modules/splitcircle-ai/index.ts`.

3. **JS** — `src/screens/search/SearchScreen.tsx` has two modes decided once by
   `isNativeSearchTabAvailable()`:
   - **Native mode** (iOS 26 build with the patch): renders **no field, no X, no
     scrim** — it mirrors the system field's text and only draws content (Photos-style
     idle: big title, Recents + Clear, stacked suggestion pills; Phone-style plain
     top-anchored result sections; floating prediction panel that must clear the
     system field).
   - **Fallback mode** (Android / older binaries): the JS bottom field that fakes the
     morph with Reanimated (~320ms out-cubic, measured off the Phone recording) plus
     a round X.

## Behavioral contract (measured off Photos — do not "fix")

- **Tab-switch away and back KEEPS a committed search.** Do not clear the query on
  blur. (This was implemented wrong once — "always reopen fresh" — and corrected
  after re-reading the recordings.)
- **Only cancel clears**: the native Cancel/X (→ `deactivate` event) or the fallback
  X. Cancel also returns the user to the previously selected tab — that's a *system*
  behavior of `UISearchTab`; nothing in JS navigates.
- **Search is universal** — scope chips were deliberately removed.
- Both reference apps keep a **round X beside the docked field** — the X *is* native;
  don't remove it from the fallback.

## Traps that already bit us

- **ObjC protocol selectors are not Swift names.** `UISearchResultsUpdating` is
  `updateSearchResultsForSearchController:` — implementing `updateSearchResults:`
  compiles fine and then crashes with unrecognized-selector the moment the field
  activates (shipped broken once; fixed in `a1b15af`). Protocol conformance in the
  bridge gets NO compile-time check for optional methods — verify selector names
  against headers, not memory.
- **The sim cannot show native changes via jsbundle hot-swap.** The tab bar geometry
  lives in the binary; a two-week-old sim install will show the old inline glyph
  forever. Native verification path: `npm run ship:ios` (TestFlight), or a one-off
  **Debug** sim build via raw `xcodebuild` (`expo run:ios` fails on the Xcode beta —
  it can't find Simulator.app, which is now Device Hub):
  `xcodebuild -workspace ios/SplitCircle.xcworkspace -scheme SplitCircle
  -configuration Debug -destination 'id=<sim-udid>' -derivedDataPath ios/build build`
  then `simctl install` + `npx expo start` for Metro. (Release sim builds stay banned.)
- **patch-package**: the patch applies via `postinstall`. After any dependency work,
  grep `node_modules/react-native-screens/ios/bottom-tabs/host/RNSTabBarController.mm`
  for `RNSSearchTabBridge` to confirm it's applied.
- The `tabBarSystemItem: 'search'` prop chain that activates all of this:
  react-navigation `unstable` NativeBottomTabView → `Tabs.Screen systemItem` →
  RNS `RNSBottomTabsScreenComponentView.systemItem`. Renaming/retitling that tab in
  `AppNavigator` (e.g. giving it a `tabBarLabel`) demotes it — leave it unlabeled.

## If react-native-screens gets upgraded

1. Check whether upstream gained UITab/UISearchTab support (issue #3999). If yes,
   migrate to it and delete the patch.
2. If not: re-apply each `PATCHED (SplitCircle)` block (they're all marked with that
   string — grep for it) onto the new sources and regenerate with
   `npx patch-package react-native-screens`. Then a full native build + the
   verification checklist below.

## Verification checklist (what "working" means)

1. Tab bar idle: 4-tab pill + gap + detached search circle.
2. Tap circle: tab bar collapses into the system field (remnant left, field center,
   X right), JS shows the idle search content.
3. Type: JS results mirror every keystroke, matches highlighted, prediction panel
   floats clear of the field.
4. Tap a recent/suggestion: the native field adopts the text.
5. X: field collapses back into the tab bar, lands on the previously selected tab,
   search reopens fresh.
6. Committed search (return key) + switch tab + return: query and results retained.
