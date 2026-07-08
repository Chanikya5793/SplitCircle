// Empty/offline/error state primitives so screens stop hand-rolling these
// (or worse, spinning forever). OfflineState is the standard "offline and
// nothing cached" treatment per UI_REVAMP.md convention 2.

import { useTheme } from '@/context/ThemeContext';
import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { AppButton } from './AppButton';

export interface EmptyStateProps {
  icon: string;
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}

export const EmptyState = ({ icon, title, hint, actionLabel, onAction, style }: EmptyStateProps) => {
  const { theme } = useTheme();
  return (
    <View style={[styles.container, { padding: theme.spacing.xl, gap: theme.spacing.sm }, style]}>
      <View
        style={[
          styles.iconCircle,
          { backgroundColor: theme.colors.primaryContainer, borderRadius: theme.radius.pill },
        ]}
      >
        <Icon source={icon} size={30} color={theme.colors.primary} />
      </View>
      <Text
        style={{
          color: theme.colors.onSurface,
          fontSize: theme.typography.subtitle.fontSize,
          fontWeight: theme.typography.subtitle.fontWeight,
          textAlign: 'center',
        }}
      >
        {title}
      </Text>
      {hint ? (
        <Text
          style={{
            color: theme.colors.muted,
            fontSize: theme.typography.caption.fontSize,
            lineHeight: theme.typography.caption.lineHeight,
            textAlign: 'center',
          }}
        >
          {hint}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <AppButton variant="secondary" compact onPress={() => onAction()} style={{ marginTop: theme.spacing.sm }}>
          {actionLabel}
        </AppButton>
      ) : null}
    </View>
  );
};

export interface OfflineStateProps {
  /** What the user was trying to see, e.g. "receipts" — used in the copy. */
  subject?: string;
  onRetry?: () => void;
  style?: StyleProp<ViewStyle>;
}

export const OfflineState = ({ subject = 'this', onRetry, style }: OfflineStateProps) => (
  <EmptyState
    icon="wifi-off"
    title="You're offline"
    hint={`We couldn't load ${subject} and nothing is saved on this device yet. It will load automatically when you're back online.`}
    actionLabel={onRetry ? 'Try again' : undefined}
    onAction={onRetry}
    style={style}
  />
);

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCircle: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
});
