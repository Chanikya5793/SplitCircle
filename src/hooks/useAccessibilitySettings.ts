/**
 * useAccessibilitySettings — the OS accessibility settings this app reacts to,
 * as one live subscription.
 *
 * Before this existed the app read NONE of them (2026-08-07): 1,364 <Text>
 * components with no scaling policy, zero `fontScale` awareness, and the only
 * AccessibilityInfo call in the codebase was the brand splash's reduce-motion
 * check. Increasing iOS text size to an AX size clipped titles, avatar
 * initials, buttons and tab labels.
 *
 * All four values are LIVE — the user can change any of them in Settings while
 * the app is foregrounded (iOS does not relaunch the app for these), so each
 * one is subscribed rather than read once at mount.
 *
 * Consumed by ThemeContext so the whole tree sees it through `useTheme()`
 * without 244 glass surfaces each opening their own subscription.
 */

import { useEffect, useState } from 'react';
import { AccessibilityInfo, PixelRatio } from 'react-native';

export interface AccessibilitySettings {
  /** OS text-size multiplier. 1 = default; iOS AX sizes reach ~3.1. */
  fontScale: number;
  /** Settings ▸ Accessibility ▸ Display & Text Size ▸ Reduce Transparency. */
  reduceTransparency: boolean;
  /** Settings ▸ Accessibility ▸ Motion ▸ Reduce Motion. */
  reduceMotion: boolean;
  /** VoiceOver (iOS) / TalkBack (Android) is running. */
  screenReader: boolean;
}

export const useAccessibilitySettings = (): AccessibilitySettings => {
  // PixelRatio.getFontScale() rather than useWindowDimensions().fontScale:
  // the latter only updates on a dimensions event, which a text-size change
  // alone does not always emit. This is paired with the explicit change
  // subscriptions below.
  const [fontScale, setFontScale] = useState(() => PixelRatio.getFontScale());
  const [reduceTransparency, setReduceTransparency] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [screenReader, setScreenReader] = useState(false);

  useEffect(() => {
    let alive = true;
    const set = <T,>(fn: (v: T) => void) => (v: T) => {
      if (alive) fn(v);
    };

    void AccessibilityInfo.isReduceTransparencyEnabled?.().then(set(setReduceTransparency)).catch(() => undefined);
    void AccessibilityInfo.isReduceMotionEnabled().then(set(setReduceMotion)).catch(() => undefined);
    void AccessibilityInfo.isScreenReaderEnabled().then(set(setScreenReader)).catch(() => undefined);

    const subs = [
      AccessibilityInfo.addEventListener('reduceTransparencyChanged', set(setReduceTransparency)),
      AccessibilityInfo.addEventListener('reduceMotionChanged', set(setReduceMotion)),
      AccessibilityInfo.addEventListener('screenReaderChanged', set(setScreenReader)),
    ];

    // There is no "fontScaleChanged" event on either platform. Re-reading on
    // every app foreground is what actually catches a text-size change made
    // in Settings, which is the only way it can change.
    const poll = setInterval(() => {
      const next = PixelRatio.getFontScale();
      if (alive) setFontScale((prev) => (prev === next ? prev : next));
    }, 1000);

    return () => {
      alive = false;
      subs.forEach((s) => s?.remove?.());
      clearInterval(poll);
    };
  }, []);

  return { fontScale, reduceTransparency, reduceMotion, screenReader };
};
