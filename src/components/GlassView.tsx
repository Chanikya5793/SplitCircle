import { useTheme } from '@/context/ThemeContext';
import { BlurView } from 'expo-blur';
import React from 'react';
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

interface GlassViewProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  intensity?: number;
}

export const GlassView = React.memo(({ children, style, contentStyle, intensity = 30 }: GlassViewProps) => {
  const { isDark, themeProgress } = useTheme();

  const animatedStyle = useAnimatedStyle(() => {
    const backgroundColor = interpolateColor(
      themeProgress.value,
      [0, 1],
      ['rgba(255, 255, 255, 0.01)', 'rgba(30, 30, 30, 0.15)']
    );

    // Android can't render the BlurView, so the card sits directly on top of
    // the LiquidBackground blobs. A 30% alpha leaks the blob colors through
    // and makes labels hard to read — bump to a near-opaque tint that still
    // hints at the surface beneath.
    const androidBackgroundColor = interpolateColor(
      themeProgress.value,
      [0, 1],
      ['rgba(252, 252, 254, 0.86)', 'rgba(28, 30, 36, 0.86)']
    );

    const borderColor = interpolateColor(
      themeProgress.value,
      [0, 1],
      Platform.OS === 'android'
        ? ['rgba(15, 23, 42, 0.08)', 'rgba(255, 255, 255, 0.08)']
        : ['rgba(255, 255, 255, 0.2)', 'rgba(255, 255, 255, 0.05)']
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
      <View style={[styles.content, contentStyle]}>
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
