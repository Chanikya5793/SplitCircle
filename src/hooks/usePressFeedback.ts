/**
 * usePressFeedback — the app's single answer to "what should a tap look like".
 *
 * THE BUG THIS EXISTS TO FIX (2026-08-07). react-native-paper's
 * `TouchableRipple` only renders a real ripple on Android:
 * `TouchableRipple.supported` is `Platform.OS === 'android' && Version >= 21`.
 * On iOS it falls back to painting a plain `View` over the row:
 *
 *     underlay: { ...StyleSheet.absoluteFillObject, zIndex: 2 }
 *
 * That fallback is wrong for this app in three separate ways, and they
 * compound:
 *   1. `zIndex: 2` puts it ON TOP of the row's own content, so the tint lands
 *      over the title, avatar and amount — not behind them.
 *   2. It carries no `borderRadius`, so on a rounded row (group cards are
 *      24pt, chat rows 16pt) it paints SQUARE corners over a rounded surface.
 *      Only rows whose parent happens to clip (`overflow: 'hidden'`) hide it,
 *      which is why it looked fine in some places and wrong in others.
 *   3. It is binary — appears and vanishes on press with no fade, while the
 *      cards underneath are running a smooth 110ms scale via `usePressScale`.
 *
 * So the fix is not a better grey. On iOS the tint is removed entirely and the
 * scale IS the feedback (the platform idiom, and something this app already
 * does on its cards). On Android the ripple is the platform idiom and is kept,
 * themed to the app's own `pressed` token rather than Paper's MD3 default.
 *
 * Returns props to spread onto a `TouchableRipple`, plus the scale style and
 * handlers from `usePressScale`. Wrap the touchable's CONTENT in an
 * `Animated.View` with `pressScaleStyle` — see usePressScale's own note.
 */

import { useTheme } from '@/context/ThemeContext';
import { usePressScale } from '@/hooks/usePressScale';
import { Platform } from 'react-native';

export const usePressFeedback = () => {
  const { theme } = useTheme();
  const { pressScaleStyle, onPressIn, onPressOut } = usePressScale();

  // Defensive `?.` — several component tests mock useTheme() with a partial
  // theme object (same convention as GlassCard).
  const pressed = theme?.colors?.pressed ?? 'rgba(0, 0, 0, 0.05)';

  return {
    pressScaleStyle,
    onPressIn,
    onPressOut,
    /** Spread onto the TouchableRipple. */
    touchableProps: {
      onPressIn,
      onPressOut,
      // iOS: no painted overlay at all — the scale carries the press. Android:
      // a real ripple in the app's own neutral press token.
      rippleColor: Platform.OS === 'android' ? pressed : 'transparent',
      underlayColor: 'transparent',
    } as const,
  };
};
