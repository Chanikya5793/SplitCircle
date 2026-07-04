// Sticky-header pill for scroll-collapsing screens — real liquid glass.
//
// CONTRACT: screens must reveal this pill by animating TRANSFORMS
// (translateY slide-in), never opacity. UIVisualEffectView-backed materials
// stop rendering when an ancestor holds fractional alpha, and iOS 27 won't
// reliably restore them — that's how the tabs' floating titles lost their
// backdrop. Transforms leave the material intact.

import React from 'react';
import { StyleProp, StyleSheet, ViewStyle } from 'react-native';
import { GlassCard } from './GlassCard';

export interface StickyHeaderPillProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export const StickyHeaderPill = ({ children, style }: StickyHeaderPillProps) => (
  <GlassCard radius={20} intensity={45} contentStyle={[styles.pillContent, style]}>
    {children}
  </GlassCard>
);

const styles = StyleSheet.create({
  pillContent: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
