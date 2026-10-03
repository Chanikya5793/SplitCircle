// ArchivedFolderRow — compact, WhatsApp-style folder header pinned ABOVE the
// active list (Archived / Locked). Shows an icon + label + count and a chevron
// that reflects the expanded state. Tapping toggles inline expansion (or, for
// the Locked folder, triggers a biometric unlock handled by the caller).

import { useTheme } from '@/context/ThemeContext';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';

interface ArchivedFolderRowProps {
  /** MaterialCommunityIcons name for the leading icon. */
  icon: string;
  label: string;
  count: number;
  /** Whether the folder is currently expanded (drives the chevron + omits it for locked). */
  expanded: boolean;
  onPress: () => void;
  /** Locked folders show a chevron-right (they gate behind Face ID) instead of up/down. */
  locked?: boolean;
  /** Tint override for the leading icon + label (locked folders lean on the accent). */
  tint?: string;
}

export const ArchivedFolderRow = ({
  icon,
  label,
  count,
  expanded,
  onPress,
  locked = false,
  tint,
}: ArchivedFolderRowProps) => {
  const { theme } = useTheme();
  const color = tint ?? theme.colors.onSurfaceVariant;

  return (
    <TouchableRipple
      onPress={onPress}
      style={styles.row}
      borderless
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count}`}
      accessibilityState={{ expanded: locked ? undefined : expanded }}
    >
      <View style={styles.inner}>
        <View style={styles.leadingIcon} pointerEvents="none">
          <Icon source={icon} size={20} color={color} />
        </View>
        <Text variant="titleSmall" style={[styles.label, { color }]}>
          {label}
        </Text>
        <View style={[styles.countPill, { backgroundColor: theme.colors.skeleton }]}>
          <Text style={[styles.countText, { color: theme.colors.onSurfaceVariant }]}>{count}</Text>
        </View>
        <View style={styles.trailingIcon} pointerEvents="none">
          <Icon
            source={locked ? 'chevron-right' : expanded ? 'chevron-up' : 'chevron-down'}
            size={20}
            color={theme.colors.onSurfaceVariant}
          />
        </View>
      </View>
    </TouchableRipple>
  );
};

const styles = StyleSheet.create({
  row: {
    borderRadius: 16,
    marginBottom: 12,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  leadingIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    flex: 1,
    fontWeight: '600',
  },
  countPill: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: {
    fontSize: 12,
    fontWeight: '700',
  },
  trailingIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
