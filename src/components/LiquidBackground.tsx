import { useTheme } from '@/context/ThemeContext';
import React from 'react';
import { Dimensions, StyleSheet, View, ViewStyle } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle
} from 'react-native-reanimated';

const { width, height } = Dimensions.get('window');

interface LiquidBackgroundProps {
  children: React.ReactNode;
  style?: ViewStyle;
}

const Blob = ({ lightColor, darkColor, themeProgress, size, initialX, initialY }: any) => {
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
      transform: [{ scale: 1 }], // Static scale
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
