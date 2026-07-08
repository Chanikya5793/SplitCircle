// Standard app button: PrimaryButton's double-submit/loading behavior plus
// semantic variants and built-in haptics. Prefer this over raw Paper Buttons.

import { PrimaryButton } from '@/components/PrimaryButton';
import { useTheme } from '@/context/ThemeContext';
import { lightHaptic } from '@/utils/haptics';
import React, { useCallback } from 'react';
import type { ComponentProps } from 'react';

export type AppButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';

type PrimaryButtonProps = ComponentProps<typeof PrimaryButton>;

export interface AppButtonProps extends Omit<PrimaryButtonProps, 'mode' | 'buttonColor' | 'textColor'> {
  variant?: AppButtonVariant;
  /** Disable the default light haptic on press. */
  noHaptic?: boolean;
}

const MODE_FOR: Record<AppButtonVariant, 'contained' | 'contained-tonal' | 'text'> = {
  primary: 'contained',
  secondary: 'contained-tonal',
  destructive: 'contained',
  ghost: 'text',
};

export const AppButton = ({
  variant = 'primary',
  noHaptic = false,
  onPress,
  ...rest
}: AppButtonProps) => {
  const { theme } = useTheme();

  const handlePress = useCallback(
    (requestId: string) => {
      if (!noHaptic) lightHaptic();
      return onPress?.(requestId);
    },
    [onPress, noHaptic],
  );

  const destructiveProps =
    variant === 'destructive'
      ? { buttonColor: theme.colors.danger, textColor: theme.colors.onDanger }
      : {};

  return (
    <PrimaryButton
      mode={MODE_FOR[variant]}
      onPress={onPress ? handlePress : undefined}
      {...destructiveProps}
      {...rest}
    />
  );
};
