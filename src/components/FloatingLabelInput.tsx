import { useTheme } from '@/context/ThemeContext';
import React, { useEffect, useState } from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';
import { TextInput } from 'react-native-paper';
import Animated, { interpolate, interpolateColor, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

interface FloatingLabelInputProps extends React.ComponentProps<typeof TextInput> {
  label: string;
  containerStyle?: StyleProp<ViewStyle>;
}

export const FloatingLabelInput = ({ label, value, style, containerStyle, onFocus, onBlur, ...props }: FloatingLabelInputProps) => {
  const { theme, isDark } = useTheme();
  const [isFocused, setIsFocused] = useState(false);
  const animatedValue = useSharedValue(value ? 1 : 0);

  useEffect(() => {
    animatedValue.value = withTiming((isFocused || value) ? 1 : 0, { duration: 200 });
  }, [isFocused, value]);

  const labelStyle = useAnimatedStyle(() => {
    return {
      left: interpolate(animatedValue.value, [0, 1], [18, 15]),
      top: interpolate(animatedValue.value, [0, 1], [36, 3]),
      fontSize: interpolate(animatedValue.value, [0, 1], [19, 14]),
      color: interpolateColor(
        animatedValue.value,
        [0, 1],
        [theme.colors.onSurfaceVariant, theme.colors.onSurface]
      ),
    };
  });

  return (
    <View style={[{
      marginBottom: 0, // Spacing between this field and the next element
      paddingTop: 18   // Space reserved for the floating label at the top
    }, containerStyle]}>
      {/* `right: 0` is load-bearing, not cosmetic.

          This label is absolutely positioned and its fontSize is animated on
          the UI thread, so its box is measured ONCE at the base size and never
          re-measured. With Dynamic Type turned up the glyphs render larger than
          that box and get cut mid-letter — "Title" showed as "Titl", "Amount"
          as "Amour", on an iPhone 17 Pro at XXL. Spanning to the container's
          right edge gives the text room at any scale; numberOfLines keeps a
          long label on one line so it degrades to an ellipsis rather than
          wrapping over the field. */}
      <Animated.Text
        numberOfLines={1}
        style={[{ position: 'absolute', right: 0, zIndex: 1 }, labelStyle]}
        pointerEvents="none"
      >
        {label}
      </Animated.Text>
      <TextInput
        {...props}
        value={value}
        style={style}
        onFocus={(e) => {
          setIsFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setIsFocused(false);
          onBlur?.(e);
        }}
        mode="outlined"
        // Resting outline is a real accent tint, not a near-black hairline —
        // a field you must tap should look tappable and on-brand.
        outlineColor={`${theme.colors.primary}${isDark ? '85' : '70'}`}
        activeOutlineColor={theme.colors.primary}
        outlineStyle={{ borderWidth: 1.5, borderRadius: 12 }}
        theme={{ colors: { background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.6)' } }}
        textColor={theme.colors.onSurface}
        keyboardAppearance={isDark ? 'dark' : 'light'}
      />
    </View>
  );
};
