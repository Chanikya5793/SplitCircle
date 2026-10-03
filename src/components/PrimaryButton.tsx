import { useLoading } from '@/context/LoadingContext';
import { useTheme } from '@/context/ThemeContext';
import { usePreventDoubleSubmit } from '@/hooks/usePreventDoubleSubmit';
import { useEffect, useMemo, useRef } from 'react';
import { Animated } from 'react-native';
import { type ButtonProps, Button } from 'react-native-paper';

interface PrimaryButtonProps extends Omit<ButtonProps, 'onPress' | 'loading' | 'disabled'> {
  onPress?: (requestId: string) => void | Promise<void>;
  loading?: boolean;
  disabled?: boolean;
  requestKey?: string;
  loadingMessage?: string;
  showGlobalOverlay?: boolean;
}

export const PrimaryButton = ({
  onPress,
  loading: controlledLoading,
  disabled = false,
  requestKey,
  loadingMessage,
  showGlobalOverlay = false,
  children,
  style: buttonStyle,
  onPressIn: suppliedOnPressIn,
  onPressOut: suppliedOnPressOut,
  ...buttonProps
}: PrimaryButtonProps) => {
  const { visible: globalLoadingVisible } = useLoading();
  const { theme } = useTheme();
  const pressScale = useRef(new Animated.Value(1)).current;
  const { loading: internalLoading, run } = usePreventDoubleSubmit({
    key: requestKey,
    message: loadingMessage,
    overlay: showGlobalOverlay,
  });

  const loading = controlledLoading ?? internalLoading;
  const isDisabled = disabled || loading || (showGlobalOverlay && globalLoadingVisible);

  useEffect(() => {
    if (isDisabled || theme.reduceMotion) pressScale.setValue(1);
  }, [isDisabled, pressScale, theme.reduceMotion]);

  const onPressIn: NonNullable<ButtonProps['onPressIn']> = (event) => {
    if (!theme.reduceMotion) {
      Animated.timing(pressScale, { toValue: 0.98, duration: 90, useNativeDriver: true }).start();
    }
    suppliedOnPressIn?.(event);
  };

  const onPressOut: NonNullable<ButtonProps['onPressOut']> = (event) => {
    if (!theme.reduceMotion) {
      Animated.spring(pressScale, { toValue: 1, speed: 20, bounciness: 3, useNativeDriver: true }).start();
    }
    suppliedOnPressOut?.(event);
  };

  const handlePress = useMemo(
    () =>
      onPress
        ? () => {
            void run(async (requestId) => {
              await onPress(requestId);
            });
          }
        : undefined,
    [onPress, run],
  );

  return (
    <Button
      mode="contained"
      loading={loading}
      disabled={isDisabled}
      onPress={handlePress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={[buttonStyle, { transform: [{ scale: pressScale }] }]}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      {...buttonProps}
    >
      {children}
    </Button>
  );
};
