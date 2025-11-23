import { colors } from '@/constants';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleProp, View, ViewStyle } from 'react-native';
import { TextInput } from 'react-native-paper';

interface FloatingLabelInputProps extends React.ComponentProps<typeof TextInput> {
  label: string;
  containerStyle?: StyleProp<ViewStyle>;
}

export const FloatingLabelInput = ({ label, value, style, containerStyle, onFocus, onBlur, ...props }: FloatingLabelInputProps) => {
  const [isFocused, setIsFocused] = useState(false);
  const animatedValue = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(animatedValue, {
      toValue: (isFocused || value) ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [isFocused, value]);

  const labelStyle = {
    position: 'absolute' as const,
    left: animatedValue.interpolate({
      inputRange: [0, 1],
      outputRange: [18, 15], // [Start X, End X] - Adjust horizontal position
    }),
    top: animatedValue.interpolate({
      inputRange: [0, 1],
      outputRange: [36, 3], // [Start Y, End Y] - Adjust vertical position
    }),
    fontSize: animatedValue.interpolate({
      inputRange: [0, 1],
      outputRange: [19, 14], // [Start Size, End Size] - Adjust font size
    }),
    color: animatedValue.interpolate({
      inputRange: [0, 1],
      outputRange: [colors.muted, '#555'],
    }),
    zIndex: 1,
  };

  return (
    <View style={[{ 
      marginBottom: 0, // Spacing between this field and the next element
      paddingTop: 18   // Space reserved for the floating label at the top
    }, containerStyle]}>
      <Animated.Text style={labelStyle} pointerEvents="none">
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
        outlineColor="rgba(0,0,0,0.1)"
        theme={{ colors: { background: 'rgba(255,255,255,0.5)' } }}
      />
    </View>
  );
};
