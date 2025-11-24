import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect } from 'react';
import { StyleSheet, View, ViewStyle, Dimensions } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
} from 'react-native-reanimated';

const { width, height } = Dimensions.get('window');

interface LiquidBackgroundProps {
  children: React.ReactNode;
  style?: ViewStyle;
}

const Blob = ({ color, size, initialX, initialY, duration, delay }: any) => {
  const translateX = useSharedValue(initialX);
  const translateY = useSharedValue(initialY);
  const scale = useSharedValue(1);

  useEffect(() => {
    translateX.value = withRepeat(
      withSequence(
        withTiming(initialX + 50, { duration: duration, easing: Easing.inOut(Easing.ease) }),
        withTiming(initialX - 50, { duration: duration, easing: Easing.inOut(Easing.ease) }),
        withTiming(initialX, { duration: duration, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      true
    );

    translateY.value = withRepeat(
      withSequence(
        withTiming(initialY - 50, { duration: duration * 1.2, easing: Easing.inOut(Easing.ease) }),
        withTiming(initialY + 50, { duration: duration * 1.2, easing: Easing.inOut(Easing.ease) }),
        withTiming(initialY, { duration: duration * 1.2, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      true
    );
    
    scale.value = withRepeat(
        withSequence(
            withTiming(1.1, { duration: duration * 1.5, easing: Easing.inOut(Easing.ease) }),
            withTiming(0.9, { duration: duration * 1.5, easing: Easing.inOut(Easing.ease) }),
            withTiming(1, { duration: duration * 1.5, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { scale: scale.value }
      ],
    };
  });

  return (
    <Animated.View
      style={[
        styles.blob,
        {
          backgroundColor: color,
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
  return (
    <View style={[styles.container, style]}>
      <LinearGradient
        colors={['#fdfbfb', '#ebedee']}
        style={StyleSheet.absoluteFill}
      />
      
      <Blob 
        color="#ff9a9e" 
        size={300} 
        initialX={-50} 
        initialY={-50} 
        duration={5000} 
      />
      <Blob 
        color="#fad0c4" 
        size={350} 
        initialX={width - 200} 
        initialY={height - 200} 
        duration={7000} 
      />
      <Blob 
        color="#a18cd1" 
        size={250} 
        initialX={-50} 
        initialY={height / 2} 
        duration={6000} 
      />
       <Blob 
        color="#84fab0" 
        size={200} 
        initialX={width - 100} 
        initialY={100} 
        duration={8000} 
      />

      <View style={styles.content}>
        {children}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fdfbfb',
    overflow: 'hidden', // Clip blobs that go outside
  },
  content: {
    flex: 1,
    zIndex: 1,
  },
  blob: {
    position: 'absolute',
    opacity: 0.6,
    // Blur effect for "liquid" look - requires specific implementation or image based blobs for true liquid, 
    // but opacity + movement gives a good approximation. 
    // On iOS we could use a BlurView over them, but that blurs the content too if not careful.
    // For now, simple opacity overlap is good.
  },
});
