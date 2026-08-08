/**
 * usePressFeedback — the app's single answer to "what should a tap look like".
 *
 * A press needs a VISUAL CUE (this is the thing being touched), not just
 * motion. A scale-only response reads as an animation, not as feedback. So
 * this returns both: a highlight tint AND a subtle scale.
 *
 * ── Why this doesn't use react-native-paper's ripple/underlay ──────────────
 * `TouchableRipple.supported` is `Platform.OS === 'android' && Version >= 21`,
 * so iOS NEVER gets a ripple. It falls back to painting a plain View:
 *
 *     underlay: { ...StyleSheet.absoluteFillObject, zIndex: 2 }
 *
 * which is wrong three ways at once: `zIndex: 2` puts the tint ON TOP of the
 * row's own title/avatar/amount instead of behind them; it carries no
 * `borderRadius`, so it paints SQUARE corners over rounded rows (only hidden
 * where a parent happens to clip); and it is binary, snapping on and off with
 * no fade while the row underneath runs a smooth scale.
 *
 * Driving the tint ourselves fixes all three: it is the background of a view
 * that WRAPS the content (so it paints behind, and inherits whatever clipping
 * and radius the surface already has) and it crossfades on the UI thread.
 * Paper's own ripple/underlay are disabled — otherwise Android would show two
 * competing highlights.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   const { pressScaleStyle, pressHighlightStyle, touchableProps } = usePressFeedback();
 *   <Animated.View style={pressScaleStyle}>          // outside the surface
 *     <GlassCard>
 *       <TouchableRipple {...touchableProps}>
 *         <Animated.View style={pressHighlightStyle}>  // INSIDE, wraps content
 *           …row content…
 *
 * The highlight view must be inside the rounded/clipped surface, and must be
 * the thing wrapping the content — not a sibling overlay — so it renders
 * behind the text rather than over it.
 */

import { useTheme } from '@/context/ThemeContext';
import { useCallback } from 'react';
import {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

const PRESSED_SCALE = 0.98;

/** 'rgba(r, g, b, 0.10)' → 'rgba(r, g, b, 0)'. interpolateColor needs a
 *  zero-ALPHA twin of the same hue; interpolating to the string
 *  'transparent' muddies through black on some platforms. */
const toTransparent = (rgba: string) => rgba.replace(/[\d.]+\s*\)\s*$/, '0)');

export const usePressFeedback = () => {
  const { theme } = useTheme();
  const progress = useSharedValue(0);
  const scale = useSharedValue(1);

  // Defaulted, not asserted: component tests mock useTheme() with partial
  // themes (same convention as GlassCard).
  const highlight = theme?.colors?.pressHighlight ?? 'rgba(0, 0, 0, 0.10)';
  const highlightOff = toTransparent(highlight);

  /**
   * NO SCALE ON FLAT ROWS. Flat rows are full-bleed, and scaling one pulls its
   * edges IN from the screen — measured on a Pixel 7: a 0.98 scale on a 1080px
   * row leaves a 10.8px dead gap at each edge mid-press, so the highlight
   * visibly stops short of both sides. That is the opposite of the native list
   * behaviour we want. Glass mode keeps the scale, because there the row IS a
   * floating inset card and a squish is exactly right for it.
   */
  const isFlat = theme?.surfaceStyle === 'flat';
  // Reduce Motion: drop the squish, keep the highlight. The highlight is the
  // CUE (it says what you are touching) and must survive — only the movement
  // is decorative, and movement is exactly what the setting asks to remove.
  const reduceMotion = theme?.reduceMotion === true;
  const pressedScale = isFlat || reduceMotion ? 1 : PRESSED_SCALE;

  const onPressIn = useCallback(() => {
    // Fast in — the cue must land while the finger is still going down.
    progress.value = withTiming(1, { duration: 70, easing: Easing.out(Easing.quad) });
    scale.value = withTiming(pressedScale, { duration: 110, easing: Easing.out(Easing.quad) });
  }, [progress, scale, pressedScale]);

  const onPressOut = useCallback(() => {
    // Slower out — a lingering fade reads as a deliberate response rather
    // than a flicker, and survives a fast tap where press-in/out are ~50ms
    // apart (a snap-off there would be invisible).
    progress.value = withTiming(0, { duration: 240, easing: Easing.out(Easing.quad) });
    scale.value = withSpring(1, { damping: 15, stiffness: 300, mass: 0.6 });
  }, [progress, scale]);

  const pressScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const pressHighlightStyle = useAnimatedStyle(
    () => ({
      backgroundColor: interpolateColor(progress.value, [0, 1], [highlightOff, highlight]),
    }),
    [highlight, highlightOff],
  );

  return {
    pressScaleStyle,
    pressHighlightStyle,
    onPressIn,
    onPressOut,
    /** Spread onto the TouchableRipple. Paper's own highlight is suppressed —
     *  see the note above; we draw it ourselves on both platforms. */
    touchableProps: {
      onPressIn,
      onPressOut,
      rippleColor: 'transparent',
      underlayColor: 'transparent',
    } as const,
  };
};
