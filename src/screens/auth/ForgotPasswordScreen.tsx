import { GlassCard } from '@/components/ui';
import { AppTextInput } from '@/components/ui/AppTextInput';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import { friendlyAuthError } from '@/utils/authErrors';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { Button, Text } from 'react-native-paper';

interface ForgotPasswordScreenProps {
  onBack?: () => void;
}

export const ForgotPasswordScreen = ({ onBack }: ForgotPasswordScreenProps) => {
  const { sendResetLink } = useAuth();
  const { theme } = useTheme();
  const { isOnline } = useOfflineSync();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSend = async () => {
    setError(null);
    setLoading(true);
    try {
      await sendResetLink(email.trim());
      setSent(true);
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <LiquidBackground>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            <Text variant="headlineMedium" style={styles.title}>
              Reset password
            </Text>
            <AppTextInput
              label="Email"
              value={email}
              onChangeText={(next) => {
                setEmail(next);
                // A new address invalidates the previous confirmation.
                if (sent) setSent(false);
                if (error) setError(null);
              }}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              textContentType="username"
              returnKeyType="go"
              onSubmitEditing={handleSend}
              containerStyle={styles.field}
            />
            {error ? (
              <Text style={{ color: theme.colors.danger, textAlign: 'center' }}>{error}</Text>
            ) : null}
            {!isOnline ? (
              <Text style={{ color: theme.colors.muted, textAlign: 'center' }}>
                You're offline — sending a reset link needs an internet connection.
              </Text>
            ) : null}
            <Button
              mode="contained"
              onPress={handleSend}
              loading={loading}
              disabled={!email || loading || !isOnline}
            >
              Send reset link
            </Button>
            {sent ? (
              <Text style={[styles.success, { color: theme.colors.success }]}>
                Check {email.trim()} for instructions.
              </Text>
            ) : null}
            <Button compact onPress={onBack}>
              Back to sign in
            </Button>
          </GlassCard>
        </ScrollView>
      </KeyboardAvoidingView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    borderRadius: 20,
  },
  cardContent: {
    padding: 24,
    gap: 12,
  },
  title: {
    textAlign: 'center',
    marginBottom: 12,
  },
  field: {
    marginBottom: 8,
  },
  success: {
    marginTop: 8,
    textAlign: 'center',
  },
});
