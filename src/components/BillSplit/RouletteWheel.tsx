import { useTheme } from '@/context/ThemeContext';
import { heavyHaptic, successHaptic } from '@/utils/haptics';
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import Animated, {
    Easing,
    cancelAnimation,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, G, Path, Text as SvgText } from 'react-native-svg';
import type { Participant } from './types';

// ── Constants ────────────────────────────────────────────────────────────────
const WHEEL_SIZE = 280;
const CENTER = WHEEL_SIZE / 2;
const RADIUS = CENTER - 8;
const INNER_RADIUS = 40;

/** Crypto-quality random float in [0, 1) — avoids Math.random() bias patterns */
function cryptoRandom(): number {
  const arr = new Uint32Array(1);
  // globalThis.crypto is available in Hermes / modern RN
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(arr);
  } else {
    // Fallback – still better than bare Math.random for perceived uniformity
    arr[0] = (Math.random() * 0xffffffff) >>> 0;
  }
  return arr[0] / 0x100000000;
}

const SEGMENT_COLORS = [
  '#6366F1', // indigo
  '#EC4899', // pink
  '#14B8A6', // teal
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // violet
  '#06B6D4', // cyan
  '#10B981', // emerald
  '#F97316', // orange
  '#3B82F6', // blue
  '#A855F7', // purple
  '#84CC16', // lime
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, outerR: number, innerR: number, startAngle: number, endAngle: number) {
  const outerStart = polarToCartesian(cx, cy, outerR, endAngle);
  const outerEnd = polarToCartesian(cx, cy, outerR, startAngle);
  const innerStart = polarToCartesian(cx, cy, innerR, startAngle);
  const innerEnd = polarToCartesian(cx, cy, innerR, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 0 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerStart.x} ${innerStart.y}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 1 ${innerEnd.x} ${innerEnd.y}`,
    'Z',
  ].join(' ');
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

// ── Types ────────────────────────────────────────────────────────────────────
export interface RouletteWheelRef {
  spin: (winnerIndex: number) => void;
}

interface RouletteWheelProps {
  participants: Participant[];
  onSpinComplete: (winnerId: string) => void;
  disabled?: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────
const RouletteWheel = React.forwardRef<RouletteWheelRef, RouletteWheelProps>(
  ({ participants, onSpinComplete, disabled }, ref) => {
    const { theme } = useTheme();
    const included = useMemo(() => participants.filter((p) => p.included), [participants]);
    const segmentCount = included.length;

    // Rotation state – cumulative degrees (can exceed 360)
    const rotation = useSharedValue(0);
    const isAnimating = useRef(false);
    const lastTickAngle = useRef(0);

    const handleSpinDone = useCallback(
      (winnerId: string) => {
        isAnimating.current = false;
        successHaptic();
        onSpinComplete(winnerId);
      },
      [onSpinComplete],
    );

    // Imperative handle – parent calls wheel.spin(winnerIndex)
    useImperativeHandle(
      ref,
      () => ({
        spin: (winnerIndex: number) => {
          if (isAnimating.current || segmentCount < 2) return;
          isAnimating.current = true;
          heavyHaptic();

          const segmentAngle = 360 / segmentCount;
          // The pointer is at the TOP (0°). We want the winning segment's center
          // to end up under the pointer. Segment i starts at i*segmentAngle.
          // Center of segment i = i*segmentAngle + segmentAngle/2.
          const targetSegmentCenter = winnerIndex * segmentAngle + segmentAngle / 2;
          // Random offset within the segment so it never looks mechanical
          const jitter = (cryptoRandom() - 0.5) * segmentAngle * 0.65;
          const landingAngle = 360 - targetSegmentCenter + jitter;

          // Reset to a clean base to avoid floating-point drift from accumulation
          cancelAnimation(rotation);
          rotation.value = 0;

          // 6-12 full rotations for dramatic, unpredictable-feeling spins
          const fullSpins = (6 + Math.floor(cryptoRandom() * 7)) * 360;
          const finalTarget = fullSpins + ((landingAngle % 360) + 360) % 360;

          lastTickAngle.current = 0;
          const winnerId = included[winnerIndex].id;

          // Variable duration (3.5-5.5s) so timing itself feels random
          const duration = 3500 + cryptoRandom() * 2000;

          rotation.value = withTiming(finalTarget, {
            duration,
            easing: Easing.bezier(0.12, 0.84, 0.22, 1), // fast start, long deceleration
          }, (finished) => {
            if (finished) {
              runOnJS(handleSpinDone)(winnerId);
            }
          });
        },
      }),
      [segmentCount, rotation, included, handleSpinDone],
    );

    // Clean up animation on unmount
    useEffect(() => {
      return () => {
        cancelAnimation(rotation);
      };
    }, [rotation]);

    // Animated transform
    const wheelStyle = useAnimatedStyle(() => ({
      transform: [{ rotate: `${rotation.value}deg` }],
    }));

    // ── Build SVG segments ──────────────────────────────────────────────────
    const segmentAngle = segmentCount > 0 ? 360 / segmentCount : 360;

    const segments = useMemo(() => {
      if (segmentCount < 2) return null;
      return included.map((p, i) => {
        const startAngle = i * segmentAngle;
        const endAngle = startAngle + segmentAngle;
        const midAngle = startAngle + segmentAngle / 2;
        const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length];

        // Label position
        const labelR = (RADIUS + INNER_RADIUS) / 2 + 8;
        const labelPos = polarToCartesian(CENTER, CENTER, labelR, midAngle);

        const path = describeArc(CENTER, CENTER, RADIUS, INNER_RADIUS, startAngle, endAngle);

        return (
          <G key={p.id}>
            <Path d={path} fill={color} stroke="rgba(0,0,0,0.3)" strokeWidth={1.5} />
            <SvgText
              x={labelPos.x}
              y={labelPos.y}
              fill="#FFF"
              fontSize={segmentCount > 6 ? 10 : 13}
              fontWeight="700"
              textAnchor="middle"
              alignmentBaseline="central"
              transform={`rotate(${midAngle}, ${labelPos.x}, ${labelPos.y})`}
            >
              {segmentCount > 8 ? getInitials(p.name) : p.name.length > 8 ? p.name.slice(0, 7) + '…' : p.name}
            </SvgText>
          </G>
        );
      });
    }, [included, segmentCount, segmentAngle]);

    if (segmentCount < 2) {
      return (
        <View style={styles.container}>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
            Need at least 2 participants to spin the wheel
          </Text>
        </View>
      );
    }

    return (
      <View style={styles.container}>
        {/* Pointer triangle at top */}
        <View style={styles.pointerContainer}>
          <Svg width={30} height={22} viewBox="0 0 30 22">
            <Path d="M15 22 L0 0 L30 0 Z" fill={theme.colors.primary} stroke="#FFF" strokeWidth={1.5} />
          </Svg>
        </View>

        {/* Wheel area – relative container for wheel + stationary center */}
        <View style={styles.wheelArea}>
          {/* Spinning wheel + rim dots (both rotate together) */}
          <Animated.View style={[styles.wheelWrapper, wheelStyle]}>
            <Svg width={WHEEL_SIZE} height={WHEEL_SIZE} viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}>
              {/* Outer ring shadow */}
              <Circle
                cx={CENTER}
                cy={CENTER}
                r={RADIUS + 3}
                fill="none"
                stroke="rgba(255,255,255,0.08)"
                strokeWidth={6}
              />
              {/* Segments */}
              {segments}
              {/* Center hub background (spins with wheel) */}
              <Circle cx={CENTER} cy={CENTER} r={INNER_RADIUS} fill="#1A1A2E" stroke="rgba(255,255,255,0.15)" strokeWidth={2} />
              <Circle cx={CENTER} cy={CENTER} r={INNER_RADIUS - 6} fill="#0F0F23" />
            </Svg>

            {/* Decorative dots around the rim */}
            <View style={[styles.dotRing, { opacity: disabled ? 0.3 : 0.6 }]}>
              {Array.from({ length: 24 }).map((_, i) => {
                const angle = (i * 360) / 24;
                const pos = polarToCartesian(WHEEL_SIZE / 2, WHEEL_SIZE / 2, RADIUS + 8, angle);
                return (
                  <View
                    key={i}
                    style={[
                      styles.rimDot,
                      {
                        left: pos.x - 2.5,
                        top: pos.y - 2.5,
                        backgroundColor: i % 2 === 0 ? '#FFD700' : '#FF6B6B',
                      },
                    ]}
                  />
                );
              })}
            </View>
          </Animated.View>

          {/* Center emoji — stays stationary while wheel spins */}
          <View style={styles.centerEmoji} pointerEvents="none">
            <Text style={styles.centerEmojiText}>🎰</Text>
          </View>
        </View>
      </View>
    );
  },
);

RouletteWheel.displayName = 'RouletteWheel';
export default RouletteWheel;

// ── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  pointerContainer: {
    zIndex: 10,
    marginBottom: -6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 5,
  },
  wheelArea: {
    width: WHEEL_SIZE,
    height: WHEEL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wheelWrapper: {
    width: WHEEL_SIZE,
    height: WHEEL_SIZE,
  },
  dotRing: {
    position: 'absolute',
    width: WHEEL_SIZE,
    height: WHEEL_SIZE,
  },
  rimDot: {
    position: 'absolute',
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  centerEmoji: {
    position: 'absolute',
    width: INNER_RADIUS * 2,
    height: INNER_RADIUS * 2,
    borderRadius: INNER_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  centerEmojiText: {
    fontSize: 22,
  },
});
