import { useTheme } from '@/context/ThemeContext';
import React from 'react';
import { Pressable, StyleSheet, type AccessibilityRole } from 'react-native';
import { Icon, Text } from 'react-native-paper';

export interface SelectableChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  icon?: React.ComponentProps<typeof Icon>['source'];
  disabled?: boolean;
  accessibilityRole?: AccessibilityRole;
}

/** Shared selectable pill for filter, sort, and single-choice controls. */
export const SelectableChip = ({
  label,
  selected,
  onPress,
  icon,
  disabled = false,
  accessibilityRole = 'button',
}: SelectableChipProps) => {
  const { theme, isDark } = useTheme();

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      // The pill is drawn at the compact size the chips it replaced used;
      // the slop keeps the touch target at 44pt without the 44pt look.
      hitSlop={5}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={label}
      accessibilityState={accessibilityRole === 'radio' || accessibilityRole === 'checkbox'
        ? { checked: selected, disabled }
        : { selected, disabled }}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected
            ? theme.colors.primary
            : isDark
              ? 'rgba(255,255,255,0.1)'
              : 'rgba(0,0,0,0.06)',
          borderColor: selected ? theme.colors.primary : theme.colors.outlineVariant,
          opacity: disabled ? 0.4 : pressed ? 0.72 : 1,
          transform: [{ scale: pressed && !disabled ? 0.98 : 1 }],
        },
      ]}
    >
      {icon ? (
        <Icon
          source={icon}
          size={16}
          color={selected ? theme.colors.onPrimary : theme.colors.onSurface}
        />
      ) : null}
      <Text
        variant="labelMedium"
        style={{
          color: selected ? theme.colors.onPrimary : theme.colors.onSurface,
          fontWeight: selected ? '600' : '500',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  chip: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 50,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
