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
const WHEEL_SIZE = 300;
const CX = WHEEL_SIZE / 2;
const CY = WHEEL_SIZE / 2;

// Outer ring (participants)
const OUTER_R = CX - 8;
const OUTER_INNER_R = 100;

// Inner ring (percentages)
const INNER_R = 93;
const INNER_INNER_R = 50;

// Center hub
const HUB_R = 42;

function cryptoRandom(): number {
  const arr = new Uint32Array(1);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(arr);
  } else {
    arr[0] = (Math.random() * 0xffffffff) >>> 0;
  }
  return arr[0] / 0x100000000;
}

const OUTER_COLORS = [
  '#6366F1', '#EC4899', '#14B8A6', '#F59E0B', '#EF4444',
  '#8B5CF6', '#06B6D4', '#10B981', '#F97316', '#3B82F6',
  '#A855F7', '#84CC16',
];

const INNER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
  '#F7DC6F', '#BB8FCE', '#85C1E9',
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(
  cx: number, cy: number,
  outerR: number, innerR: number,
  startAngle: number, endAngle: number,
) {
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
  return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
}

// ── Percentage Option Generator ──────────────────────────────────────────────
export function generatePercentageOptions(remaining: number): number[] {
  const TARGET = 8;
  if (remaining <= 0) return [0];
  if (remaining <= TARGET) {
    return Array.from({ length: remaining }, (_, i) => i + 1);
  }

  const options = new Set<number>();
  // Spread breakpoints across the range
  const breakpoints = [0.05, 0.1, 0.15, 0.25, 0.35, 0.5, 0.7, 1.0];
  for (const bp of breakpoints) {
    const val = Math.max(1, Math.round(remaining * bp));
    if (val <= remaining) options.add(val);
    if (options.size >= TARGET) break;
  }

  // Fill with random values if we need more
  let attempts = 0;
  while (options.size < TARGET && attempts < 50) {
    const val = 1 + Math.floor(Math.random() * remaining);
    options.add(val);
    attempts++;
  }

  return Array.from(options).sort((a, b) => a - b).slice(0, TARGET);
}

// ── Types ────────────────────────────────────────────────────────────────────
export interface WeightedRouletteWheelRef {
  spinOuter: (winnerIndex: number) => void;
  spinInner: (winnerIndex: number) => void;
}

interface Props {
  participants: Participant[];
  percentages: number[];
  onOuterSpinComplete: (winnerId: string) => void;
  onInnerSpinComplete: (percentage: number) => void;
  disabled?: boolean;
  highlightedUserId?: string | null;
}

// ── Component ────────────────────────────────────────────────────────────────
const WeightedRouletteWheel = React.forwardRef<WeightedRouletteWheelRef, Props>(
  ({ participants, percentages, onOuterSpinComplete, onInnerSpinComplete, disabled, highlightedUserId }, ref) => {
    const { theme } = useTheme();
    const included = useMemo(() => participants.filter((p) => p.included), [participants]);
    const outerCount = included.length;
    const innerCount = percentages.length;

    const outerRotation = useSharedValue(0);
    const innerRotation = useSharedValue(0);
    const isOuterSpinning = useRef(false);
    const isInnerSpinning = useRef(false);

    const handleOuterDone = useCallback(
      (winnerId: string) => {
        isOuterSpinning.current = false;
        successHaptic();
        onOuterSpinComplete(winnerId);
      },
      [onOuterSpinComplete],
    );

    const handleInnerDone = useCallback(
      (pct: number) => {
        isInnerSpinning.current = false;
        successHaptic();
        onInnerSpinComplete(pct);
      },
      [onInnerSpinComplete],
    );

    useImperativeHandle(
      ref,
      () => ({
        spinOuter: (winnerIndex: number) => {
          if (isOuterSpinning.current || outerCount < 1) return;
          isOuterSpinning.current = true;
          heavyHaptic();

          const segAngle = 360 / outerCount;
          const targetCenter = winnerIndex * segAngle + segAngle / 2;
          const jitter = (cryptoRandom() - 0.5) * segAngle * 0.6;
          const landing = 360 - targetCenter + jitter;

          cancelAnimation(outerRotation);
          outerRotation.value = 0;

          const spins = (5 + Math.floor(cryptoRandom() * 5)) * 360;
          const target = spins + ((landing % 360) + 360) % 360;
          const duration = 3000 + cryptoRandom() * 1500;
          const winnerId = included[winnerIndex].id;

          outerRotation.value = withTiming(
            target,
            { duration, easing: Easing.bezier(0.12, 0.84, 0.22, 1) },
            (finished) => {
              if (finished) runOnJS(handleOuterDone)(winnerId);
            },
          );
        },

        spinInner: (winnerIndex: number) => {
          if (isInnerSpinning.current || innerCount < 1) return;
          isInnerSpinning.current = true;
          heavyHaptic();

          const segAngle = 360 / innerCount;
          const targetCenter = winnerIndex * segAngle + segAngle / 2;
          const jitter = (cryptoRandom() - 0.5) * segAngle * 0.6;
          const landing = 360 - targetCenter + jitter;

          cancelAnimation(innerRotation);
          innerRotation.value = 0;

          const spins = (4 + Math.floor(cryptoRandom() * 4)) * 360;
          const target = spins + ((landing % 360) + 360) % 360;
          const duration = 2500 + cryptoRandom() * 1500;
          const pct = percentages[winnerIndex];

          innerRotation.value = withTiming(
            target,
            { duration, easing: Easing.bezier(0.12, 0.84, 0.22, 1) },
            (finished) => {
              if (finished) runOnJS(handleInnerDone)(pct);
            },
          );
        },
      }),
      [outerCount, innerCount, included, percentages, outerRotation, innerRotation, handleOuterDone, handleInnerDone],
    );

    useEffect(() => {
      return () => {
        cancelAnimation(outerRotation);
        cancelAnimation(innerRotation);
      };
    }, [outerRotation, innerRotation]);

    const outerStyle = useAnimatedStyle(() => ({
      transform: [{ rotate: `${outerRotation.value}deg` }],
    }));

    const innerStyle = useAnimatedStyle(() => ({
      transform: [{ rotate: `${innerRotation.value}deg` }],
    }));

    // ── Build outer ring segments (participants) ────────────────────────
    const outerSegments = useMemo(() => {
      if (outerCount < 1) return null;
      const segAngle = 360 / outerCount;
      return included.map((p, i) => {
        const start = i * segAngle;
        const end = start + segAngle;
        const mid = start + segAngle / 2;
        const color = OUTER_COLORS[i % OUTER_COLORS.length];
        const isHl = highlightedUserId === p.id;
        const labelR = (OUTER_R + OUTER_INNER_R) / 2;
        const labelPos = polarToCartesian(CX, CY, labelR, mid);
        const path = describeArc(CX, CY, OUTER_R, OUTER_INNER_R, start, end);

        return (
          <G key={p.id}>
            <Path d={path} fill={isHl ? '#FFD700' : color} stroke="rgba(0,0,0,0.35)" strokeWidth={1.5} />
            <SvgText
              x={labelPos.x}
              y={labelPos.y}
              fill={isHl ? '#000' : '#FFF'}
              fontSize={outerCount > 6 ? 9 : 12}
              fontWeight="700"
              textAnchor="middle"
              alignmentBaseline="central"
              transform={`rotate(${mid}, ${labelPos.x}, ${labelPos.y})`}
            >
              {outerCount > 8 ? getInitials(p.name) : p.name.length > 7 ? p.name.slice(0, 6) + '…' : p.name}
            </SvgText>
          </G>
        );
      });
    }, [included, outerCount, highlightedUserId]);

    // ── Build inner ring segments (percentages) ─────────────────────────
    const innerSegments = useMemo(() => {
      if (innerCount < 1) return null;
      const segAngle = 360 / innerCount;
      return percentages.map((pct, i) => {
        const start = i * segAngle;
        const end = start + segAngle;
        const mid = start + segAngle / 2;
        const color = INNER_COLORS[i % INNER_COLORS.length];
        const labelR = (INNER_R + INNER_INNER_R) / 2;
        const labelPos = polarToCartesian(CX, CY, labelR, mid);
        const path = describeArc(CX, CY, INNER_R, INNER_INNER_R, start, end);

        return (
          <G key={`pct-${i}`}>
            <Path d={path} fill={color} stroke="rgba(0,0,0,0.25)" strokeWidth={1} />
            <SvgText
              x={labelPos.x}
              y={labelPos.y}
              fill="#FFF"
              fontSize={11}
              fontWeight="700"
              textAnchor="middle"
              alignmentBaseline="central"
              transform={`rotate(${mid}, ${labelPos.x}, ${labelPos.y})`}
            >
              {pct}%
            </SvgText>
          </G>
        );
      });
    }, [percentages, innerCount]);

    if (outerCount < 2) {
      return (
        <View style={s.container}>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}
          >
            Need at least 2 participants for the weighted wheel
          </Text>
        </View>
      );
    }

    return (
      <View style={s.container}>
        {/* Pointer triangle at top */}
        <View style={s.pointer}>
          <Svg width={30} height={22} viewBox="0 0 30 22">
            <Path d="M15 22 L0 0 L30 0 Z" fill={theme.colors.primary} stroke="#FFF" strokeWidth={1.5} />
          </Svg>
        </View>

        {/* Wheel area — both rings stacked */}
        <View style={s.wheelArea}>
          {/* Outer ring (spins independently) */}
          <Animated.View style={[s.ringLayer, outerStyle]}>
            <Svg width={WHEEL_SIZE} height={WHEEL_SIZE} viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}>
              <Circle cx={CX} cy={CY} r={OUTER_R + 3} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={6} />
              {outerSegments}
            </Svg>
            {/* Rim dots */}
            <View style={[s.dotRing, { opacity: disabled ? 0.3 : 0.6 }]}>
              {Array.from({ length: 20 }).map((_, i) => {
                const angle = (i * 360) / 20;
                const pos = polarToCartesian(WHEEL_SIZE / 2, WHEEL_SIZE / 2, OUTER_R + 8, angle);
                return (
                  <View
                    key={i}
                    style={[
                      s.rimDot,
                      {
                        left: pos.x - 2,
                        top: pos.y - 2,
                        backgroundColor: i % 2 === 0 ? '#FFD700' : '#FF6B6B',
                      },
                    ]}
                  />
                );
              })}
            </View>
          </Animated.View>

          {/* Inner ring (spins independently) */}
          <Animated.View style={[s.ringLayer, innerStyle]}>
            <Svg width={WHEEL_SIZE} height={WHEEL_SIZE} viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}>
              {innerSegments}
              {/* Center hub */}
              <Circle cx={CX} cy={CY} r={HUB_R} fill="#1A1A2E" stroke="rgba(255,255,255,0.2)" strokeWidth={2} />
              <Circle cx={CX} cy={CY} r={HUB_R - 5} fill="#0F0F23" />
            </Svg>
          </Animated.View>

          {/* Ring separator glow (stationary) */}
          <View style={s.separatorRing} pointerEvents="none">
            <Svg width={WHEEL_SIZE} height={WHEEL_SIZE} viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}>
              <Circle
                cx={CX}
                cy={CY}
                r={(OUTER_INNER_R + INNER_R) / 2}
                fill="none"
                stroke="rgba(255,255,255,0.15)"
                strokeWidth={1.5}
              />
            </Svg>
          </View>

          {/* Center emoji — stationary */}
          <View style={s.centerEmoji} pointerEvents="none">
            <Text style={s.emojiText}>⚖️</Text>
          </View>
        </View>

        {/* Ring legend */}
        <View style={s.ringLabels}>
          <View style={s.legendItem}>
            <View style={[s.legendDot, { backgroundColor: '#6366F1' }]} />
            <Text style={[s.ringLabel, { color: theme.colors.onSurfaceVariant }]}>Outer: People</Text>
          </View>
          <View style={s.legendItem}>
            <View style={[s.legendDot, { backgroundColor: '#4ECDC4' }]} />
            <Text style={[s.ringLabel, { color: theme.colors.onSurfaceVariant }]}>Inner: Percentage</Text>
          </View>
        </View>
      </View>
    );
  },
);

WeightedRouletteWheel.displayName = 'WeightedRouletteWheel';
export default WeightedRouletteWheel;

// ── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  pointer: {
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
  ringLayer: {
    position: 'absolute',
    width: WHEEL_SIZE,
    height: WHEEL_SIZE,
  },
  separatorRing: {
    position: 'absolute',
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
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  centerEmoji: {
    position: 'absolute',
    width: HUB_R * 2,
    height: HUB_R * 2,
    borderRadius: HUB_R,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  emojiText: {
    fontSize: 20,
  },
  ringLabels: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 20,
    marginTop: 10,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  ringLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
});
