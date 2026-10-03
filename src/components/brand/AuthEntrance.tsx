import { useTheme } from '@/context/ThemeContext';
import { useEffect, useRef, type PropsWithChildren } from 'react';
import { Animated } from 'react-native';

/** A short transform-only entrance that preserves the native glass material. */
export const AuthEntrance = ({ children }: PropsWithChildren) => {
  const { theme } = useTheme();
  const translateY = useRef(new Animated.Value(theme.reduceMotion ? 0 : 18)).current;

  useEffect(() => {
    if (theme.reduceMotion) {
      translateY.setValue(0);
      return;
    }
    const motion = Animated.spring(translateY, {
      toValue: 0,
      speed: 18,
      bounciness: 3,
      useNativeDriver: true,
    });
    motion.start();
    return () => motion.stop();
  }, [theme.reduceMotion, translateY]);

  return <Animated.View style={{ transform: [{ translateY }] }}>{children}</Animated.View>;
};
