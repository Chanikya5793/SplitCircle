import { useTheme } from '@/context/ThemeContext';
import { BlurView } from 'expo-blur';
import React from 'react';
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

interface GlassViewProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
}

export const GlassView = React.memo(({ children, style, intensity = 30 }: GlassViewProps) => {
  const { isDark, themeProgress } = useTheme();

  const animatedStyle = useAnimatedStyle(() => {
    const backgroundColor = interpolateColor(
      themeProgress.value,
      [0, 1],
      ['rgba(255, 255, 255, 0.01)', 'rgba(30, 30, 30, 0.15)']
    );

    const androidBackgroundColor = interpolateColor(
      themeProgress.value,
      [0, 1],
      ['rgba(255, 255, 255, 0.3)', 'rgba(30, 30, 30, 0.3)']
    );

    const borderColor = interpolateColor(
      themeProgress.value,
      [0, 1],
      ['rgba(255, 255, 255, 0.2)', 'rgba(255, 255, 255, 0.05)']
    );

    return {
      backgroundColor: Platform.OS === 'android' ? androidBackgroundColor : backgroundColor,
      borderColor,
    };
  });

  return (
    <Animated.View style={[
      styles.container,
      animatedStyle,
      style
    ]}>
      {Platform.OS === 'ios' && (
        <BlurView
          intensity={intensity}
          tint={isDark ? "dark" : "light"}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}
      <View style={styles.content}>
        {children}
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    borderWidth: 1,
    borderRadius: 20,
  },
  content: {
    // Ensure content is above the blur
    zIndex: 1,
  },
});
