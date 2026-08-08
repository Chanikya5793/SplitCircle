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

/**
 * How far every divider stops short of each edge.
 *
 * A hairline that runs the full width of the screen doesn't read as structure,
 * it reads as a crack across the glass — the darker `divider` token this app
 * moved to (0.20/0.22 alpha, so the lines are actually visible) made that much
 * worse, because a barely-there line can get away with being full-bleed and a
 * visible one cannot. Stopping short on BOTH ends is what makes it read as a
 * separator between rows instead of a split down the middle of the screen.
 *
 * Shared with ListSeparator so the two never drift apart.
 */
export const DIVIDER_INSET = 16;

export interface DividerProps extends ComponentProps<typeof PaperDivider> {
  /** Horizontal inset in points. Pass 0 for a deliberately full-bleed rule. */
  inset?: number;
}

export const Divider = ({ style, inset = DIVIDER_INSET, ...props }: DividerProps) => {
  const { theme } = useTheme();
  // Defensive `?.`: several component tests mock useTheme() with a partial
  // theme, and a missing token must fall back to Paper's own default rather
  // than crash or render an invisible divider.
  const color = theme?.colors?.divider;
  return (
    <PaperDivider
      {...props}
      // `style` last: a call site that sets its own margins still wins.
      style={[{ marginHorizontal: inset }, color ? { backgroundColor: color } : null, style]}
    />
  );
};
