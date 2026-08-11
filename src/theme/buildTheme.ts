import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper';
import { ACCENTS, CHART_BASE, NEUTRALS, type AccentId } from './palette';
import {
  radius,
  scalePaperFonts,
  scaleTypography,
  spacing,
  typography,
  type Radius,
  type Spacing,
  type SurfaceStyle,
  type Typography,
} from './tokens';

export type ColorScheme = 'light' | 'dark';

/** Semantic colors layered on top of the Paper MD3 roles. */
export interface SemanticColors {
  success: string;
  onSuccess: string;
  successContainer: string;
  onSuccessContainer: string;
  warning: string;
  onWarning: string;
  warningContainer: string;
  onWarningContainer: string;
  danger: string;
  onDanger: string;
  dangerContainer: string;
  onDangerContainer: string;
  moneyPositive: string;
  moneyNegative: string;
  moneyNeutral: string;
  appBackground: string;
  glassTint: string;
  glassBorder: string;
  glassBorderAndroid: string;
  glassFallback: string;
  flatSurface: string;
  flatSurfaceAlt: string;
  flatBorder: string;
  divider: string;
  skeleton: string;
  overlay: string;
  backdrop: string;
  pressed: string;
  pressHighlight: string;
  muted: string;
  chart: string[];
}

export interface BlobPalettes {
  settled: [string, string, string];
  balanced: [string, string, string];
  debts: [string, string, string];
}

export interface AppTheme extends MD3Theme {
  colors: MD3Theme['colors'] & SemanticColors;
  spacing: Spacing;
  radius: Radius;
  typography: Typography;
  blob: BlobPalettes;
  accentId: AccentId;
  scheme: ColorScheme;
  /** Surface treatment for bounded content surfaces. Defaults to 'glass'. */
  surfaceStyle: SurfaceStyle;
  /** Live OS text-size multiplier (1 = default). Layout that must adapt at
   *  accessibility sizes branches on this — see isAccessibilityTextSize. */
  fontScale: number;
  /** OS Reduce Transparency. Glass surfaces must render opaque when true. */
  reduceTransparency: boolean;
  /** OS Reduce Motion. Non-essential animation must be skipped when true. */
  reduceMotion: boolean;
}

export const buildTheme = (
  scheme: ColorScheme,
  accentId: AccentId,
  surfaceStyle: SurfaceStyle = 'glass',
  /** OS accessibility state. Defaulted so existing callers and the many tests
   *  that call buildTheme(scheme, accent) keep working unchanged. */
  a11y: { fontScale?: number; reduceTransparency?: boolean; reduceMotion?: boolean } = {},
): AppTheme => {
  const fontScale = a11y.fontScale ?? 1;
  const reduceTransparency = a11y.reduceTransparency ?? false;
  const reduceMotion = a11y.reduceMotion ?? false;
  const base = scheme === 'dark' ? MD3DarkTheme : MD3LightTheme;
  const accent = ACCENTS[accentId][scheme];
  const neutral = NEUTRALS[scheme];
  const chart: string[] = [...CHART_BASE[scheme]];
  chart[0] = accent.primary;

  return {
    ...base,
    // Paper's MD3 variants carry hardcoded lineHeights; RN scales fontSize by
    // the OS text scale but not lineHeight, so they clip at large sizes.
    fonts: scalePaperFonts(base.fonts, fontScale),
    roundness: 12,
    colors: {
      ...base.colors,
      primary: accent.primary,
      onPrimary: accent.onPrimary,
      primaryContainer: accent.primaryContainer,
      onPrimaryContainer: accent.onPrimaryContainer,
      secondary: accent.secondary,
      // Accent-derived, NOT inherited from Paper's MD3 base. `...base.colors`
      // above supplies every MD3 role, so any role left un-overridden silently
      // keeps Material's stock baseline palette — which is purple. That is what
      // made expense category chips, Add Expense participant chips, doc icons
      // and group-info action icons render lavender under all six accents.
      secondaryContainer: accent.secondaryContainer,
      onSecondaryContainer: accent.onSecondaryContainer,
      onSecondary: accent.onSecondary,
      surface: neutral.surface,
      // Real bug found 2026-08-07: these were never overridden, so every
      // TouchableRipple/List.Item in the app (react-native-paper's
      // getRippleColor/getUnderlayColor, TouchableRipple/utils.ts) derived its
      // press-state color from `color(theme.colors.onSurface).alpha(0.12)` —
      // and onSurface was silently falling through to MD3's STOCK Material-You
      // palette (`rgba(28,27,31,1)` light / `rgba(230,225,229,1)` dark, both
      // purple-tinted), never our own `neutral.text`/`neutral.muted`. On iOS,
      // TouchableRipple isn't natively supported (Platform.OS !== 'android'),
      // so it falls back to an absolute-fill underlay View in that same
      // color — a full-row purple-tinted grey wash on every tap, on a design
      // system with zero purple hue anywhere else. This is what read as "tap
      // highlight looks wrong against the flat/glass UI". Setting these two
      // tokens fixes every TouchableRipple/List.Item call site at once (~90
      // TouchableRipple sites + every List.Item, which wraps one) — no need
      // to touch individual Touchable components for this class of surface.
      onSurface: neutral.text,
      onSurfaceVariant: neutral.muted,
      // Kept transparent so the LiquidBackground blobs show through Paper
      // surfaces that inherit `background` — long-standing app DNA.
      background: 'transparent',
      error: neutral.danger,
      onError: neutral.onDanger,
      errorContainer: neutral.dangerContainer,
      onErrorContainer: neutral.onDangerContainer,
      outline: neutral.border,
      // Same reason as the secondary-container roles above — these are neutral
      // rather than accent-derived, but they were equally purple by default.
      surfaceVariant: neutral.surfaceVariant,
      outlineVariant: neutral.outlineVariant,
      surfaceDisabled: neutral.surfaceDisabled,

      success: neutral.success,
      onSuccess: neutral.onSuccess,
      successContainer: neutral.successContainer,
      onSuccessContainer: neutral.onSuccessContainer,
      warning: neutral.warning,
      onWarning: neutral.onWarning,
      warningContainer: neutral.warningContainer,
      onWarningContainer: neutral.onWarningContainer,
      danger: neutral.danger,
      onDanger: neutral.onDanger,
      dangerContainer: neutral.dangerContainer,
      onDangerContainer: neutral.onDangerContainer,
      moneyPositive: neutral.moneyPositive,
      moneyNegative: neutral.moneyNegative,
      moneyNeutral: neutral.moneyNeutral,
      appBackground: neutral.appBackground,
      glassTint: neutral.glassTint,
      glassBorder: neutral.glassBorder,
      glassBorderAndroid: neutral.glassBorderAndroid,
      glassFallback: neutral.glassFallback,
      flatSurface: neutral.flatSurface,
      flatSurfaceAlt: neutral.flatSurfaceAlt,
      flatBorder: neutral.flatBorder,
      divider: neutral.divider,
      skeleton: neutral.skeleton,
      overlay: neutral.overlay,
      backdrop: neutral.backdrop,
      pressed: neutral.pressed,
      pressHighlight: neutral.pressHighlight,
      muted: neutral.muted,
      chart,
    },
    spacing,
    radius,
    typography: scaleTypography(typography, fontScale),
    fontScale,
    reduceTransparency,
    reduceMotion,
    blob: {
      settled: neutral.blobSettled,
      balanced: accent.blobBalanced,
      debts: neutral.blobDebts,
    },
    accentId,
    scheme,
    surfaceStyle,
  };
};
