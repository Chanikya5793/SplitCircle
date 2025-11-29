import { MD3DarkTheme, MD3LightTheme } from 'react-native-paper';

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

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const lightTheme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: colors.primary,
    secondary: colors.secondary,
    surface: colors.surface,
    background: 'transparent',
    error: colors.danger,
  },
  roundness: 12,
};

export const darkTheme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: darkColors.primary,
    secondary: darkColors.secondary,
    surface: darkColors.surface,
    background: 'transparent',
    error: darkColors.danger,
  },
  roundness: 12,
};

export const theme = lightTheme; // Default for now
