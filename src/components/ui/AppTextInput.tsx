// Themed text input: Paper's outlined TextInput driven by tokens, with an
// inline error line. Replaces FloatingLabelInput (which reimplemented Paper's
// own floating label with hardcoded rgba surfaces and font-size magic numbers
// that broke under OS accessibility scaling).

import { useTheme } from '@/context/ThemeContext';
import React, { type Ref } from 'react';
import {
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
  type TextInput as RNTextInput,
} from 'react-native';
import { HelperText, TextInput, type TextInputProps } from 'react-native-paper';

export interface AppTextInputProps extends Omit<TextInputProps, 'mode' | 'theme'> {
  /** Inline validation message; renders red HelperText and error outline. */
  errorText?: string;
  containerStyle?: StyleProp<ViewStyle>;
  /** Forwarded to the underlying native input (focus chaining). */
  ref?: Ref<RNTextInput>;
}

export const AppTextInput = ({ errorText, containerStyle, style, ref, ...rest }: AppTextInputProps) => {
  const { theme, isDark } = useTheme();

  return (
    <View style={containerStyle}>
      <TextInput
        ref={ref as never}
        mode="outlined"
        error={Boolean(errorText)}
        outlineColor={theme.colors.glassBorder}
        activeOutlineColor={theme.colors.primary}
        outlineStyle={{ borderRadius: theme.radius.sm }}
        style={[
          styles.input,
          {
            backgroundColor: isDark ? 'rgba(0, 0, 0, 0.2)' : 'rgba(255, 255, 255, 0.5)',
          },
          style,
        ]}
        {...rest}
      />
      {errorText ? (
        <HelperText type="error" visible padding="none">
          {errorText}
        </HelperText>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  input: {
    fontSize: 16,
  },
});
