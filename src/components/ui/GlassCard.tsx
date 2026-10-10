// Unified material primitive. See DESIGN.md ("Two surface styles") for the contract.
// Glass preference: native material, blur, or tinted Android fallback.
// Flat preference: borderless sections, opaque floating chrome, and the named
// glass accents. Reduce Transparency makes bounded surfaces opaque in either
// preference; it retains borderless sections only when the user chose Flat.
// Surface roles, tint and radius resolution stay centralized here.

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
   * 'section' groups content; 'floating' protects overlay chrome; 'glass' is
   * a named accent retained under Flat. Reduce Transparency overrides material.
   */
  role?: SurfaceRole;
}

/**
 * Neutralizes a card's own box in borderless mode. Horizontal padding is
 * zeroed because in glass mode it sat INSIDE a visible card — with the card
 * gone it reads as a stray indent, pushing content out of line with the
 * screen's own gutter and with the section label above it. Vertical padding
 * survives: it becomes the rhythm between rows.
 *
 * THE CONTRACT THIS ASSUMES (see components/ui/layout): the SCREEN keeps its
 * gutter, so zeroing the card's padding lands content exactly on it. A card
 * that has been bled out with `fullBleed` starts at x=0 instead, and its
 * children must then carry their own inset — ListRow already does, and any
 * other block inside a bled card needs `paddingHorizontal: SCREEN_GUTTER` of
 * its own or it ends up flush against the screen edge.
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

// Children render inside an inner content view (it sits above the blur /
// native material), so layout props on `style` land on the SHELL and never
// reach them. The callers plainly meant their children:
//  - `flexDirection: 'row'` — the call banner, chat search, pinned bar, media
//    banner, selection toolbar and stats insight cards all rendered as a
//    vertical stack;
//  - `alignItems: 'center'` — it centred the content block but not the items
//    in it, so an empty state's icon sat at the left edge of its own text.
// Those are forwarded to the content view. A column's `gap`/`flexWrap` are
// NOT: they have been inert for as long as those screens were tuned (the Add
// Expense form among them), and applying them now would re-space every one.
const CHILD_LAYOUT_KEYS = ['alignItems', 'justifyContent', 'alignContent'] as const;
const ROW_ONLY_LAYOUT_KEYS = ['flexDirection', 'flexWrap', 'gap', 'rowGap', 'columnGap'] as const;

const splitChildLayout = (
  style: StyleProp<ViewStyle>,
): { shell: StyleProp<ViewStyle>; layout: ViewStyle | null } => {
  const flat = StyleSheet.flatten(style) as ViewStyle | undefined;
  if (!flat) return { shell: style, layout: null };
  const isRow = flat.flexDirection === 'row' || flat.flexDirection === 'row-reverse';
  const keys = isRow ? [...CHILD_LAYOUT_KEYS, ...ROW_ONLY_LAYOUT_KEYS] : CHILD_LAYOUT_KEYS;
  if (!keys.some((key) => key in flat)) return { shell: style, layout: null };
  const shell: Record<string, unknown> = { ...flat };
  // Fill the shell so a fixed-size bar or circle can still centre its content.
  const layout: Record<string, unknown> = { flexGrow: 1 };
  for (const key of keys) {
    if (key in shell) {
      layout[key] = shell[key];
      delete shell[key];
    }
  }
  return { shell: shell as ViewStyle, layout: layout as ViewStyle };
};

export const GlassCard = React.memo(
  ({
    children,
    style: callerStyle,
    contentStyle: callerContentStyle,
    intensity = 38,
    radius = 'lg',
    forceBlur = false,
    role = 'section',
  }: GlassCardProps) => {
    const { isDark, theme, themeProgress } = useTheme();
    const { shell: style, layout: childLayout } = React.useMemo(() => splitChildLayout(callerStyle), [callerStyle]);
    const contentStyle = childLayout ? [childLayout, callerContentStyle] : callerContentStyle;
    // Defaulted, not asserted: several component tests mock useTheme() with a
    // partial theme object, and an undefined surfaceStyle must mean 'glass'
    // rather than throwing or silently flattening.
    // Reduce Transparency chooses opaque fills for bounded surfaces. Only the
    // user's Flat preference removes section boundaries. Named glass accents
    // also become opaque when the accessibility setting is enabled.
    const reduceTransparency = theme?.reduceTransparency === true;
    const userChoseFlat = theme?.surfaceStyle === 'flat';
    // Opaque fills come from EITHER the user's flat preference or the OS
    // accessibility setting…
    const isFlat = userChoseFlat || reduceTransparency;
    // …but BORDERLESS comes only from the user's own preference. Reduce
    // Transparency asks for less see-through, not for the card to disappear:
    // someone on glass mode who enables it should get solid cards, not a
    // borderless layout they never chose. Same for role="glass" accents —
    // they stay a visible surface, just an opaque one.
    const isBorderless = userChoseFlat && role === 'section';

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
    // that casts a shadow is just a card again. role="glass" opts OUT of this
    // entirely — it always falls through to the native/blur glass path below,
    // the same one glass mode uses, regardless of surfaceStyle.
    if (isFlat && (role !== 'glass' || reduceTransparency)) {
      return (
        <Animated.View style={[styles.flat, { borderRadius }, animatedStyle, style]}>
          <View style={[styles.content, contentStyle]}>{children}</View>
        </Animated.View>
      );
    }

    if (LIQUID_GLASS && NativeGlassView && !forceBlur && !reduceTransparency) {
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
