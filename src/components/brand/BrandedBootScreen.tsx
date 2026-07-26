import { APP_NAME } from '@/constants/appInfo';
import { brand, mugguMotion } from '@/theme';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';
import { Text } from 'react-native-paper';
import { MugguLoader } from './MugguLoader';

interface BrandedBootScreenProps {
  message?: string;
}

/**
 * Pixel-matched React successor to the static native launch screen.
 *
 * It first paints the completed mark, hides the native frame after layout, and
 * only starts the draw loop/copy if startup survives the short grace period.
 */
export const BrandedBootScreen = ({ message }: BrandedBootScreenProps) => {
  // The native launch screen follows the OS appearance, which may differ from
  // an in-app forced theme. Match the OS for the handoff frame; navigation can
  // then reveal the user's selected app theme normally.
  const isDark = useColorScheme() === 'dark';
  const handedOffRef = useRef(false);
  const [showMessage, setShowMessage] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowMessage(true), mugguMotion.bootGraceMs);
    return () => clearTimeout(timer);
  }, []);

  const handleLayout = useCallback(() => {
    if (handedOffRef.current) return;
    handedOffRef.current = true;

    requestAnimationFrame(() => {
      SplashScreen.hide();
    });
  }, []);

  const backgroundColor = isDark ? brand.plum : brand.cream;
  const foregroundColor = isDark ? brand.reversedInk : brand.ink;

  return (
    <View
      style={[styles.container, { backgroundColor }]}
      onLayout={handleLayout}
      testID="branded-boot-screen"
    >
      <MugguLoader
        size={112}
        variant={isDark ? 'reversed' : 'primary'}
        showPen
        initialState="complete"
        startDelayMs={mugguMotion.bootGraceMs}
        accessibilityLabel={message ?? `Preparing ${APP_NAME}`}
      />
      <Text
        variant="bodyMedium"
        accessibilityLiveRegion="polite"
        style={[
          styles.message,
          {
            color: foregroundColor,
            opacity: showMessage ? 0.78 : 0,
          },
        ]}
      >
        {message ?? `Preparing ${APP_NAME}…`}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
  },
  message: {
    minHeight: 22,
  },
});
