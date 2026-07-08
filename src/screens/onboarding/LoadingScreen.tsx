// Branded splash + the app-wide "data not ready" fallback. When used as a
// route fallback it times out into an honest empty state instead of spinning
// forever (the old behavior stranded offline deep links on an infinite
// spinner with no way out).

import { LiquidBackground } from '@/components/LiquidBackground';
import { EmptyState } from '@/components/ui';
import { APP_NAME } from '@/constants/appInfo';
import { useTheme } from '@/context/ThemeContext';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';

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
}

export const LoadingScreen = ({
  message,
  timeoutMs = 12000,
  onTimeoutAction,
  timeoutActionLabel = 'Go back',
  timeoutIcon = 'cloud-off-outline',
  timeoutTitle = "This isn't available right now",
  timeoutHint = 'It may not be saved on this device yet. Check your connection and try again.',
}: LoadingScreenProps) => {
  const { theme } = useTheme();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!timeoutMs) return;
    const timer = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [timeoutMs]);

  return (
    <LiquidBackground>
      <View style={styles.container}>
        {timedOut ? (
          <EmptyState
            icon={timeoutIcon}
            title={timeoutTitle}
            hint={timeoutHint}
            actionLabel={onTimeoutAction ? timeoutActionLabel : undefined}
            onAction={onTimeoutAction}
          />
        ) : (
          <>
            <ActivityIndicator animating size="large" color={theme.colors.primary} />
            <Text style={{ color: theme.colors.muted }}>
              {message ?? `Preparing ${APP_NAME}…`}
            </Text>
          </>
        )}
      </View>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
});
