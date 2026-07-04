// Sticky-header pill for scroll-collapsing screens. Deliberately NOT native
// glass/blur: the pill fades with the scroll position, and UIVisualEffectView
// drops its material when an ancestor animates alpha below 1 (iOS 27 is
// stricter about restoring it), which left floating titles with no backdrop.
// A translucent themed tint + hairline border renders identically under any
// opacity and stays legible over photo wallpapers.

import { useTheme } from '@/context/ThemeContext';
import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

export interface StickyHeaderPillProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export const StickyHeaderPill = ({ children, style }: StickyHeaderPillProps) => {
  const { isDark } = useTheme();
  return (
    <View
      style={[
        styles.pill,
        {
          backgroundColor: isDark ? 'rgba(28,28,32,0.92)' : 'rgba(250,250,252,0.92)',
          borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)',
        },
        style,
      ]}
    >
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  pill: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
