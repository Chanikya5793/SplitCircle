// Row separator for the app's main lists (groups, expenses, chats).
//
// Why this is surface-aware rather than always-on: the two surface styles
// separate rows by DIFFERENT means, and drawing both at once looks wrong.
//
//   glass — every row is its own floating card with a gap between it and the
//           next. The gap IS the separation; a hairline floating in that gap
//           reads as a stray line, not structure. Renders nothing.
//   flat  — rows are borderless and sit directly on the canvas with nothing
//           between them. Here the hairline IS the structure, exactly like a
//           native iOS grouped list.
//
// Pair this with a row whose bottom margin collapses to 0 in flat mode (see
// SwipeableGroupCard) — otherwise the separator sits in the middle of the
// row's own margin and reads as asymmetric.
//
// NOT the same thing as the flat-mode divider SUPPRESSION that briefly landed
// on 2026-08-07 and was reversed: that hid dividers the app already had. This
// ADDS dividers to lists that never had any, which is what "bring back the
// dividers and properly implement them" asked for.

import { useTheme } from '@/context/ThemeContext';
import { StyleSheet, View } from 'react-native';

export interface ListSeparatorProps {
  /** Left inset, to align the line with text rather than the avatar/icon. */
  inset?: number;
}

export const ListSeparator = ({ inset = 0 }: ListSeparatorProps) => {
  const { theme } = useTheme();
  // Defensive `?.` — component tests mock useTheme() with partial themes.
  if (theme?.surfaceStyle !== 'flat') return null;
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        marginLeft: inset,
        backgroundColor: theme?.colors?.divider ?? 'rgba(15, 23, 42, 0.08)',
      }}
    />
  );
};
