import { FloatingLabelInput } from '@/components/FloatingLabelInput';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { colors } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { Button, Text } from 'react-native-paper';

interface ForgotPasswordScreenProps {
  onBack?: () => void;
}

export const ForgotPasswordScreen = ({ onBack }: ForgotPasswordScreenProps) => {
  const { sendResetLink } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    await sendResetLink(email.trim());
    setSent(true);
  };

  return (
    <LiquidBackground>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <GlassView style={styles.card}>
          <Text variant="headlineMedium">Reset password</Text>
          <FloatingLabelInput
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            style={styles.field}
          />
          <Button mode="contained" onPress={handleSend} disabled={!email}>
            Send reset link
          </Button>
          {sent && <Text style={styles.success}>Check your inbox for instructions.</Text>}
          <Button compact onPress={onBack}>
            Back to sign in
          </Button>
        </GlassView>
      </KeyboardAvoidingView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    borderRadius: 20,
    padding: 24,
    gap: 12,
  },
  field: {
    marginBottom: 8,
  },
  success: {
    color: colors.success,
    marginTop: 8,
  },
});
