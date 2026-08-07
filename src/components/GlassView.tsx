// DEPRECATED shim — GlassView is now GlassCard (src/components/ui/GlassCard),
// which upgrades to native iOS 26 liquid glass via expo-glass-effect when
// available and keeps the BlurView/Android-tint fallbacks. Existing consumers
// get the upgrade for free through this re-export; new code should import
// GlassCard from '@/components/ui'.

import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import { GlassCard } from './ui/GlassCard';
import type { SurfaceRole } from './ui/surfaceRole';

interface GlassViewProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  intensity?: number;
  /** Skip native liquid glass — needed when the card is wrapped in a
      Reanimated layout/opacity animation, where the native material drops out. */
  forceBlur?: boolean;
  /** Flat-mode structural role. Must be forwarded: 135 of the app's 244 glass
      surfaces are still on this shim, and without it none of them could ever
      opt out of borderless. Ignored in glass mode. */
  role?: SurfaceRole;
}

/** @deprecated Use GlassCard from '@/components/ui'. */
export const GlassView = React.memo(
  ({ children, style, contentStyle, intensity, forceBlur, role }: GlassViewProps) => (
    <GlassCard
      style={style}
      contentStyle={contentStyle}
      intensity={intensity}
      forceBlur={forceBlur}
      role={role}
    >
      {children}
    </GlassCard>
  ),
);
