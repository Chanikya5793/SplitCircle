// Themed text input: Paper's outlined TextInput driven by tokens, with an
// inline error line. Replaces FloatingLabelInput (which reimplemented Paper's
// own floating label with hardcoded rgba surfaces and font-size magic numbers
// that broke under OS accessibility scaling).
//
// Background MUST be near-opaque, not a light glassTint wash: Paper's
// outlined-mode floating label has no real notch cut into the border stroke —
// it fakes one by painting a small rect matching this exact backgroundColor
// on top of the border where the label sits (react-native-paper's
// LabelBackground). A translucent fill lets the active (2px, brighter) border
// bleed through that rect, so the focused label reads as sliced-through
// instead of floating cleanly above the box. `glassFallback` — the same token
// GlassCard uses for its own "blur can't render here" Android path — is
// exactly this app's answer to "translucent doesn't work here, but stay in
// the glass family": tinted like glass, opaque enough for the mask trick.

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
  const { theme } = useTheme();

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
            backgroundColor: theme.colors.glassFallback,
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
