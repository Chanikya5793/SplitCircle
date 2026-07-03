// Standard tappable row: leading icon in a tinted circle, title/subtitle,
// trailing element or chevron. Used by settings/info screens instead of
// per-screen List.Item restyling.

import { useTheme } from '@/context/ThemeContext';
import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  icon?: string;
  /** Overrides the default icon tint (theme primary). */
  iconColor?: string;
  onPress?: () => void;
  trailing?: React.ReactNode;
  /** Show a chevron when tappable. Defaults to true when onPress is set. */
  chevron?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export const ListRow = ({
  title,
  subtitle,
  icon,
  iconColor,
  onPress,
  trailing,
  chevron,
  destructive = false,
  disabled = false,
  style,
}: ListRowProps) => {
  const { theme } = useTheme();
  const tint = destructive ? theme.colors.danger : (iconColor ?? theme.colors.primary);
  const showChevron = chevron ?? (Boolean(onPress) && !trailing);

  const content = (
    <View style={[styles.row, { paddingVertical: theme.spacing.sm + 2, paddingHorizontal: theme.spacing.md }, style]}>
      {icon ? (
        <View
          style={[
            styles.iconCircle,
            {
              backgroundColor: destructive ? theme.colors.dangerContainer : theme.colors.primaryContainer,
              borderRadius: theme.radius.pill,
            },
          ]}
        >
          <Icon source={icon} size={18} color={tint} />
        </View>
      ) : null}
      <View style={styles.copy}>
        <Text
          numberOfLines={1}
          style={{
            color: destructive ? theme.colors.danger : theme.colors.onSurface,
            fontSize: theme.typography.body.fontSize,
            fontWeight: '500',
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={2}
            style={{
              color: theme.colors.muted,
              fontSize: theme.typography.caption.fontSize,
              marginTop: 1,
            }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {showChevron ? <Icon source="chevron-right" size={20} color={theme.colors.muted} /> : null}
    </View>
  );

  if (!onPress) return content;

  return (
    <TouchableRipple
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={disabled ? styles.disabled : undefined}
    >
      {content}
    </TouchableRipple>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconCircle: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { flex: 1 },
  disabled: { opacity: 0.5 },
});
