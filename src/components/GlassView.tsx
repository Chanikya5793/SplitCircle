// DEPRECATED shim — GlassView is now GlassCard (src/components/ui/GlassCard),
// which upgrades to native iOS 26 liquid glass via expo-glass-effect when
// available and keeps the BlurView/Android-tint fallbacks. Existing consumers
// get the upgrade for free through this re-export; new code should import
// GlassCard from '@/components/ui'.

import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import { GlassCard } from './ui/GlassCard';

interface GlassViewProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  intensity?: number;
}

/** @deprecated Use GlassCard from '@/components/ui'. */
export const GlassView = React.memo(({ children, style, contentStyle, intensity }: GlassViewProps) => (
  <GlassCard style={style} contentStyle={contentStyle} intensity={intensity}>
    {children}
  </GlassCard>
));
