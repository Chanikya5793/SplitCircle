// The app's segmented control (Appearance mode, Glass/Flat, Calls All/Missed).
//
// WHY THIS EXISTS rather than react-native-paper's `SegmentedButtons`
// (2026-08-08). Paper sizes the control's INNER touchable itself, so a
// `minHeight` on a button's `style` grows only the painted box: measured on a
// Pixel 7, the Appearance rows painted 48dp tall while the accessibility node —
// and therefore the ripple and the tappable area — stayed 36dp and sat at the
// TOP of it. So the control looked too tall, the bottom ~12dp did nothing, and
// the highlight never lined up with the shape it was highlighting. Half-working
// was worse than not applying the floor at all.
//
// Here the segment IS the Pressable, so its height, its fill and its touch area
// are one box by construction and cannot drift apart.
//
// LOOKING NATIVE is the point, and it takes three things, not one:
//   1. The container is real Liquid Glass (role="glass"), like the tab bar.
//   2. The THUMB is its own glass capsule that SLIDES between segments. This is
//      what actually reads as native — UISegmentedControl animates its selection
//      and never jump-cuts, and a thumb that teleports is the single clearest
//      tell that a control is hand-rolled. It is one shared element that
//      animates its x/width, not per-segment backgrounds being toggled.
//   3. Apple's thumb is NEUTRAL: UISegmentedControl never tints it with the
//      app's accent, it lifts a light capsule and leaves colour to the label.
//
// The lift is a tight shadow, never `elevation` — on Android an elevated child
// escapes the container's clip and paints a hard-cornered box inside the pill,
// which is the original bug this control was rebuilt to fix.

import { GlassCard } from './GlassCard';
import { useTheme } from '@/context/ThemeContext';
import { isAccessibilityTextSize } from '@/utils/a11yText';
import { selectionHaptic } from '@/utils/haptics';
import { useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import { Icon, Text } from 'react-native-paper';

/**
 * Apple's own UISegmentedControl is 32pt tall, and matching it is the whole
 * point — at a 44pt segment (50pt container) this read as a chunky custom
 * control sitting next to native chrome, not as part of it.
 *
 * The 44pt touch target is preserved by HIT SLOP instead of by height, the same
 * trade the accent swatches already make. Vertical only: the segments sit side
 * by side, so horizontal slop would make neighbouring targets overlap and the
 * boundary between them ambiguous.
 */
const SEGMENT_HEIGHT = 32;
const SEGMENT_PADDING = 2;
const HIT_SLOP_Y = Math.ceil((44 - SEGMENT_HEIGHT) / 2);

/** Measured off UISegmentedControl: a short, firm ease — not a spring. */
const THUMB_MS = 220;

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
  /** MaterialCommunityIcons name. Dropped at accessibility text sizes so the
   *  label keeps the width instead of being truncated to make room for it. */
  icon?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedControlOption<T>[];
  style?: StyleProp<ViewStyle>;
  /** Announced as the group's name, e.g. "Appearance". */
  accessibilityLabel?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  style,
  accessibilityLabel,
}: SegmentedControlProps<T>) {
  const { theme, isDark } = useTheme();
  const bigText = isAccessibilityTextSize(theme?.fontScale ?? 1);
  const reduceMotion = theme?.reduceMotion === true;

  // Track width drives the thumb's geometry. Measured rather than assumed: the
  // control is used at a fixed width in Calls and full-width in Settings.
  const [trackWidth, setTrackWidth] = useState(0);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const segmentWidth = trackWidth > 0 ? trackWidth / options.length : 0;

  const thumbX = useSharedValue(0);
  const onTrackLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    setTrackWidth(width);
    // Position without animating on first measure, or the thumb slides in from
    // the left edge every time the screen mounts.
    thumbX.value = (width / options.length) * index;
  };

  const thumbStyle = useAnimatedStyle(() => ({
    width: segmentWidth,
    transform: [{ translateX: thumbX.value }],
  }));

  // Drive the slide from render so it also follows a value change made
  // elsewhere (deep link, another control), not only from onPress.
  if (segmentWidth > 0) {
    const target = segmentWidth * index;
    if (thumbX.value !== target) {
      thumbX.value = reduceMotion
        ? target
        : withTiming(target, { duration: THUMB_MS, easing: Easing.out(Easing.cubic) });
    }
  }

  return (
    // The group role lives on a wrapper rather than on GlassCard: that
    // primitive backs 244 surfaces and takes no accessibility props, and this
    // is not a good reason to widen its API. radiogroup so a screen reader
    // announces "1 of 3 selected" instead of three unrelated buttons.
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={style}>
      <GlassCard role="glass" radius={50} contentStyle={styles.row}>
        <View style={styles.track} onLayout={onTrackLayout}>
          {segmentWidth > 0 ? (
            <Animated.View style={[styles.thumb, thumbStyle]} pointerEvents="none">
              {/* The thumb is its own glass surface, so on iOS 26 the selection
                  is real material layered over the track's material — the same
                  thing UISegmentedControl does — rather than a flat fill. */}
              <GlassCard
                role="glass"
                radius={50}
                style={[
                  styles.thumbSurface,
                  { backgroundColor: isDark ? 'rgba(120,120,128,0.40)' : 'rgba(255,255,255,0.72)' },
                ]}
                contentStyle={styles.thumbSurface}
              >
                <View />
              </GlassCard>
            </Animated.View>
          ) : null}

          {options.map((option) => {
            const selected = option.value === value;
            return (
              <Pressable
                key={option.value}
                onPress={() => {
                  if (selected) return;
                  selectionHaptic();
                  onChange(option.value);
                }}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, selected }}
                accessibilityLabel={option.label}
                hitSlop={{ top: HIT_SLOP_Y, bottom: HIT_SLOP_Y }}
                style={styles.segment}
              >
                {option.icon && !bigText ? (
                  <Icon
                    source={option.icon}
                    size={15}
                    color={selected ? theme.colors.onSurface : theme.colors.onSurfaceVariant}
                  />
                ) : null}
                <Text
                  variant="labelLarge"
                  numberOfLines={1}
                  style={{
                    color: selected ? theme.colors.onSurface : theme.colors.onSurfaceVariant,
                    fontWeight: selected ? '600' : '400',
                  }}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </GlassCard>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    padding: SEGMENT_PADDING,
  },
  track: {
    flexDirection: 'row',
    position: 'relative',
  },
  thumb: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: 50,
    // Apple's lift: short, soft, close to the surface.
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  thumbSurface: {
    flex: 1,
    borderRadius: 50,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: SEGMENT_HEIGHT,
    paddingHorizontal: 8,
  },
});
