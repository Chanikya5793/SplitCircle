// Uppercase section header used across list screens (Friends, Settings,
// Group activity, etc.) — one component instead of per-screen restyles.

import { useTheme } from '@/context/ThemeContext';
import React from 'react';
import { StyleProp, TextStyle } from 'react-native';
import { Text } from 'react-native-paper';

export interface SectionLabelProps {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
}

export const SectionLabel = ({ children, style }: SectionLabelProps) => {
  const { theme } = useTheme();
  return (
    <Text
      style={[
        {
          color: theme.colors.muted,
          fontSize: theme.typography.label.fontSize,
          fontWeight: theme.typography.label.fontWeight,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          marginHorizontal: theme.spacing.md,
          marginTop: theme.spacing.lg,
          marginBottom: theme.spacing.sm,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
};
