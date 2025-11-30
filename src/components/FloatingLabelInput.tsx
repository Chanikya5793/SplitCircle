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
      <Animated.Text style={[{ position: 'absolute', zIndex: 1 }, labelStyle]} pointerEvents="none">
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
        outlineColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)'}
        theme={{ colors: { background: isDark ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.5)' } }}
        textColor={theme.colors.onSurface}
      />
    </View>
  );
};
