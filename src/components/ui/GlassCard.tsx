// Unified content surface for the whole app. Two treatments, user-selectable
// (ThemeContext.surfaceStyle) and persisted with mode/accent:
//
//   'glass' (default) — the liquid-glass DNA, EXACTLY as it ships today:
//       iOS 26+  → native liquid glass via expo-glass-effect
//       older iOS → expo-blur BlurView with animated theme tint
//       Android  → near-opaque tinted card (BlurView can't render there)
//   'flat'            — borderless. No blur, no fill, no border, no elevation;
//       content sits on the canvas and is grouped by section labels and
//       dividers instead of card edges.
//
// `role` matters ONLY in flat mode — glass ignores it, so the shipping UI is
// bit-for-bit unchanged:
//
//   'section'  (default) — a content card. Goes fully borderless when flat.
//   'floating'           — chrome that must stay readable off the canvas:
//       bottom sheets, toasts, menus, dropdowns, circular buttons, pills.
//       A borderless toast is an invisible toast, so these keep an opaque
//       fill + hairline even in flat mode.
//
// Tints, borders, and radii come from theme tokens — never hardcode them here.

import { useTheme } from '@/context/ThemeContext';
import { NEUTRALS } from '@/theme/palette';
import { flatRadius } from '@/theme/tokens';
import type { SurfaceRole } from './surfaceRole';
import { BlurView } from 'expo-blur';
import React from 'react';
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

// Resolve the native liquid-glass module defensively. A bare require() of
// expo-glass-effect on a binary that doesn't include the ExpoGlassEffect
// native module (older dev clients, or the JS-only jsbundle hot-swap used to
// verify non-native changes) doesn't reliably throw a catchable JS error —
// per this project's own optional-native-module gotcha, it can SIGSEGV
// Hermes instead. This file sits in the app's startup import chain, so probe
// with requireOptionalNativeModule() FIRST (same pattern as
// PrivacyGuardContext/ringback/screenCaptureGuard/biometrics) and only
// require() the JS wrapper once the native half is confirmed present. Fall
// back to blur otherwise.
let NativeGlassView: React.ComponentType<any> | null = null;
let LIQUID_GLASS = false;
if (Platform.OS === 'ios') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { requireOptionalNativeModule } = require('expo-modules-core');
    if (requireOptionalNativeModule('ExpoGlassEffect')) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const glass = require('expo-glass-effect');
      if (glass.isLiquidGlassAvailable()) {
        NativeGlassView = glass.GlassView;
        LIQUID_GLASS = true;
      }
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

// Flat treatment reads the palette directly for the same reason the glass
// tints do — the themeProgress crossfade worklet needs BOTH schemes at once.
const FLAT_FILLS = [NEUTRALS.light.flatSurface, NEUTRALS.dark.flatSurface] as const;
const FLAT_BORDERS = [NEUTRALS.light.flatBorder, NEUTRALS.dark.flatBorder] as const;

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
  /**
   * Flat-mode only (glass ignores it). 'section' goes borderless; 'floating'
   * keeps an opaque fill so sheets/menus/toasts/buttons stay readable.
   */
  role?: SurfaceRole;
}

/**
 * Neutralizes a card's own box in borderless mode. Horizontal padding is
 * zeroed because in glass mode it sat INSIDE a visible card — with the card
 * gone it reads as a stray indent, pushing content out of line with the
 * screen's own gutter and with the section label above it. Vertical padding
 * survives: it becomes the rhythm between rows.
 */
const BORDERLESS_RESET = {
  backgroundColor: 'transparent',
  borderWidth: 0,
  borderRadius: 0,
  paddingHorizontal: 0,
  paddingLeft: 0,
  paddingRight: 0,
  elevation: 0,
  shadowOpacity: 0,
} as const;

type AppRadius = ReturnType<typeof useTheme>['theme']['radius'];

export const GlassCard = React.memo(
  ({
    children,
    style,
    contentStyle,
    intensity = 38,
    radius = 'lg',
    forceBlur = false,
    role = 'section',
  }: GlassCardProps) => {
    const { isDark, theme, themeProgress } = useTheme();
    // Defaulted, not asserted: several component tests mock useTheme() with a
    // partial theme object, and an undefined surfaceStyle must mean 'glass'
    // rather than throwing or silently flattening.
    const isFlat = theme?.surfaceStyle === 'flat';
    const isBorderless = isFlat && role === 'section';

    // A NUMERIC radius is an explicit geometric requirement from the caller
    // (circular icon buttons pass radius={50}), so it survives flattening
    // untouched. Only the token scale is pulled in.
    const borderRadius =
      typeof radius === 'number'
        ? radius
        : isFlat
          ? flatRadius[radius]
          : theme.radius[radius];

    const animatedStyle = useAnimatedStyle(() => {
      const fills = isFlat ? FLAT_FILLS : TINTS;
      const borders = isFlat ? FLAT_BORDERS : BORDERS;
      return {
        backgroundColor: interpolateColor(themeProgress.value, [0, 1], [fills[0], fills[1]]),
        borderColor: interpolateColor(themeProgress.value, [0, 1], [borders[0], borders[1]]),
      };
    }, [isFlat]);

    // Flat + section → borderless. Caller styles are flattened first so the
    // reset can override padding/fill they set themselves; margins, width and
    // layout survive untouched. Plain Views: nothing here animates, so there is
    // no reason to pay for Reanimated.
    if (isBorderless) {
      return (
        <View style={[StyleSheet.flatten(style), BORDERLESS_RESET]}>
          <View style={[styles.content, StyleSheet.flatten(contentStyle), BORDERLESS_RESET]}>
            {children}
          </View>
        </View>
      );
    }

    // Flat + floating → one opaque view on every platform. No BlurView, no
    // native material, and deliberately no Android elevation: a flat surface
    // that casts a shadow is just a card again.
    if (isFlat) {
      return (
        <Animated.View style={[styles.flat, { borderRadius }, animatedStyle, style]}>
          <View style={[styles.content, contentStyle]}>{children}</View>
        </Animated.View>
      );
    }

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
  flat: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  content: {
    zIndex: 1,
  },
});
