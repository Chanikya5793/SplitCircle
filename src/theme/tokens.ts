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

export const animation = {
  /** Theme crossfade duration (ThemeContext.themeProgress). */
  themeTransitionMs: 500,
  /** Standard micro-interaction duration. */
  quickMs: 200,
} as const;

export type Spacing = typeof spacing;
export type Radius = typeof radius;
export type Typography = typeof typography;
