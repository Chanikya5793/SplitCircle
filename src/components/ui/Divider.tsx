// Themed wrapper for react-native-paper's Divider.
//
// HISTORY (read before changing this again): this briefly rendered `null` when
// surfaceStyle === 'flat', as part of a "zero dividers anywhere" direction
// (2026-08-07). That was reversed the same day — "there are no dividers
// whatsoever" turned out to be a complaint, not the goal. Dividers now render
// in BOTH surface modes, always.
//
// The wrapper is kept rather than reverting call sites back to bare
// `react-native-paper` imports, because it is the one place that can tune
// divider appearance app-wide (~50 call sites across 11 files route through
// it). It pulls its color from `theme.colors.divider` — the app's own
// semantic token — instead of Paper's MD3 default, which is derived from a
// stock Material-You palette this app doesn't otherwise use.

import { useTheme } from '@/context/ThemeContext';
import type { ComponentProps } from 'react';
import { Divider as PaperDivider } from 'react-native-paper';

export type DividerProps = ComponentProps<typeof PaperDivider>;

export const Divider = ({ style, ...props }: DividerProps) => {
  const { theme } = useTheme();
  // Defensive `?.`: several component tests mock useTheme() with a partial
  // theme, and a missing token must fall back to Paper's own default rather
  // than crash or render an invisible divider.
  const color = theme?.colors?.divider;
  return <PaperDivider {...props} style={[color ? { backgroundColor: color } : null, style]} />;
};
