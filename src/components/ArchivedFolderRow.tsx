// ArchivedFolderRow — compact, WhatsApp-style folder header pinned ABOVE the
// active list (Archived / Locked). Shows an icon + label + count and a chevron
// that reflects the expanded state. Tapping toggles inline expansion (or, for
// the Locked folder, triggers a biometric unlock handled by the caller).

import { useTheme } from '@/context/ThemeContext';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text, TouchableRipple } from 'react-native-paper';

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
    >
      <View style={styles.inner}>
        <IconButton icon={icon} size={20} iconColor={color} style={styles.leadingIcon} />
        <Text variant="titleSmall" style={[styles.label, { color }]}>
          {label}
        </Text>
        <View style={[styles.countPill, { backgroundColor: theme.colors.skeleton }]}>
          <Text style={[styles.countText, { color: theme.colors.onSurfaceVariant }]}>{count}</Text>
        </View>
        <IconButton
          icon={locked ? 'chevron-right' : expanded ? 'chevron-up' : 'chevron-down'}
          size={20}
          iconColor={theme.colors.onSurfaceVariant}
          style={styles.trailingIcon}
        />
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
    margin: 0,
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
    margin: 0,
  },
});
