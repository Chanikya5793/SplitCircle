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
  // Apple's selected segment is a NEUTRAL elevated capsule, not an accent tint
  // — UISegmentedControl never colours its thumb by the app's tint. Accent
  // colour lives on the LABEL instead, which is also what iOS does.
  //
  // Safe to be near-white now that the container is real glass: an earlier
  // near-white thumb was invisible, but that was against an opaque near-white
  // container. Against translucent material it reads clearly in both schemes.
  const thumbFill = isDark ? 'rgba(120,120,128,0.44)' : 'rgba(255,255,255,0.92)';

  return (
    // The group role lives on a wrapper rather than on GlassCard: that
    // primitive backs 244 surfaces and takes no accessibility props, and this
    // is not a good reason to widen its API. radiogroup so a screen reader
    // announces "1 of 3 selected" instead of three unrelated buttons.
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={style}>
    {/* role="glass", not "floating": this is CHROME, and on iOS 26 it should be
        the real Liquid Glass material like the tab bar beside it. "floating"
        follows the user's flat/glass preference and so renders an opaque fill
        in flat mode — correct for a sheet, wrong for a system-style control
        that is meant to look native regardless. role="glass" opts out of that
        preference while still honouring Reduce Transparency. */}
    <GlassCard role="glass" radius={50} contentStyle={styles.row}>
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
            style={({ pressed }) => [
              styles.segment,
              selected && [styles.segmentSelected, { backgroundColor: thumbFill }],
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
    </GlassCard>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    padding: SEGMENT_PADDING,
  },
  /** The thumb's lift. Apple's is a soft, tight shadow — not elevation, which
   *  on Android escapes the container's clip and paints a hard-cornered box
   *  inside the pill (the bug this control was rebuilt to fix). */
  segmentSelected: {
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: SEGMENT_HEIGHT,
    paddingHorizontal: 8,
    borderRadius: 50,
  },
});
