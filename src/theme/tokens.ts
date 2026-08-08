// Non-color design tokens. Screens consume these via useTheme().theme —
// never as literals. Adding a step? Update DESIGN.md.

import type { TextStyle } from 'react-native';

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  pill: 999,
} as const;

/**
 * Surface treatment for every bounded content surface in the app.
 *   'glass' — the liquid-glass DNA (blur/native material, floats over blobs)
 *   'flat'  — opaque fill, hairline edge, calmer radii, no blur or elevation
 * User-selectable and persisted alongside mode/accent (see ThemeContext).
 */
export type SurfaceStyle = 'glass' | 'flat';

/**
 * Corner radii used when surfaceStyle is 'flat'. Flattening pulls the scale in:
 * a 20pt pill-ish card reads as decoration, a 12pt one reads as structure.
 * `pill` stays 999 — circular controls stay circular in both modes.
 */
export const flatRadius = {
  xs: 6,
  sm: 8,
  md: 10,
  lg: 12,
  xl: 16,
  pill: 999,
} as const;

export interface TypeToken {
  fontSize: number;
  lineHeight: number;
  fontWeight: TextStyle['fontWeight'];
}

export const typography: Record<
  'display' | 'headline' | 'title' | 'subtitle' | 'body' | 'caption' | 'label',
  TypeToken
> = {
  display: { fontSize: 34, lineHeight: 41, fontWeight: '700' },
  headline: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title: { fontSize: 20, lineHeight: 25, fontWeight: '600' },
  subtitle: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  label: { fontSize: 11, lineHeight: 14, fontWeight: '600' },
};

/**
 * Scales a type ramp for the OS text size.
 *
 * WHY THIS IS NEEDED: React Native multiplies `fontSize` by the OS font scale
 * automatically, but leaves `lineHeight` exactly as written. A token pairing
 * `fontSize: 20` with `lineHeight: 25` therefore becomes 40pt glyphs crammed
 * into a 25pt line at a 2× accessibility size — the text is clipped, and
 * descenders go first (which is why "Budget" rendered as "Budaet" on a device
 * at an AX size, 2026-08-07).
 *
 * `fontSize` is deliberately left ALONE here — RN already scales it, and
 * pre-multiplying would apply the scale twice.
 */
export const scaleTypography = (base: Typography, fontScale: number): Typography => {
  if (!Number.isFinite(fontScale) || fontScale <= 1) return base;
  const out = {} as Typography;
  for (const key of Object.keys(base) as (keyof Typography)[]) {
    const t = base[key];
    out[key] = { ...t, lineHeight: Math.round(t.lineHeight * fontScale) };
  }
  return out;
};

/**
 * The same lineHeight scaling, applied to react-native-paper's own MD3 `fonts`
 * variants (displayLarge, bodyMedium, labelSmall, …).
 *
 * `scaleTypography` above only fixes the app's OWN typography object, which is
 * a fraction of the text on screen — every `<Text variant="…">` reads its size
 * from Paper's theme instead, and those carry hardcoded lineHeights (52 for
 * displayMedium, and so on). RN scales `fontSize` by the OS text scale but
 * leaves an explicit `lineHeight` exactly as written, so past about 2× the
 * glyphs are taller than their line box and get clipped. At iOS's largest
 * accessibility size (3.571×) "Welcome back" rendered as a row of disconnected
 * ink fragments — only the top slivers of each letter survived. Verified on an
 * iPhone 17 Pro simulator running iOS 27.
 */
/**
 * Display and headline variants stop growing here.
 *
 * This is NOT a cap reached for to make something fit — it mirrors what Apple's
 * own Dynamic Type curve does. iOS scales the big text styles far less than the
 * small ones: from Large to AX5, `largeTitle` goes 34pt → 53pt (1.56×) and
 * `title1` 28 → 44 (1.57×), while `body` goes 17 → 53 (3.1×). React Native
 * instead applies ONE flat multiplier to everything (RCTAccessibilityManager),
 * so at 3.571× a screen title rendered at three and a half times its size and
 * "Welcome back" alone filled an entire iPhone screen, broken as "Welco / me".
 *
 * Body, title and label variants stay uncapped — that is the accessibility win
 * and it must not be traded away.
 */
const DISPLAY_SCALE_CAP = 1.6;

const isCappedVariant = (key: string) =>
  key.startsWith('display') || key.startsWith('headline');

export const scalePaperFonts = <T extends Record<string, unknown>>(
  fonts: T,
  fontScale: number,
): T => {
  if (!Number.isFinite(fontScale) || fontScale <= 1) return fonts;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fonts)) {
    const variant = value as { lineHeight?: unknown; fontSize?: unknown };
    if (!variant || typeof variant !== 'object' || typeof variant.lineHeight !== 'number') {
      out[key] = value;
      continue;
    }
    const capped = isCappedVariant(key) ? Math.min(fontScale, DISPLAY_SCALE_CAP) : fontScale;
    // RN multiplies fontSize by the OS scale at render time but leaves an
    // explicit lineHeight alone. So lineHeight takes the effective scale
    // directly, while fontSize is pre-divided to land on it after RN's own
    // multiply — dividing is the only way to scale a font DOWN from here.
    const next: Record<string, unknown> = {
      ...variant,
      lineHeight: Math.round(variant.lineHeight * capped),
    };
    if (capped !== fontScale && typeof variant.fontSize === 'number') {
      next.fontSize = Math.round((variant.fontSize * capped) / fontScale);
    }
    out[key] = next;
  }
  return out as T;
};

export const animation = {
  /** Theme crossfade duration (ThemeContext.themeProgress). */
  themeTransitionMs: 500,
  /** Standard micro-interaction duration. */
  quickMs: 200,
} as const;

export type Spacing = typeof spacing;
export type Radius = typeof radius;
export type Typography = typeof typography;
