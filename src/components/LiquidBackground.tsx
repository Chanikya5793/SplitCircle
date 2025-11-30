import { useTheme } from '@/context/ThemeContext';
import React, { useEffect } from 'react';
import { Dimensions, StyleSheet, View, ViewStyle } from 'react-native';
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

interface LiquidBackgroundProps {
  children: React.ReactNode;
  style?: ViewStyle;
}

const Blob = ({ lightColor, darkColor, themeProgress, size, initialX, initialY }: any) => {
  const scaleSv = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  // Generate random animation parameters for more natural movement
  // SLOWED DOWN: Increased durations significantly for a more relaxed feel
  const durationX = 12000 + Math.random() * 6000;
  const durationY = 10000 + Math.random() * 8000;
  const durationScale = 9000 + Math.random() * 6000;

  const rangeX = 60 + Math.random() * 60; // Move 60-120 units horizontally
  const rangeY = 60 + Math.random() * 60; // Move 60-120 units vertically

  useEffect(() => {
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
  }, []);

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

export const LiquidBackground = ({ children, style }: LiquidBackgroundProps) => {
  const { themeProgress } = useTheme();

  const lightBlobColors = ['#ff9a9e', '#fad0c4', '#a18cd1', '#84fab0'];
  const darkBlobColors = ['#4527A0', '#283593', '#00695C', '#C62828'];

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
      />
      <Blob
        lightColor={lightBlobColors[1]}
        darkColor={darkBlobColors[1]}
        themeProgress={themeProgress}
        size={350}
        initialX={width - 200}
        initialY={height - 200}
      />
      <Blob
        lightColor={lightBlobColors[2]}
        darkColor={darkBlobColors[2]}
        themeProgress={themeProgress}
        size={250}
        initialX={-50}
        initialY={height / 2}
      />
      <Blob
        lightColor={lightBlobColors[3]}
        darkColor={darkBlobColors[3]}
        themeProgress={themeProgress}
        size={200}
        initialX={width - 100}
        initialY={100}
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
    overflow: 'hidden', // Clip blobs that go outside
  },
  content: {
    flex: 1,
    zIndex: 1,
  },
  blob: {
    position: 'absolute',
    opacity: 0.6,
  },
});
