import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper';
import { ACCENTS, CHART_BASE, NEUTRALS, type AccentId } from './palette';
import { radius, spacing, typography, type Radius, type Spacing, type Typography } from './tokens';

export type ColorScheme = 'light' | 'dark';

/** Semantic colors layered on top of the Paper MD3 roles. */
export interface SemanticColors {
  success: string;
  onSuccess: string;
  successContainer: string;
  onSuccessContainer: string;
  warning: string;
  onWarning: string;
  warningContainer: string;
  onWarningContainer: string;
  danger: string;
  onDanger: string;
  dangerContainer: string;
  onDangerContainer: string;
  moneyPositive: string;
  moneyNegative: string;
  moneyNeutral: string;
  appBackground: string;
  glassTint: string;
  glassBorder: string;
  glassBorderAndroid: string;
  glassFallback: string;
  skeleton: string;
  muted: string;
  chart: string[];
}

export interface BlobPalettes {
  settled: [string, string, string];
  balanced: [string, string, string];
  debts: [string, string, string];
}

export interface AppTheme extends MD3Theme {
  colors: MD3Theme['colors'] & SemanticColors;
  spacing: Spacing;
  radius: Radius;
  typography: Typography;
  blob: BlobPalettes;
  accentId: AccentId;
  scheme: ColorScheme;
}

export const buildTheme = (scheme: ColorScheme, accentId: AccentId): AppTheme => {
  const base = scheme === 'dark' ? MD3DarkTheme : MD3LightTheme;
  const accent = ACCENTS[accentId][scheme];
  const neutral = NEUTRALS[scheme];
  const chart: string[] = [...CHART_BASE[scheme]];
  chart[0] = accent.primary;

  return {
    ...base,
    roundness: 12,
    colors: {
      ...base.colors,
      primary: accent.primary,
      onPrimary: accent.onPrimary,
      primaryContainer: accent.primaryContainer,
      onPrimaryContainer: accent.onPrimaryContainer,
      secondary: accent.secondary,
      surface: neutral.surface,
      // Kept transparent so the LiquidBackground blobs show through Paper
      // surfaces that inherit `background` — long-standing app DNA.
      background: 'transparent',
      error: neutral.danger,
      onError: neutral.onDanger,
      errorContainer: neutral.dangerContainer,
      onErrorContainer: neutral.onDangerContainer,
      outline: neutral.border,

      success: neutral.success,
      onSuccess: neutral.onSuccess,
      successContainer: neutral.successContainer,
      onSuccessContainer: neutral.onSuccessContainer,
      warning: neutral.warning,
      onWarning: neutral.onWarning,
      warningContainer: neutral.warningContainer,
      onWarningContainer: neutral.onWarningContainer,
      danger: neutral.danger,
      onDanger: neutral.onDanger,
      dangerContainer: neutral.dangerContainer,
      onDangerContainer: neutral.onDangerContainer,
      moneyPositive: neutral.moneyPositive,
      moneyNegative: neutral.moneyNegative,
      moneyNeutral: neutral.moneyNeutral,
      appBackground: neutral.appBackground,
      glassTint: neutral.glassTint,
      glassBorder: neutral.glassBorder,
      glassBorderAndroid: neutral.glassBorderAndroid,
      glassFallback: neutral.glassFallback,
      skeleton: neutral.skeleton,
      muted: neutral.muted,
      chart,
    },
    spacing,
    radius,
    typography,
    blob: {
      settled: neutral.blobSettled,
      balanced: accent.blobBalanced,
      debts: neutral.blobDebts,
    },
    accentId,
    scheme,
  };
};
