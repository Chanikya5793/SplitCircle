import { useTheme } from '@/context/ThemeContext';
import React, { useEffect, useMemo, useState } from 'react';
import { Dimensions, InteractionManager, StyleSheet, View, ViewStyle } from 'react-native';
import Animated, {
    Easing,
    interpolateColor,
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withSequence,
    withTiming
} from 'react-native-reanimated';

const { width, height } = Dimensions.get('window');

export type HealthStatus = 'settled' | 'balanced' | 'debts';

interface LiquidBackgroundProps {
  children: React.ReactNode;
  style?: ViewStyle;
  healthStatus?: HealthStatus;
}

// Color palettes for different health statuses
const COLOR_PALETTES = {
  light: {
    settled: ['#84fab0', '#a8edea', '#b8f6e6'],
    balanced: ['#ff9a9e', '#fad0c4', '#a18cd1'],
    debts: ['#ff6b6b', '#ffa07a', '#ff7f50'],
  },
  dark: {
    settled: ['#00695C', '#00897B', '#26A69A'],
    balanced: ['#4527A0', '#283593', '#00695C'],
    debts: ['#B71C1C', '#C62828', '#D84315'],
  },
};

interface BlobProps {
  lightColor: string;
  darkColor: string;
  themeProgress: { value: number };
  size: number;
  initialX: number;
  initialY: number;
  animate: boolean;
}

const Blob = ({ lightColor, darkColor, themeProgress, size, initialX, initialY, animate }: BlobProps) => {
  const scaleSv = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  // Generate random animation parameters for more natural movement
  const durationX = 12000 + Math.random() * 6000;
  const durationY = 10000 + Math.random() * 8000;
  const durationScale = 9000 + Math.random() * 6000;

  const rangeX = 60 + Math.random() * 60;
  const rangeY = 60 + Math.random() * 60;

  useEffect(() => {
    // Don't start animations until the transition is complete.
    // This prevents 9+ concurrent reanimated animations from competing
    // with the navigation slide-in animation for GPU/CPU time.
    if (!animate) return;

    scaleSv.value = withRepeat(
      withSequence(
        withTiming(1.3, { duration: durationScale, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.8, { duration: durationScale, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: durationScale, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      true
    );

    translateX.value = withRepeat(
      withSequence(
        withTiming(rangeX, { duration: durationX, easing: Easing.inOut(Easing.quad) }),
        withTiming(-rangeX, { duration: durationX * 1.2, easing: Easing.inOut(Easing.quad) })
      ),
      -1,
      true
    );

    translateY.value = withRepeat(
      withSequence(
        withTiming(-rangeY, { duration: durationY, easing: Easing.inOut(Easing.quad) }),
        withTiming(rangeY, { duration: durationY * 1.1, easing: Easing.inOut(Easing.quad) })
      ),
      -1,
      true
    );
  }, [animate]);

  const animatedStyle = useAnimatedStyle(() => {
    const backgroundColor = interpolateColor(
      themeProgress.value,
      [0, 1],
      [lightColor, darkColor]
    );

    return {
      backgroundColor,
      left: initialX,
      top: initialY,
      transform: [
        { scale: scaleSv.value },
        { translateX: translateX.value },
        { translateY: translateY.value }
      ],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.blob,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
        },
        animatedStyle,
      ]}
    />
  );
};

export const LiquidBackground = ({ children, style, healthStatus = 'balanced' }: LiquidBackgroundProps) => {
  const { themeProgress, isDark } = useTheme();
  const [animate, setAnimate] = useState(false);

  // Defer blob animations until the navigation transition finishes.
  // Blobs render immediately as static colored circles (cheap), but their
  // movement animations only start after InteractionManager signals idle.
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setAnimate(true);
    });
    return () => task.cancel();
  }, []);

  // Memoize color selection based on health status
  const { lightBlobColors, darkBlobColors } = useMemo(() => ({
    lightBlobColors: COLOR_PALETTES.light[healthStatus],
    darkBlobColors: COLOR_PALETTES.dark[healthStatus],
  }), [healthStatus]);

  const containerStyle = useAnimatedStyle(() => {
    const backgroundColor = interpolateColor(
      themeProgress.value,
      [0, 1],
      ['#fdfbfb', '#121212']
    );
    return { backgroundColor };
  });

  return (
    <Animated.View style={[styles.container, containerStyle, style]}>
      <Blob
        lightColor={lightBlobColors[0]}
        darkColor={darkBlobColors[0]}
        themeProgress={themeProgress}
        size={300}
        initialX={-50}
        initialY={-50}
        animate={animate}
      />
      <Blob
        lightColor={lightBlobColors[1]}
        darkColor={darkBlobColors[1]}
        themeProgress={themeProgress}
        size={350}
        initialX={width - 200}
        initialY={height - 200}
        animate={animate}
      />
      <Blob
        lightColor={lightBlobColors[2]}
        darkColor={darkBlobColors[2]}
        themeProgress={themeProgress}
        size={250}
        initialX={-50}
        initialY={height / 2}
        animate={animate}
      />

      <View style={styles.content}>
        {children}
      </View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  content: {
    flex: 1,
    zIndex: 1,
  },
  blob: {
    position: 'absolute',
    opacity: 0.5,
  },
});
