// ConfettiBurst — a dependency-free celebration burst for Fun Mode reveals.
// ~26 pieces launch upward from the center with random spread, then fall with
// gravity while tumbling and fading. Everything runs on the UI thread via
// Reanimated; the component renders nothing after the burst finishes (pieces
// fade to 0 — parent unmounts it on next state change). pointerEvents="none"
// so the celebration never blocks taps.

import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

const COLORS = ['#F59E0B', '#10B981', '#3B82F6', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'];
const PIECE_COUNT = 26;
const DURATION = 1500;

interface PieceSpec {
  color: string;
  size: number;
  /** Horizontal drift in px (negative = left). */
  driftX: number;
  /** Peak rise above origin before falling (px). */
  rise: number;
  /** Total fall below origin (px). */
  fall: number;
  spin: number;
  delay: number;
  isRound: boolean;
}

const Piece = ({ spec }: { spec: PieceSpec }) => {
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = withDelay(spec.delay, withTiming(1, { duration: DURATION, easing: Easing.out(Easing.quad) }));
  }, [t, spec.delay]);

  const style = useAnimatedStyle(() => {
    const progress = t.value;
    // Parabolic arc: up fast, then down past the origin.
    const y = -spec.rise * 4 * progress * (1 - progress) + spec.fall * progress * progress;
    return {
      opacity: progress < 0.7 ? 1 : 1 - (progress - 0.7) / 0.3,
      transform: [
        { translateX: spec.driftX * progress },
        { translateY: y },
        { rotate: `${spec.spin * progress}deg` },
      ],
    };
  });

  return (
    <Animated.View
      style={[
        styles.piece,
        {
          backgroundColor: spec.color,
          width: spec.size,
          height: spec.isRound ? spec.size : spec.size * 0.45,
          borderRadius: spec.isRound ? spec.size / 2 : 1.5,
        },
        style,
      ]}
    />
  );
};

/** Remount (change `key`) to replay the burst. */
export const ConfettiBurst = () => {
  const pieces = useMemo<PieceSpec[]>(
    () =>
      Array.from({ length: PIECE_COUNT }, (_, i) => ({
        color: COLORS[i % COLORS.length],
        size: 6 + Math.random() * 6,
        driftX: (Math.random() - 0.5) * 260,
        rise: 60 + Math.random() * 120,
        fall: 160 + Math.random() * 140,
        spin: (Math.random() - 0.5) * 720,
        delay: Math.random() * 120,
        isRound: Math.random() > 0.6,
      })),
    [],
  );

  return (
    <View pointerEvents="none" style={styles.container}>
      {pieces.map((spec, i) => (
        <Piece key={i} spec={spec} />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  piece: {
    position: 'absolute',
  },
});
