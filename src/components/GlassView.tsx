import { useTheme } from '@/context/ThemeContext';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

interface GlassViewProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
}

export const GlassView = ({ children, style, intensity = 50 }: GlassViewProps) => {
  const { isDark } = useTheme();

  const isIOS = Platform.OS === 'ios';
  // Use 'systemUltraThinMaterial' for the most transparent, "liquid" glass look on iOS
  const tint = isIOS ? 'systemUltraThinMaterial' : (isDark ? 'dark' : 'light');

  return (
    <View style={[
      styles.container,
      isIOS ? styles.containerIOS : (isDark ? styles.containerDark : styles.containerLight),
      style
    ]}>
      <BlurView
        intensity={intensity}
        tint={tint}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {/* Subtle gradient overlay for "sheen" */}
      <LinearGradient
        colors={isDark
          ? ['rgba(255,255,255,0.15)', 'rgba(255,255,255,0.05)', 'rgba(255,255,255,0)']
          : ['rgba(255,255,255,0.6)', 'rgba(255,255,255,0.2)', 'rgba(255,255,255,0.1)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
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
    borderColor: 'rgba(255, 255, 255, 0.2)',
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
  containerIOS: {
    backgroundColor: 'transparent',
    borderColor: 'rgba(255, 255, 255, 0.2)', // Slightly stronger border for definition
    borderWidth: 0.5,
  },
  containerLight: {
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
    borderColor: 'rgba(255, 255, 255, 0.5)',
  },
  containerDark: {
    backgroundColor: 'rgba(30, 30, 30, 0.6)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    shadowOpacity: 0.3,
  },
  content: {
    zIndex: 1,
  },
});
