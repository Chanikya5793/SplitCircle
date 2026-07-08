// Circular liquid-glass back button — the one back affordance for screens
// that hide the navigation header. Constant full alpha, so the native glass
// material renders reliably (never wrap it in an animated-opacity parent).

import { useTheme } from '@/context/ThemeContext';
import { lightHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import React from 'react';
import { StyleProp, StyleSheet, TouchableOpacity, ViewStyle } from 'react-native';
import { GlassCard } from './GlassCard';

export interface GlassBackButtonProps {
  onPress?: () => void;
  /** Diameter. Defaults to 40. */
  size?: number;
  /** Force a light glyph (media viewers over dark content). */
  lightContent?: boolean;
  style?: StyleProp<ViewStyle>;
}

export const GlassBackButton = ({ onPress, size = 40, lightContent, style }: GlassBackButtonProps) => {
  const { theme } = useTheme();
  const navigation = useNavigation();

  const handlePress = () => {
    lightHaptic();
    if (onPress) onPress();
    else if (navigation.canGoBack()) navigation.goBack();
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      activeOpacity={0.75}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Go back"
      style={style}
    >
      <GlassCard radius={size / 2} style={{ width: size, height: size }} contentStyle={styles.content}>
        <Ionicons
          name="chevron-back"
          size={size * 0.55}
          color={lightContent ? '#fff' : theme.colors.onSurface}
          style={styles.glyph}
        />
      </GlassCard>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Optical centering — the chevron glyph leans right inside its box.
  glyph: {
    marginLeft: -2,
  },
});
