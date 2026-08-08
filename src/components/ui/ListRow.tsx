// Standard tappable row: leading icon in a tinted circle, title/subtitle,
// trailing element or chevron. Used by settings/info screens instead of
// per-screen List.Item restyling.

import { useTheme } from '@/context/ThemeContext';
import { usePressFeedback } from '@/hooks/usePressFeedback';
import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';
import Animated from 'react-native-reanimated';

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
  const { pressScaleStyle, pressHighlightStyle, touchableProps } = usePressFeedback();
  const tint = destructive ? theme.colors.danger : (iconColor ?? theme.colors.primary);
  const showChevron = chevron ?? (Boolean(onPress) && !trailing);

  /**
   * A `trailing` control (usually a Switch) is its own focusable node, and
   * inline it has no name — a uiautomator dump of Settings showed four
   * unlabeled `Switch` nodes, which TalkBack announces as just "switch, on".
   * The row's title is the only thing that says WHAT is being toggled, so it
   * is lent to the control here. `accessibilityLabel` on a parent does not
   * cascade in RN, so this has to be an explicit clone rather than a wrapper.
   *
   * A control that already names itself keeps its own label.
   */
  /**
   * A trailing Switch measures 47x27dp — that is Paper's control size, not
   * something a style can raise, so the switch itself can never be a
   * compliant 44pt target. The fix is the one iOS itself uses: make the whole
   * ROW toggle it. The row is >=48pt tall, so the target becomes compliant,
   * and it is better UX besides.
   *
   * Only applied when the row has no onPress of its own — a row that already
   * navigates somewhere must not silently start toggling instead.
   */
  const trailingSwitch = React.isValidElement(trailing)
    ? (trailing.props as { onValueChange?: (v: boolean) => void; value?: boolean; disabled?: boolean })
    : undefined;
  const rowToggles =
    !onPress && typeof trailingSwitch?.onValueChange === 'function' && !trailingSwitch.disabled;
  const effectiveOnPress = rowToggles
    ? () => trailingSwitch!.onValueChange!(!trailingSwitch!.value)
    : onPress;

  const labelledTrailing = React.useMemo(() => {
    if (!React.isValidElement(trailing)) return trailing;
    const existing = (trailing.props as { accessibilityLabel?: string }).accessibilityLabel;
    if (existing) return trailing;
    return React.cloneElement(trailing as React.ReactElement<any>, {
      accessibilityLabel: title,
      // If the ROW now owns the toggle, the control must stop being its own
      // focus stop — otherwise a screen reader hits the same setting twice.
      ...(rowToggles
        ? { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const }
        : null),
    });
  }, [trailing, title, rowToggles]);

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
      {labelledTrailing}
      {showChevron ? <Icon source="chevron-right" size={20} color={theme.colors.muted} /> : null}
    </View>
  );

  if (!effectiveOnPress) return content;

  return (
    <TouchableRipple
      onPress={effectiveOnPress}
      disabled={disabled}
      // When the row IS the switch, it must announce as one ("AI receipt
      // parsing, switch, on") rather than as a button with no state.
      accessibilityRole={rowToggles ? 'switch' : 'button'}
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      accessibilityState={rowToggles ? { checked: !!trailingSwitch?.value, disabled } : { disabled }}
      style={disabled ? styles.disabled : undefined}
      {...touchableProps}
    >
      <Animated.View style={[pressScaleStyle, pressHighlightStyle]}>{content}</Animated.View>
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
