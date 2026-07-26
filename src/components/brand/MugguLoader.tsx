import { mugguMotion } from '@/theme/brand';
import { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  Extrapolation,
  cancelAnimation,
  interpolate,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { getMugguColors, MugguMark, type MugguVariant } from './MugguMark';
import {
  MUGGU_CENTER_STAGE,
  MUGGU_DOTS,
  MUGGU_DOT_STAGES,
  MUGGU_LONG_LENGTH,
  MUGGU_LONG_PATH,
  MUGGU_PETAL_STAGES,
  MUGGU_SHORT_LENGTH,
  MUGGU_SHORT_PATH,
} from './mugguGeometry';
import { useReduceMotion } from './useReduceMotion';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedG = Animated.createAnimatedComponent(G);

const stageProgress = (value: number, start: number, end: number) => {
  'worklet';
  return interpolate(value, [start, end], [0, 1], Extrapolation.CLAMP);
};

interface AnimatedStrokeProps {
  progress: SharedValue<number>;
  d: string;
  length: number;
  start: number;
  end: number;
  color: string;
}

const AnimatedStroke = ({
  progress,
  d,
  length,
  start,
  end,
  color,
}: AnimatedStrokeProps) => {
  const animatedProps = useAnimatedProps(() => {
    const drawn = stageProgress(progress.value, start, end);
    return {
      strokeDashoffset: length * (1 - drawn),
    };
  });

  return (
    <AnimatedPath
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={7.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={length}
      strokeDashoffset={length}
      animatedProps={animatedProps}
    />
  );
};

interface AnimatedPopProps {
  progress: SharedValue<number>;
  cx: number;
  cy: number;
  radius: number;
  start: number;
  peak: number;
  end: number;
  color: string;
}

const AnimatedPop = ({
  progress,
  cx,
  cy,
  radius,
  start,
  peak,
  end,
  color,
}: AnimatedPopProps) => {
  const animatedProps = useAnimatedProps(() => {
    const value = progress.value;
    const opacity = interpolate(
      value,
      [start, Math.min(start + 0.002, peak), end],
      [0, 1, 1],
      Extrapolation.CLAMP,
    );
    const animatedRadius = interpolate(
      value,
      [start, peak, end],
      [0, radius * 1.35, radius],
      Extrapolation.CLAMP,
    );
    return { opacity, r: animatedRadius };
  });

  return (
    <AnimatedCircle
      cx={cx}
      cy={cy}
      r={0}
      fill={color}
      animatedProps={animatedProps}
    />
  );
};

const cubicPoint = (
  t: number,
  p0: number,
  p1: number,
  p2: number,
  p3: number,
) => {
  'worklet';
  const oneMinusT = 1 - t;
  return (
    oneMinusT * oneMinusT * oneMinusT * p0 +
    3 * oneMinusT * oneMinusT * t * p1 +
    3 * oneMinusT * t * t * p2 +
    t * t * t * p3
  );
};

const longPenPoint = (value: number) => {
  'worklet';
  // The first cubic occupies about one third of the measured 92.541-unit path.
  const split = 0.335;
  if (value <= split) {
    const t = value / split;
    return {
      x: cubicPoint(t, 41.1989, 43.2975, 49.8657, 60),
      y: cubicPoint(t, 30.3497, 22.9415, 16.2226, 12),
    };
  }
  const t = (value - split) / (1 - split);
  return {
    x: cubicPoint(t, 60, 84, 88, 60),
    y: cubicPoint(t, 12, 22, 46, 60),
  };
};

const shortPenPoint = (value: number) => {
  'worklet';
  return {
    x: cubicPoint(value, 60, 54.5593, 50.3268, 47.2145),
    y: cubicPoint(value, 60, 57.2796, 54.1817, 50.8823),
  };
};

interface AnimatedPenProps {
  progress: SharedValue<number>;
  start: number;
  end: number;
  color: string;
  path: 'long' | 'short';
}

const AnimatedPen = ({ progress, start, end, color, path }: AnimatedPenProps) => {
  const animatedProps = useAnimatedProps(() => {
    const value = stageProgress(progress.value, start, end);
    const point = path === 'long' ? longPenPoint(value) : shortPenPoint(value);
    const edge = Math.min(0.004, (end - start) * 0.2);
    const opacity = interpolate(
      progress.value,
      [start, start + edge, end - edge, end],
      [0, 1, 1, 0],
      Extrapolation.CLAMP,
    );
    return { cx: point.x, cy: point.y, opacity };
  });

  return (
    <AnimatedCircle
      cx={60}
      cy={60}
      r={3.1}
      fill={color}
      animatedProps={animatedProps}
    />
  );
};

interface AnimatedPetalProps {
  progress: SharedValue<number>;
  index: number;
  color: string;
  showPen: boolean;
}

const AnimatedPetal = ({ progress, index, color, showPen }: AnimatedPetalProps) => {
  const stage = MUGGU_PETAL_STAGES[index];

  return (
    <G transform={`rotate(${index * 90} 60 60)`}>
      <AnimatedStroke
        progress={progress}
        d={MUGGU_LONG_PATH}
        length={MUGGU_LONG_LENGTH}
        start={stage.longStart}
        end={stage.longEnd}
        color={color}
      />
      <AnimatedStroke
        progress={progress}
        d={MUGGU_SHORT_PATH}
        length={MUGGU_SHORT_LENGTH}
        start={stage.shortStart}
        end={stage.shortEnd}
        color={color}
      />
      {showPen && (
        <>
          <AnimatedPen
            progress={progress}
            start={stage.longStart}
            end={stage.longEnd}
            color={color}
            path="long"
          />
          <AnimatedPen
            progress={progress}
            start={stage.shortStart}
            end={stage.shortEnd}
            color={color}
            path="short"
          />
        </>
      )}
    </G>
  );
};

export interface MugguLoaderProps {
  size?: number;
  variant?: MugguVariant;
  showPen?: boolean;
  loop?: boolean;
  initialState?: 'blank' | 'complete';
  startDelayMs?: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export const MugguLoader = ({
  size = 48,
  variant = 'primary',
  showPen = size >= 72,
  loop = true,
  initialState = 'blank',
  startDelayMs = 0,
  accessibilityLabel = 'Loading',
  style,
  testID = 'muggu-loader',
}: MugguLoaderProps) => {
  const reduceMotion = useReduceMotion();
  const colors = getMugguColors(variant);
  const progress = useSharedValue(
    initialState === 'complete' ? mugguMotion.completeProgress : 0,
  );

  useEffect(() => {
    cancelAnimation(progress);

    if (reduceMotion) {
      progress.value = mugguMotion.completeProgress;
      return;
    }

    const start = () => {
      if (!loop) {
        progress.value = 0;
        progress.value = withTiming(mugguMotion.completeProgress, {
          duration: Math.round(mugguMotion.cycleMs * mugguMotion.completeProgress),
          easing: Easing.linear,
        });
        return;
      }

      if (initialState === 'complete') {
        progress.value = withSequence(
          withTiming(1, { duration: 220, easing: Easing.linear }),
          withTiming(0, { duration: 0 }),
          withRepeat(
            withTiming(1, { duration: mugguMotion.cycleMs, easing: Easing.linear }),
            -1,
            false,
          ),
        );
        return;
      }

      progress.value = 0;
      progress.value = withRepeat(
        withTiming(1, { duration: mugguMotion.cycleMs, easing: Easing.linear }),
        -1,
        false,
      );
    };

    const timer = setTimeout(start, startDelayMs);
    return () => {
      clearTimeout(timer);
      cancelAnimation(progress);
    };
  }, [initialState, loop, progress, reduceMotion, startDelayMs]);

  const groupProps = useAnimatedProps(() => ({
    opacity: interpolate(
      progress.value,
      [0, mugguMotion.fadeStartProgress, 1],
      [1, 1, 0],
      Extrapolation.CLAMP,
    ),
  }));

  if (reduceMotion) {
    return (
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ busy: true }}
        style={style}
        testID={testID}
      >
        <MugguMark size={size} variant={variant} />
      </View>
    );
  }

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: true }}
      style={[{ width: size, height: size }, style]}
      testID={testID}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 120 120"
        fill="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <AnimatedG animatedProps={groupProps}>
          {colors.petals.map((color, index) => (
            <AnimatedPetal
              key={`petal-${index}`}
              progress={progress}
              index={index}
              color={color}
              showPen={showPen}
            />
          ))}
          <AnimatedPop
            progress={progress}
            cx={60}
            cy={60}
            radius={8.5}
            start={MUGGU_CENTER_STAGE.start}
            peak={MUGGU_CENTER_STAGE.peak}
            end={MUGGU_CENTER_STAGE.end}
            color={colors.center}
          />
          {MUGGU_DOTS.map((dot, index) => {
            const stage = MUGGU_DOT_STAGES[index];
            return (
              <AnimatedPop
                key={`dot-${index}`}
                progress={progress}
                cx={dot.cx}
                cy={dot.cy}
                radius={4.2}
                start={stage.start}
                peak={stage.peak}
                end={stage.end}
                color={colors.dots}
              />
            );
          })}
        </AnimatedG>
      </Svg>
    </View>
  );
};

export const InlineMugguLoader = (
  props: Omit<MugguLoaderProps, 'size' | 'showPen'>,
) => <MugguLoader {...props} size={26} showPen={false} />;
