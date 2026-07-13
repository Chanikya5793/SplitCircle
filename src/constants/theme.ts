// DEPRECATED compat layer — the real design system lives in src/theme/.
// These exports keep legacy imports compiling while screens migrate to
// useTheme() tokens (see DESIGN.md). Do not add new imports of this file.

import { buildTheme, DEFAULT_ACCENT } from '@/theme';

export { spacing } from '@/theme';

/** @deprecated Use useTheme().theme.colors — this is the light palette only. */
export const colors = {
  primary: '#1F6FEB',
  secondary: '#FFAD05',
  success: '#2BB673',
  danger: '#E03C31',
  surface: '#FFFFFF',
  muted: '#94A3B8',
  background: '#F3F4F6',
  border: '#E2E8F0',
  text: '#1F2937',
};

/** @deprecated Use useTheme().theme.colors. */
export const darkColors = {
  primary: '#58A6FF',
  secondary: '#FFD369',
  success: '#4ADE80',
  danger: '#F87171',
  surface: '#1E1E1E',
  muted: '#9CA3AF',
  background: '#121212',
  border: '#374151',
  text: '#F3F4F6',
};

export const lightTheme = buildTheme('light', DEFAULT_ACCENT);
export const darkTheme = buildTheme('dark', DEFAULT_ACCENT);

/** @deprecated Never import a static theme — it ignores dark mode and accent. */
export const theme = lightTheme;
