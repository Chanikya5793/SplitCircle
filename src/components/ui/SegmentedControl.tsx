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
// are one box by construction and cannot drift apart. That also lets the
// container and the segments share a pill radius — Paper draws square corners on
// middle segments by MD3 design, which read as a rectangle nested in a pill.
//
// The selected segment is marked by FILL ALONE — no shadow, no elevation. An
// elevated child escapes the container's clip on Android: the shadow spills past
// the rounded corner and the lifted background paints a hard-cornered rectangle
// inside the pill. `primaryContainer`/`onPrimaryContainer` is the palette's own
// paired fill+foreground, so it reads in both schemes and against every accent.

import { GlassCard } from './GlassCard';
import { useTheme } from '@/context/ThemeContext';
import { isAccessibilityTextSize } from '@/utils/a11yText';
import { selectionHaptic } from '@/utils/haptics';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, Text } from 'react-native-paper';

/** HIG minimum touch target. The container adds its 3pt padding on top. */
const SEGMENT_HEIGHT = 44;

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
  const { theme } = useTheme();
  const bigText = isAccessibilityTextSize(theme?.fontScale ?? 1);

  return (
    // The group role lives on a wrapper rather than on GlassCard: that
    // primitive backs 244 surfaces and takes no accessibility props, and this
    // is not a good reason to widen its API. radiogroup so a screen reader
    // announces "1 of 3 selected" instead of three unrelated buttons.
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={style}>
    <GlassCard role="floating" radius={50} contentStyle={styles.row}>
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
            style={({ pressed }) => [
              styles.segment,
              selected && { backgroundColor: theme.colors.primaryContainer },
              // Pressed feedback on the UNSELECTED segments only — a selected
              // segment already has the accent fill and re-tapping it is a
              // no-op, so flashing it would signal a change that never happens.
              pressed && !selected && {
                backgroundColor: theme?.colors?.pressHighlight ?? 'rgba(0,0,0,0.10)',
              },
            ]}
          >
            {option.icon && !bigText ? (
              <Icon
                source={option.icon}
                size={18}
                color={selected ? theme.colors.onPrimaryContainer : theme.colors.onSurfaceVariant}
              />
            ) : null}
            <Text
              variant="labelLarge"
              numberOfLines={1}
              style={{
                color: selected ? theme.colors.onPrimaryContainer : theme.colors.onSurfaceVariant,
                fontWeight: selected ? '700' : '500',
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </GlassCard>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    padding: 3,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: SEGMENT_HEIGHT,
    paddingHorizontal: 8,
    borderRadius: 50,
  },
});
