/**
 * usePressScale — iOS-style press "squish" for cards and rows.
 *
 * Returns an animated style plus onPressIn/onPressOut handlers to spread onto
 * any Touchable. The scale runs on the UI thread (Reanimated) with the spring
 * parameters Apple-feel apps converge on: quick, softly damped, no overshoot
 * on the way down and a light bounce on release. Wrap the touchable's CONTENT
 * in an Animated.View with `style` — scaling the touchable itself would also
 * scale the ripple/highlight bounds.
 */

import { useCallback } from 'react';
import {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  Easing,
} from 'react-native-reanimated';

const PRESSED_SCALE = 0.97;

export const usePressScale = () => {
  const scale = useSharedValue(1);

  const onPressIn = useCallback(() => {
    // Timing (not spring) into the press: it should feel immediate, like the
    // surface is solid under the finger.
    scale.value = withTiming(PRESSED_SCALE, {
      duration: 110,
      easing: Easing.out(Easing.quad),
    });
  }, [scale]);

  const onPressOut = useCallback(() => {
    // Spring out: a light, quick settle — this is where the "alive" feel is.
    scale.value = withSpring(1, {
      damping: 15,
      stiffness: 300,
      mass: 0.6,
    });
  }, [scale]);

  const pressScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return { pressScaleStyle, onPressIn, onPressOut };
};
