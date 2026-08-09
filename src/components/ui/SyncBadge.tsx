// "Pending sync" chip for optimistic items written through the offline
// outbox. Makes queued-but-unsynced expenses/settlements/messages honest
// instead of indistinguishable from synced ones.

import { useTheme } from '@/context/ThemeContext';
import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Icon, Text } from 'react-native-paper';

export interface SyncBadgeProps {
  label?: string;
  style?: StyleProp<ViewStyle>;
}

export const SyncBadge = ({ label = 'Pending', style }: SyncBadgeProps) => {
  const { theme } = useTheme();
  return (
    <View
      accessibilityLabel={`${label} — waiting to sync`}
      style={[
        styles.badge,
        {
          backgroundColor: theme.colors.warningContainer,
          borderRadius: theme.radius.pill,
        },
        style,
      ]}
    >
      <Icon source="clock-outline" size={11} color={theme.colors.onWarningContainer} />
      <Text
        style={{
          color: theme.colors.onWarningContainer,
          fontSize: theme.typography.label.fontSize,
          lineHeight: theme.typography.label.lineHeight,
          fontWeight: theme.typography.label.fontWeight,
        }}
      >
        {label}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
});
