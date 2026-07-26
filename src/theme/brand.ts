/**
 * Fixed ManaSplit identity colors.
 *
 * These are intentionally separate from the user-selectable accent system.
 * Screens still consume semantic colors from useTheme(); these tokens are only
 * for the muggu mark and branded launch/loading moments.
 */
export const brand = {
  ink: '#3B1259',
  plum: '#2A0B40',
  deep: '#1B0730',
  gold: '#E8A13D',
  cream: '#FBF7F0',
  reversedGold: '#F5C15C',
  reversedInk: '#E9D5FF',
} as const;

export const mugguMotion = {
  cycleMs: 5500,
  bootGraceMs: 500,
  completeProgress: 0.8,
  fadeStartProgress: 0.91818,
} as const;

export type BrandTokens = typeof brand;
