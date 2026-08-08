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

export const animation = {
  /** Theme crossfade duration (ThemeContext.themeProgress). */
  themeTransitionMs: 500,
  /** Standard micro-interaction duration. */
  quickMs: 200,
} as const;

export type Spacing = typeof spacing;
export type Radius = typeof radius;
export type Typography = typeof typography;
