// Raw color values for the design system. No logic here — buildTheme.ts
// assembles these into the runtime AppTheme. Screens must never import this
// file directly; they consume resolved tokens via useTheme().

export type AccentId = 'ocean' | 'violet' | 'emerald' | 'sunset' | 'rose' | 'mono';

export interface AccentScheme {
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  secondary: string;
  /** Trio used by LiquidBackground's neutral "balanced" state so the ambient
   *  blobs follow the user's accent instead of the old pink/purple palette. */
  blobBalanced: [string, string, string];
}

export interface AccentDefinition {
  id: AccentId;
  label: string;
  light: AccentScheme;
  dark: AccentScheme;
}

export const ACCENTS: Record<AccentId, AccentDefinition> = {
  ocean: {
    id: 'ocean',
    label: 'Ocean',
    light: {
      primary: '#1F6FEB',
      onPrimary: '#FFFFFF',
      primaryContainer: '#D8E6FD',
      onPrimaryContainer: '#0A2E66',
      secondary: '#FFAD05',
      blobBalanced: ['#a5c8ff', '#c4e0f9', '#9bb8f0'],
    },
    dark: {
      primary: '#58A6FF',
      onPrimary: '#0B2447',
      primaryContainer: '#173B66',
      onPrimaryContainer: '#C7DDFF',
      secondary: '#FFD369',
      blobBalanced: ['#173B66', '#1C2E58', '#0F4C75'],
    },
  },
  violet: {
    id: 'violet',
    label: 'Violet',
    light: {
      primary: '#7C3AED',
      onPrimary: '#FFFFFF',
      primaryContainer: '#EADDFC',
      onPrimaryContainer: '#3B1477',
      secondary: '#F59E0B',
      blobBalanced: ['#d0b3ff', '#e3d1fc', '#b79aef'],
    },
    dark: {
      primary: '#A78BFA',
      onPrimary: '#241056',
      primaryContainer: '#432C7A',
      onPrimaryContainer: '#E4D7FF',
      secondary: '#FBBF24',
      blobBalanced: ['#432C7A', '#33245E', '#4527A0'],
    },
  },
  emerald: {
    id: 'emerald',
    label: 'Emerald',
    light: {
      primary: '#059669',
      onPrimary: '#FFFFFF',
      primaryContainer: '#CFF5E7',
      onPrimaryContainer: '#054D37',
      secondary: '#0EA5E9',
      blobBalanced: ['#9df0cf', '#c8f2e4', '#7fe0c0'],
    },
    dark: {
      primary: '#34D399',
      onPrimary: '#052E22',
      primaryContainer: '#0B4A37',
      onPrimaryContainer: '#BDF5DF',
      secondary: '#38BDF8',
      blobBalanced: ['#0B4A37', '#0A3A3A', '#14532D'],
    },
  },
  sunset: {
    id: 'sunset',
    label: 'Sunset',
    light: {
      primary: '#EA580C',
      onPrimary: '#FFFFFF',
      primaryContainer: '#FDE3D2',
      onPrimaryContainer: '#79300A',
      secondary: '#0D9488',
      blobBalanced: ['#ffc9a3', '#ffe1c9', '#f5b083'],
    },
    dark: {
      primary: '#FB923C',
      onPrimary: '#4A1F03',
      primaryContainer: '#6E3410',
      onPrimaryContainer: '#FFE0C7',
      secondary: '#2DD4BF',
      blobBalanced: ['#6E3410', '#5C2E0E', '#7C2D12'],
    },
  },
  rose: {
    id: 'rose',
    label: 'Rose',
    light: {
      primary: '#E11D48',
      onPrimary: '#FFFFFF',
      primaryContainer: '#FBDCE3',
      onPrimaryContainer: '#750A24',
      secondary: '#8B5CF6',
      blobBalanced: ['#ffb3c4', '#ffd6df', '#f79ab3'],
    },
    dark: {
      primary: '#FB7185',
      onPrimary: '#4C0519',
      primaryContainer: '#6B1130',
      onPrimaryContainer: '#FFD3DC',
      secondary: '#A78BFA',
      blobBalanced: ['#6B1130', '#581C3C', '#7F1D3A'],
    },
  },
  mono: {
    id: 'mono',
    label: 'Mono',
    light: {
      primary: '#334155',
      onPrimary: '#FFFFFF',
      primaryContainer: '#E2E8F0',
      onPrimaryContainer: '#111827',
      secondary: '#64748B',
      blobBalanced: ['#cbd5e1', '#e2e8f0', '#b6c2d2'],
    },
    dark: {
      primary: '#CBD5E1',
      onPrimary: '#111827',
      primaryContainer: '#374151',
      onPrimaryContainer: '#F1F5F9',
      secondary: '#94A3B8',
      blobBalanced: ['#374151', '#2B3444', '#1F2937'],
    },
  },
};

export const ACCENT_IDS = Object.keys(ACCENTS) as AccentId[];
export const DEFAULT_ACCENT: AccentId = 'ocean';

/** Neutral (non-accent) colors per scheme. appBackground preserves the app's
 *  existing backdrop DNA — it replaces every '#FDFBFB'/'#121212' literal. */
export const NEUTRALS = {
  light: {
    // Brighter, cooler near-white backdrop (was warm '#FDFBFB'). The cool hint
    // reads airier and lets the ambient blobs pop instead of muddying into a
    // beige wash. Text tokens below still clear WCAG AA on this brighter base.
    appBackground: '#F9FBFF',
    surface: '#FFFFFF',
    text: '#1F2937',
    // Darkened from '#64748B' (2026-08-06). The old value was only 4.59:1 on
    // appBackground — right on the WCAG AA line before anything is layered
    // over it, and under it on any tinted solid background. Glass mode was
    // masking this; borderless flat mode has no material left to mask it.
    muted: '#5A6675',
    border: '#E2E8F0',
    // Darkened 2026-08-07 for WCAG AA, same pass as the money tokens. All three
    // failed in light mode in BOTH directions — as text on the canvas, and as a
    // fill under white `on*` text:
    //   success #059669  text 3.33-3.77  white-on-fill 3.77
    //   warning #D97706  text 2.82-3.19  white-on-fill 3.19
    //   danger  #E03C31  text 3.82-4.32  white-on-fill 4.32
    // `danger` mattered most: it is used as a TEXT colour in 24 places (error
    // messages, destructive labels) and as a background in none.
    // Hue preserved; darkened until the worst shipped background ('ink',
    // #EEF1F7) clears 4.6:1. Dark scheme already passed and is unchanged.
    // `success` is set to moneyPositive's exact value — they were identical
    // before and read as the same green side by side.
    success: '#047C57',
    onSuccess: '#FFFFFF',
    successContainer: '#D1FAE5',
    onSuccessContainer: '#065F46',
    warning: '#A45A05',
    onWarning: '#FFFFFF',
    warningContainer: '#FEF3C7',
    onWarningContainer: '#92400E',
    danger: '#D02A1F',
    onDanger: '#FFFFFF',
    dangerContainer: '#FBE0DE',
    onDangerContainer: '#7A1610',
    // Darkened 2026-08-07 for WCAG AA. Row-level money amounts are 15px — normal
    // text, so they need 4.5:1, not the 3:1 large-text allowance the 28px hero
    // figure gets. The old values failed across the board in light mode:
    // moneyPositive was 3.64:1 on appBackground and 3.33:1 on the darkest solid
    // preset, i.e. it never passed anywhere, glass or flat. Hue is preserved —
    // these are the same green/red, darkened until the worst shipped background
    // ('ink', #EEF1F7) clears 4.6:1.
    //   moneyPositive #059669 -> 3.33-3.77  |  #047C57 -> 4.61-5.22
    //   moneyNegative #DC2626 -> 4.27-4.83  |  #D32222 -> 4.62-5.22
    //   moneyNeutral  #64748B -> 4.21-4.76  |  #5A6675 -> 5.17-5.85 (= muted)
    // Guarded by moneyContrast in solidBackgroundContrast.test.ts.
    moneyPositive: '#047C57',
    moneyNegative: '#D32222',
    moneyNeutral: '#5A6675',
    // Brighter glass: a higher-alpha white lift under the blur/liquid material
    // (was a near-invisible 0.01) so light-mode surfaces read luminous and airy
    // rather than dim. Border gets a crisper white rim to match.
    glassTint: 'rgba(255, 255, 255, 0.18)',
    glassBorder: 'rgba(255, 255, 255, 0.35)',
    glassBorderAndroid: 'rgba(15, 23, 42, 0.08)',
    glassFallback: 'rgba(255, 255, 255, 0.9)',
    // Flat surface treatment (surfaceStyle === 'flat'). OPAQUE by design: the
    // glass material is doing legibility work over the ambient blobs, and a
    // translucent flat fill would inherit the blob contrast failure instead of
    // fixing it (muted text hits 2.92:1 over the worst blob — below AA).
    flatSurface: '#FFFFFF',
    // Second level, for a surface that must sit ON a flatSurface (nested rows,
    // inputs) without a border doing the separating.
    flatSurfaceAlt: '#F1F5F9',
    flatBorder: 'rgba(15, 23, 42, 0.10)',
    divider: 'rgba(15, 23, 42, 0.08)',
    skeleton: 'rgba(15, 23, 42, 0.08)',
    // Semantic scrims/fills so screens stop hand-rolling rgba(0,0,0,x) literals.
    // overlay: full modal backdrop · backdrop: subtle content scrim ·
    // pressed: neutral interactive/divider fill.
    overlay: 'rgba(0, 0, 0, 0.5)',
    backdrop: 'rgba(0, 0, 0, 0.08)',
    pressed: 'rgba(0, 0, 0, 0.05)',
    blobSettled: ['#84fab0', '#a8edea', '#b8f6e6'] as [string, string, string],
    blobDebts: ['#ff6b6b', '#ffa07a', '#ff7f50'] as [string, string, string],
  },
  dark: {
    appBackground: '#121212',
    // Lift the raised surface a touch off the near-black backdrop (was
    // '#1E1E1E') so dark-mode cards stop reading muddy — still a deep charcoal,
    // not gray, and it keeps clear separation from appBackground.
    surface: '#242427',
    text: '#F3F4F6',
    muted: '#9CA3AF',
    border: '#374151',
    success: '#34D399',
    onSuccess: '#06281D',
    successContainer: '#064E3B',
    onSuccessContainer: '#A7F3D0',
    warning: '#FBBF24',
    onWarning: '#3A2A05',
    warningContainer: '#78350F',
    onWarningContainer: '#FDE68A',
    danger: '#F87171',
    onDanger: '#450A0A',
    dangerContainer: '#7F1D1D',
    onDangerContainer: '#FECACA',
    moneyPositive: '#34D399',
    moneyNegative: '#F87171',
    moneyNeutral: '#9CA3AF',
    glassTint: 'rgba(30, 30, 30, 0.15)',
    glassBorder: 'rgba(255, 255, 255, 0.05)',
    glassBorderAndroid: 'rgba(255, 255, 255, 0.08)',
    // Nudged up in step with the lifted dark surface so Android dark cards match
    // (was 'rgba(28, 30, 36, 0.86)') — still deep, avoids the muddy look.
    glassFallback: 'rgba(36, 36, 40, 0.86)',
    // Flat surface treatment — see the light-scheme note above. Sits just off
    // appBackground (#121212) so a group reads as structure without a border.
    flatSurface: '#1C1C1F',
    flatSurfaceAlt: '#252529',
    flatBorder: 'rgba(255, 255, 255, 0.10)',
    divider: 'rgba(255, 255, 255, 0.08)',
    skeleton: 'rgba(255, 255, 255, 0.10)',
    // Semantic scrims/fills so screens stop hand-rolling rgba(0,0,0,x) literals.
    // overlay: full modal backdrop · backdrop: subtle content scrim ·
    // pressed: neutral interactive/divider fill.
    overlay: 'rgba(0, 0, 0, 0.6)',
    backdrop: 'rgba(0, 0, 0, 0.25)',
    pressed: 'rgba(255, 255, 255, 0.08)',
    blobSettled: ['#00695C', '#00897B', '#26A69A'] as [string, string, string],
    blobDebts: ['#B71C1C', '#C62828', '#D84315'] as [string, string, string],
  },
} as const;

/** Theme-aware categorical palette for charts. Slot 0 is filled with the
 *  accent primary at build time so charts always lead with the user's accent. */
export const CHART_BASE = {
  light: ['#1F6FEB', '#0D9488', '#D97706', '#7C3AED', '#E11D48', '#059669', '#DB2777', '#64748B'],
  dark: ['#58A6FF', '#2DD4BF', '#FBBF24', '#A78BFA', '#FB7185', '#34D399', '#F472B6', '#94A3B8'],
} as const;
