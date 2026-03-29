import { useLoading } from '@/context/LoadingContext';
import { usePreventDoubleSubmit } from '@/hooks/usePreventDoubleSubmit';
import { useMemo } from 'react';
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
  ...buttonProps
}: PrimaryButtonProps) => {
  const { visible: globalLoadingVisible } = useLoading();
  const { loading: internalLoading, run } = usePreventDoubleSubmit({
    key: requestKey,
    message: loadingMessage,
    overlay: showGlobalOverlay,
  });

  const loading = controlledLoading ?? internalLoading;
  const isDisabled = disabled || loading || (showGlobalOverlay && globalLoadingVisible);

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
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      {...buttonProps}
    >
      {children}
    </Button>
  );
};
