import { GlassCard } from '@/components/ui';
import { AppTextInput } from '@/components/ui/AppTextInput';
import { LiquidBackground } from '@/components/LiquidBackground';
import { APP_NAME } from '@/constants/appInfo';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import { friendlyAuthError } from '@/utils/authErrors';
import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput as RNTextInput,
  View,
} from 'react-native';
import { Button, Text, TextInput } from 'react-native-paper';

interface SignInScreenProps {
  onSwitchToRegister?: () => void;
  onForgotPassword?: () => void;
}

export const SignInScreen = ({ onSwitchToRegister, onForgotPassword }: SignInScreenProps) => {
  const { signInWithEmail, signInWithGoogle } = useAuth();
  const { theme } = useTheme();
  const { isOnline } = useOfflineSync();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<RNTextInput>(null);

  const canSubmit = Boolean(email && password) && isOnline && !loading && !googleLoading;

  const handleSignIn = async () => {
    if (!canSubmit) return;
    setError(null);
    setLoading(true);
    try {
      await signInWithEmail(email.trim(), password);
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setError(null);
    setGoogleLoading(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setGoogleLoading(false);
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
              Welcome back
            </Text>
            <Text style={[styles.subtitle, { color: theme.colors.muted }]}>
              Sign in to {APP_NAME}
            </Text>
            <AppTextInput
              label="Email"
              value={email}
              onChangeText={(next) => {
                setEmail(next);
                if (error) setError(null);
              }}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              textContentType="username"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              containerStyle={styles.field}
            />
            <AppTextInput
              ref={passwordRef}
              label="Password"
              value={password}
              onChangeText={(next) => {
                setPassword(next);
                if (error) setError(null);
              }}
              secureTextEntry={!showPassword}
              autoComplete="current-password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={handleSignIn}
              right={
                <TextInput.Icon
                  icon={showPassword ? 'eye-off' : 'eye'}
                  onPress={() => setShowPassword((prev) => !prev)}
                  forceTextInputFocus={false}
                />
              }
              containerStyle={styles.field}
            />
            {error ? (
              <Text style={{ color: theme.colors.danger, textAlign: 'center' }}>{error}</Text>
            ) : null}
            {!isOnline ? (
              <Text style={{ color: theme.colors.muted, textAlign: 'center' }}>
                You're offline — signing in needs an internet connection.
              </Text>
            ) : null}
            <Button
              mode="contained"
              onPress={handleSignIn}
              loading={loading}
              disabled={!canSubmit}
            >
              Sign in
            </Button>
            <Button
              mode="outlined"
              style={styles.field}
              onPress={handleGoogle}
              loading={googleLoading}
              disabled={!isOnline || loading || googleLoading}
              icon="google"
            >
              Continue with Google
            </Button>
            <View style={styles.links}>
              <Button compact onPress={onForgotPassword}>
                Forgot password?
              </Button>
              <Button compact onPress={onSwitchToRegister}>
                Create account
              </Button>
            </View>
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
  },
  subtitle: {
    textAlign: 'center',
    marginBottom: 12,
  },
  field: {
    marginBottom: 8,
  },
  links: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
