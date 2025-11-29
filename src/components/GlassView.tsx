import { useTheme } from '@/context/ThemeContext';
import { BlurView } from 'expo-blur';
import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

interface GlassViewProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
}

export const GlassView = ({ children, style, intensity = 50 }: GlassViewProps) => {
  const { isDark } = useTheme();

  return (
    <View style={[
      styles.container,
      isDark && styles.containerDark,
      style
    ]}>
      <BlurView
        intensity={intensity}
        tint={isDark ? "dark" : "light"}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.content}>
        {children}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    backgroundColor: 'rgba(255, 255, 255, 0.1)', // Semi-transparent white
    borderColor: 'rgba(255, 255, 255, 0.5)', // Light border
    borderWidth: 1,
    borderRadius: 20,
    // Shadow for depth
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 10,
    },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    elevation: 5,
  },
  containerDark: {
    backgroundColor: 'rgba(30, 30, 30, 0.4)', // Semi-transparent dark
    borderColor: 'rgba(255, 255, 255, 0.1)', // Faint border
    shadowOpacity: 0.3,
  },
  content: {
    // Ensure content is above the blur
    zIndex: 1,
  },
});
