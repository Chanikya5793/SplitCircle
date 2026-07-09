// Unified glass surface for the whole app.
//   iOS 26+  → native liquid glass via expo-glass-effect
//   older iOS → expo-blur BlurView with animated theme tint
//   Android  → near-opaque tinted card (BlurView can't render there)
// Tints, borders, and radii come from theme tokens — never hardcode them here.

import { useTheme } from '@/context/ThemeContext';
import { NEUTRALS } from '@/theme/palette';
import { BlurView } from 'expo-blur';
import React from 'react';
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

// Resolve the native liquid-glass module defensively: requiring
// expo-glass-effect registers a native view manager, which THROWS during
// bundle init on any binary that doesn't include the ExpoGlassEffect native
// module (older dev clients). This file is in the app's startup import chain,
// so an eager import would crash at the splash screen. Fall back to blur.
let NativeGlassView: React.ComponentType<any> | null = null;
let LIQUID_GLASS = false;
if (Platform.OS === 'ios') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const glass = require('expo-glass-effect');
    if (glass.isLiquidGlassAvailable()) {
      NativeGlassView = glass.GlassView;
      LIQUID_GLASS = true;
    }
  } catch {
    LIQUID_GLASS = false;
  }
}

// Crossfade worklets need BOTH schemes' values at once (themeProgress
// interpolates light→dark), so this primitive reads the palette directly —
// the one place outside buildTheme allowed to.
const TINTS =
  Platform.OS === 'android'
    ? ([NEUTRALS.light.glassFallback, NEUTRALS.dark.glassFallback] as const)
    : ([NEUTRALS.light.glassTint, NEUTRALS.dark.glassTint] as const);
const BORDERS =
  Platform.OS === 'android'
    ? ([NEUTRALS.light.glassBorderAndroid, NEUTRALS.dark.glassBorderAndroid] as const)
    : ([NEUTRALS.light.glassBorder, NEUTRALS.dark.glassBorder] as const);

export interface GlassCardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  /** Blur intensity for the pre-iOS-26 BlurView path. */
  intensity?: number;
  /** Corner radius token (or explicit number). Defaults to 'lg' (20). */
  radius?: keyof AppRadius | number;
  /** Escape hatch: skip the native liquid-glass material even when available. */
  forceBlur?: boolean;
}

type AppRadius = ReturnType<typeof useTheme>['theme']['radius'];

export const GlassCard = React.memo(
  ({ children, style, contentStyle, intensity = 38, radius = 'lg', forceBlur = false }: GlassCardProps) => {
    const { isDark, theme, themeProgress } = useTheme();
    const borderRadius = typeof radius === 'number' ? radius : theme.radius[radius];

    const animatedStyle = useAnimatedStyle(() => {
      return {
        backgroundColor: interpolateColor(themeProgress.value, [0, 1], [TINTS[0], TINTS[1]]),
        borderColor: interpolateColor(themeProgress.value, [0, 1], [BORDERS[0], BORDERS[1]]),
      };
    });

    if (LIQUID_GLASS && NativeGlassView && !forceBlur) {
      // Native material carries its own rim highlight — no manual border.
      return (
        <NativeGlassView
          glassEffectStyle="regular"
          colorScheme={isDark ? 'dark' : 'light'}
          style={[styles.nativeGlass, { borderRadius }, style]}
        >
          <View style={[styles.content, contentStyle]}>{children}</View>
        </NativeGlassView>
      );
    }

    return (
      <Animated.View style={[styles.container, { borderRadius }, animatedStyle, style]}>
        {Platform.OS === 'ios' && (
          <BlurView
            intensity={intensity}
            tint={isDark ? 'dark' : 'light'}
            style={[StyleSheet.absoluteFill, { borderRadius }]}
            pointerEvents="none"
          />
        )}
        <View style={[styles.content, contentStyle]}>{children}</View>
      </Animated.View>
    );
  },
);

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    borderWidth: 1,
    // Android can't render BlurView, so the flat tinted card needs elevation to
    // read as a raised glass surface instead of a painted-on rectangle. iOS
    // depth comes from the blur/liquid-glass material, so scope this to Android.
    ...Platform.select({
      android: {
        elevation: 4,
        shadowColor: '#000',
      },
    }),
  },
  nativeGlass: {
    overflow: 'hidden',
  },
  content: {
    zIndex: 1,
  },
});
