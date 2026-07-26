// Branded splash + the app-wide "data not ready" fallback. When used as a
// route fallback it times out into an honest empty state instead of spinning
// forever (the old behavior stranded offline deep links on an infinite
// spinner with no way out).

import { LiquidBackground } from '@/components/LiquidBackground';
import { BrandedBootScreen, MugguLoader } from '@/components/brand';
import { EmptyState } from '@/components/ui';
import { APP_NAME } from '@/constants/appInfo';
import { useTheme } from '@/context/ThemeContext';
import { animation, spacing } from '@/theme';
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

interface LoadingScreenProps {
  /** Overrides the default "Preparing {app}…" copy. */
  message?: string;
  /** After this many ms, show a "not available" state instead of the spinner.
   *  Pass 0 to disable (pure splash). Route fallbacks should keep the default. */
  timeoutMs?: number;
  /** Shown in the timeout state, e.g. a Go back action. */
  onTimeoutAction?: () => void;
  timeoutActionLabel?: string;
  /** Overrides for the timeout state's copy (e.g. "Chat not found"). */
  timeoutIcon?: string;
  timeoutTitle?: string;
  timeoutHint?: string;
  /** True only for the first auth/bootstrap frame that succeeds the native splash. */
  nativeSplashHandoff?: boolean;
}

export const LoadingScreen = ({
  message,
  timeoutMs = 12000,
  onTimeoutAction,
  timeoutActionLabel = 'Go back',
  timeoutIcon = 'cloud-off-outline',
  timeoutTitle = "This isn't available right now",
  timeoutHint = 'It may not be saved on this device yet. Check your connection and try again.',
  nativeSplashHandoff = false,
}: LoadingScreenProps) => {
  const { theme, isDark } = useTheme();
  const [timedOut, setTimedOut] = useState(false);

  // Crossfade the spinner out and the timeout state in so the swap reads as a
  // smooth dissolve instead of an abrupt flicker. The spinner stays mounted
  // (fading to 0) while the EmptyState mounts only once we've timed out and
  // fades up from 0 — layered on top via absolute positioning.
  const spinnerOpacity = useRef(new Animated.Value(1)).current;
  const timeoutOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!timeoutMs) return;
    const timer = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [timeoutMs]);

  useEffect(() => {
    if (!timedOut) return;
    Animated.parallel([
      Animated.timing(spinnerOpacity, {
        toValue: 0,
        duration: animation.quickMs,
        useNativeDriver: true,
      }),
      Animated.timing(timeoutOpacity, {
        toValue: 1,
        duration: animation.quickMs,
        useNativeDriver: true,
      }),
    ]).start();
  }, [timedOut, spinnerOpacity, timeoutOpacity]);

  const content = (
    <>
      <View style={styles.container}>
        <Animated.View
          style={[styles.layer, { opacity: spinnerOpacity }]}
          pointerEvents="none"
        >
          {nativeSplashHandoff ? (
            <BrandedBootScreen message={message} />
          ) : (
            <>
              <MugguLoader
                size={72}
                variant={isDark ? 'reversed' : 'primary'}
                showPen={false}
                accessibilityLabel={message ?? `Preparing ${APP_NAME}`}
              />
              <Text style={{ color: theme.colors.muted }}>
                {message ?? `Preparing ${APP_NAME}…`}
              </Text>
            </>
          )}
        </Animated.View>
        {timedOut && (
          <Animated.View
            style={[styles.layer, { opacity: timeoutOpacity }]}
            pointerEvents="auto"
          >
            <EmptyState
              icon={timeoutIcon}
              title={timeoutTitle}
              hint={timeoutHint}
              actionLabel={onTimeoutAction ? timeoutActionLabel : undefined}
              onAction={onTimeoutAction}
            />
          </Animated.View>
        )}
      </View>
    </>
  );

  if (nativeSplashHandoff) {
    return content;
  }

  return <LiquidBackground>{content}</LiquidBackground>;
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  layer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
  },
});
