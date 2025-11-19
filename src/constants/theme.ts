import { MD3LightTheme } from 'react-native-paper';

export const colors = {
  primary: '#1F6FEB',
  secondary: '#FFAD05',
  success: '#2BB673',
  danger: '#E03C31',
  surface: '#FFFFFF',
  muted: '#94A3B8',
  background: '#F3F4F6',
  border: '#E2E8F0',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const theme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: colors.primary,
    secondary: colors.secondary,
    surface: colors.surface,
    background: colors.background,
    error: colors.danger,
  },
  roundness: 12,
};
