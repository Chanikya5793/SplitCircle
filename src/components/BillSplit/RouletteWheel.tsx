import { useTheme } from '@/context/ThemeContext';
import { formatCurrency } from '@/utils/currency';
import { heavyHaptic, selectionHaptic, successHaptic } from '@/utils/haptics';
import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import Animated, {
    Easing,
    cancelAnimation,
    runOnJS,
    useAnimatedReaction,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, G, Path, Text as SvgText } from 'react-native-svg';
import type { Participant } from './types';

// ── Constants ────────────────────────────────────────────────────────────────
const WHEEL_SIZE = 280;
const CENTER = WHEEL_SIZE / 2;
const RADIUS = CENTER - 6;
const INNER_RADIUS = 52;

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

// Harmonised, softened hues — distinct enough to tell people apart, calm
// enough to sit inside the app instead of a casino carpet.
const SEGMENT_COLORS = [
  '#6D7CFF', // periwinkle
  '#3EC1B0', // teal
  '#F2789F', // rose
  '#E8B94E', // gold
  '#7FBF6C', // green
  '#A78BFA', // violet
  '#58A6E8', // sky
  '#E8926B', // coral
  '#5BC4DC', // cyan
  '#D98BC5', // orchid
  '#95B84E', // olive
  '#F27E6B', // salmon
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
  /** The pot shown in the stationary hub — the stake belongs in the middle. */
  totalAmount: number;
  currency: string;
  /** When settled, the winning segment stays lit and the rest recede. */
  winnerId?: string | null;
}

// ── Component ────────────────────────────────────────────────────────────────
const RouletteWheel = React.forwardRef<RouletteWheelRef, RouletteWheelProps>(
  ({ participants, onSpinComplete, disabled, totalAmount, currency, winnerId }, ref) => {
    const { theme } = useTheme();
    const included = useMemo(() => participants.filter((p) => p.included), [participants]);
    const segmentCount = included.length;

    // Rotation state – cumulative degrees (can exceed 360)
    const rotation = useSharedValue(0);
    const isAnimating = useRef(false);

    const handleSpinDone = useCallback(
      (winnerId: string) => {
        isAnimating.current = false;
        successHaptic();
        onSpinComplete(winnerId);
      },
      [onSpinComplete],
    );

    // Casino "clack" — a light haptic every time a segment boundary passes the
    // pointer. Fires at most once per frame (the reaction runs per frame, not
    // per boundary), so the tick rate naturally follows the wheel: a blur of
    // clicks off the line, slowing to individual clacks as it decides. This is
    // most of the game feel.
    useAnimatedReaction(
      () => (segmentCount > 0 ? Math.floor(rotation.value / (360 / segmentCount)) : 0),
      (crossed, previous) => {
        if (previous !== null && crossed !== previous) {
          runOnJS(selectionHaptic)();
        }
      },
      [segmentCount],
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
    // Separators are strokes in the canvas colour, so segments read as clean
    // petals instead of a hard-edged pie chart.
    const separatorColor = theme.dark ? 'rgba(13,15,20,1)' : 'rgba(250,250,252,1)';

    const segments = useMemo(() => {
      if (segmentCount < 2) return null;
      return included.map((p, i) => {
        const startAngle = i * segmentAngle;
        const endAngle = startAngle + segmentAngle;
        const midAngle = startAngle + segmentAngle / 2;
        const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length];
        const isWinner = winnerId === p.id;
        const dimmed = Boolean(winnerId) && !isWinner;

        // Label position
        const labelR = (RADIUS + INNER_RADIUS) / 2 + 6;
        const labelPos = polarToCartesian(CENTER, CENTER, labelR, midAngle);

        const path = describeArc(CENTER, CENTER, RADIUS, INNER_RADIUS, startAngle, endAngle);

        return (
          <G key={p.id} opacity={dimmed ? 0.28 : 1}>
            <Path
              d={path}
              fill={color}
              stroke={isWinner ? '#FFFFFF' : separatorColor}
              strokeWidth={isWinner ? 3 : 2.5}
            />
            <SvgText
              x={labelPos.x}
              y={labelPos.y}
              fill="#FFF"
              fontSize={segmentCount > 6 ? 11 : 13}
              fontWeight="700"
              textAnchor="middle"
              alignmentBaseline="central"
              transform={`rotate(${midAngle}, ${labelPos.x}, ${labelPos.y})`}
            >
              {segmentCount > 8 ? getInitials(p.name) : p.name.length > 8 ? p.name.slice(0, 7) + '…' : p.name.split(' ')[0]}
            </SvgText>
          </G>
        );
      });
    }, [included, segmentCount, segmentAngle, winnerId, separatorColor]);

    if (segmentCount < 2) {
      return (
        <View style={styles.container}>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
            Need at least 2 participants to spin the wheel
          </Text>
        </View>
      );
    }

    const hubBg = theme.dark ? '#1C1F26' : '#FFFFFF';
    const hubBorder = theme.dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.10)';

    return (
      <View style={styles.container}>
        {/* Pointer at top — accent, rounded, quietly confident */}
        <View style={styles.pointerContainer}>
          <Svg width={26} height={20} viewBox="0 0 26 20">
            <Path
              d="M13 20 L2.5 3 Q1.5 0.5 4.5 0.5 L21.5 0.5 Q24.5 0.5 23.5 3 Z"
              fill={theme.colors.primary}
            />
          </Svg>
        </View>

        {/* Wheel area – relative container for wheel + stationary hub */}
        <View style={styles.wheelArea}>
          <Animated.View style={[styles.wheelWrapper, wheelStyle]}>
            <Svg width={WHEEL_SIZE} height={WHEEL_SIZE} viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}>
              {segments}
              {/* Single hairline outer ring */}
              <Circle
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                fill="none"
                stroke={theme.dark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)'}
                strokeWidth={1}
              />
            </Svg>
          </Animated.View>

          {/* Stationary hub — the stake sits in the middle of the wheel */}
          <View
            style={[
              styles.hub,
              { backgroundColor: hubBg, borderColor: hubBorder },
            ]}
            pointerEvents="none"
          >
            <Text style={[styles.hubLabel, { color: theme.colors.onSurfaceVariant }]}>POT</Text>
            <Text
              style={[styles.hubAmount, { color: theme.colors.onSurface }]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {formatCurrency(totalAmount, currency)}
            </Text>
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
    marginBottom: -8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
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
  hub: {
    position: 'absolute',
    width: (INNER_RADIUS - 4) * 2,
    height: (INNER_RADIUS - 4) * 2,
    borderRadius: INNER_RADIUS - 4,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 4,
  },
  hubLabel: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  hubAmount: {
    fontSize: 16,
    fontWeight: '800',
  },
});
