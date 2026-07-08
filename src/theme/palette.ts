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
    appBackground: '#FDFBFB',
    surface: '#FFFFFF',
    text: '#1F2937',
    muted: '#64748B',
    border: '#E2E8F0',
    success: '#059669',
    onSuccess: '#FFFFFF',
    successContainer: '#D1FAE5',
    onSuccessContainer: '#065F46',
    warning: '#D97706',
    onWarning: '#FFFFFF',
    warningContainer: '#FEF3C7',
    onWarningContainer: '#92400E',
    danger: '#E03C31',
    onDanger: '#FFFFFF',
    dangerContainer: '#FBE0DE',
    onDangerContainer: '#7A1610',
    moneyPositive: '#059669',
    moneyNegative: '#DC2626',
    moneyNeutral: '#64748B',
    glassTint: 'rgba(255, 255, 255, 0.01)',
    glassBorder: 'rgba(255, 255, 255, 0.2)',
    glassBorderAndroid: 'rgba(15, 23, 42, 0.08)',
    glassFallback: 'rgba(252, 252, 254, 0.86)',
    skeleton: 'rgba(15, 23, 42, 0.08)',
    blobSettled: ['#84fab0', '#a8edea', '#b8f6e6'] as [string, string, string],
    blobDebts: ['#ff6b6b', '#ffa07a', '#ff7f50'] as [string, string, string],
  },
  dark: {
    appBackground: '#121212',
    surface: '#1E1E1E',
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
    glassFallback: 'rgba(28, 30, 36, 0.86)',
    skeleton: 'rgba(255, 255, 255, 0.10)',
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
