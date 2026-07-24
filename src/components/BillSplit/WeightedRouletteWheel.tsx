import { useTheme } from '@/context/ThemeContext';
import { heavyHaptic, successHaptic } from '@/utils/haptics';
import { resolveInitials } from '@/utils/identity';
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
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

// Same harmonised palette as the main roulette wheel — people get colour.
export const OUTER_COLORS = [
  '#6D7CFF', '#3EC1B0', '#F2789F', '#E8B94E', '#7FBF6C',
  '#A78BFA', '#58A6E8', '#E8926B', '#5BC4DC', '#D98BC5',
  '#95B84E', '#F27E6B',
];

// Percentages ring stays quiet — alternating slate tones so the people ring
// carries the colour and the two rings read as different instruments.
const INNER_COLORS = [
  '#5C6B8A', '#7C89A8', '#4A5570', '#8E9BB8',
  '#535E7E', '#6B7896', '#424C66', '#7E8CAD',
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
  /** Unallocated share shown in the stationary hub. */
  remainingPct?: number;
  /** The hub IS the spin button — tap the center of the wheel to spin. */
  onHubPress?: () => void;
  /** Stable palette index per user id, so a person keeps their colour across
      rounds (and it matches the progress bar) even as the ring shrinks. */
  colorIndexById?: Record<string, number>;
}

// ── Component ────────────────────────────────────────────────────────────────
const WeightedRouletteWheel = React.forwardRef<WeightedRouletteWheelRef, Props>(
  ({ participants, percentages, onOuterSpinComplete, onInnerSpinComplete, disabled, highlightedUserId, remainingPct, onHubPress, colorIndexById }, ref) => {
    const { theme } = useTheme();
    const separatorColor = theme.dark ? 'rgba(13,15,20,1)' : 'rgba(250,250,252,1)';
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
        const color = OUTER_COLORS[(colorIndexById?.[p.id] ?? i) % OUTER_COLORS.length];
        const isHl = highlightedUserId === p.id;
        const labelR = (OUTER_R + OUTER_INNER_R) / 2;
        const labelPos = polarToCartesian(CX, CY, labelR, mid);
        const path = describeArc(CX, CY, OUTER_R, OUTER_INNER_R, start, end);

        return (
          <G key={p.id}>
            <Path
              d={path}
              fill={isHl ? theme.colors.primary : color}
              stroke={isHl ? '#FFFFFF' : separatorColor}
              strokeWidth={isHl ? 3 : 2.5}
            />
            <SvgText
              x={labelPos.x}
              y={labelPos.y}
              fill="#FFF"
              fontSize={outerCount > 6 ? 9 : 12}
              fontWeight="700"
              textAnchor="middle"
              alignmentBaseline="central"
              transform={`rotate(${mid}, ${labelPos.x}, ${labelPos.y})`}
            >
              {outerCount > 8 ? resolveInitials(p.name) : p.name.length > 7 ? p.name.slice(0, 6) + '…' : p.name}
            </SvgText>
          </G>
        );
      });
    }, [included, outerCount, highlightedUserId, separatorColor, theme.colors.primary, colorIndexById]);

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
            <Path d={path} fill={color} stroke={separatorColor} strokeWidth={1.5} />
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
    }, [percentages, innerCount, separatorColor]);

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

    const hubBg = theme.dark ? '#1C1F26' : '#FFFFFF';
    const hubBorder = theme.dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.10)';

    return (
      <View style={s.container}>
        {/* Pointer at top — accent, rounded */}
        <View style={s.pointer}>
          <Svg width={26} height={20} viewBox="0 0 26 20">
            <Path
              d="M13 20 L2.5 3 Q1.5 0.5 4.5 0.5 L21.5 0.5 Q24.5 0.5 23.5 3 Z"
              fill={theme.colors.primary}
            />
          </Svg>
        </View>

        {/* Wheel area — both rings stacked */}
        <View style={s.wheelArea}>
          {/* Outer ring (spins independently) */}
          <Animated.View style={[s.ringLayer, outerStyle]}>
            <Svg width={WHEEL_SIZE} height={WHEEL_SIZE} viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}>
              {outerSegments}
              <Circle
                cx={CX}
                cy={CY}
                r={OUTER_R}
                fill="none"
                stroke={theme.dark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)'}
                strokeWidth={1}
              />
            </Svg>
          </Animated.View>

          {/* Inner ring (spins independently) */}
          <Animated.View style={[s.ringLayer, innerStyle]}>
            <Svg width={WHEEL_SIZE} height={WHEEL_SIZE} viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}>
              {innerSegments}
            </Svg>
          </Animated.View>

          {/* Stationary hub — the spin button, showing what's up for grabs */}
          {(() => {
            const actionable = Boolean(onHubPress) && !disabled && (remainingPct ?? 100) > 0;
            return (
              <Pressable
                onPress={actionable ? onHubPress : undefined}
                disabled={!actionable}
                accessibilityRole="button"
                accessibilityLabel={actionable ? 'Spin the wheels' : undefined}
                style={({ pressed }) => [
                  s.hub,
                  actionable
                    ? { backgroundColor: theme.colors.primary, borderColor: 'rgba(255,255,255,0.25)' }
                    : { backgroundColor: hubBg, borderColor: hubBorder },
                  pressed && actionable && { transform: [{ scale: 0.94 }] },
                ]}
              >
                <Text style={[s.hubLabel, { color: actionable ? 'rgba(255,255,255,0.85)' : theme.colors.onSurfaceVariant }]}>
                  {actionable ? 'SPIN' : 'LEFT'}
                </Text>
                <Text
                  style={[s.hubValue, { color: actionable ? '#FFFFFF' : theme.colors.onSurface }]}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                >
                  {Math.max(0, remainingPct ?? 100)}%
                </Text>
              </Pressable>
            );
          })()}
        </View>

        {/* Ring legend */}
        <View style={s.ringLabels}>
          <Text style={[s.ringLabel, { color: theme.colors.onSurfaceVariant }]}>Outer: People</Text>
          <Text style={[s.ringLabel, { color: theme.colors.onSurfaceVariant }]}>·</Text>
          <Text style={[s.ringLabel, { color: theme.colors.onSurfaceVariant }]}>Inner: Percentage</Text>
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
  hub: {
    position: 'absolute',
    width: (HUB_R - 2) * 2,
    height: (HUB_R - 2) * 2,
    borderRadius: HUB_R - 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    zIndex: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 4,
  },
  hubLabel: {
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  hubValue: {
    fontSize: 17,
    fontWeight: '800',
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
