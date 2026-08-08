// Full-bleed backdrop behind a sheet / context menu / celebratory reveal.
//
// DESIGN.md carves these out from the "all glass goes through GlassCard" rule
// on purpose: a scrim is not a bounded surface, it is the dimming layer BEHIND
// one, so it has no border, no radius and no card of its own. That carve-out
// stands — this component exists only to make the scrim follow surfaceStyle
// instead of hardcoding blur at seven separate call sites.
//
//   glass → expo-blur BlurView, exactly as before
//   flat  → a plain dim layer using the existing `overlay` semantic token
//
// In flat mode the sheet in front of this is role="floating" and already
// carries an opaque fill, so the scrim only has to separate it from the
// content behind — which a flat dim does as well as a blur, and without the
// one glass signature that would otherwise survive flat mode.

import { useTheme } from '@/context/ThemeContext';
import { BlurView } from 'expo-blur';
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

export interface ScrimBackdropProps {
  /** Blur intensity for the glass path. Ignored when flat. */
  intensity?: number;
  /** Defaults to the scheme's own tint. */
  tint?: 'light' | 'dark' | 'default';
  style?: StyleProp<ViewStyle>;
  pointerEvents?: 'none' | 'auto' | 'box-none' | 'box-only';
}

export const ScrimBackdrop = ({
  intensity = 40,
  tint,
  style,
  pointerEvents,
}: ScrimBackdropProps) => {
  const { isDark, theme } = useTheme();

  // Reduce Transparency also drops the blur — a blurred backdrop is exactly
  // what that setting exists to remove. Falls through to the flat dim layer.
  if (theme?.surfaceStyle === 'flat' || theme?.reduceTransparency === true) {
    return (
      <View
        pointerEvents={pointerEvents}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlay }, style]}
      />
    );
  }

  return (
    <BlurView
      intensity={intensity}
      tint={tint ?? (isDark ? 'dark' : 'light')}
      style={[StyleSheet.absoluteFill, style]}
      pointerEvents={pointerEvents}
    />
  );
};
