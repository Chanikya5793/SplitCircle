// Themed wrapper for react-native-paper's Divider — the one primitive for
// "zero dividers between list items" in flat mode (2026-08-07, compact/
// no-dividers pass). Renders nothing when surfaceStyle === 'flat': row-to-row
// separation there comes from spacing alone, same as every other flat
// surface in the app (GlassCard's borderless section, SettingsScreen's own
// divider). Glass mode is untouched — renders the real Divider exactly as
// shipped, so this is additive, not a behavior change for the default UI.
//
// Same "one primitive" lever as GlassCard: ~50+ call sites across the app
// import bare `Divider` from react-native-paper directly, so fixing this here
// (and swapping those imports to this file) beats hand-editing every site.

import { useTheme } from '@/context/ThemeContext';
import type { ComponentProps } from 'react';
import { Divider as PaperDivider } from 'react-native-paper';

export type DividerProps = ComponentProps<typeof PaperDivider>;

export const Divider = (props: DividerProps) => {
  const { theme } = useTheme();
  // Defensive `?.`, not an assertion: several component tests mock
  // useTheme() with a partial theme object — undefined must mean glass
  // (render the divider), matching GlassCard's own convention.
  if (theme?.surfaceStyle === 'flat') return null;
  return <PaperDivider {...props} />;
};
