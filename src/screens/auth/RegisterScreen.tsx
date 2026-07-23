import { GlassCard } from '@/components/ui';
import { AppTextInput } from '@/components/ui/AppTextInput';
import { LiquidBackground } from '@/components/LiquidBackground';
import { APP_NAME } from '@/constants/appInfo';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import { friendlyAuthError } from '@/utils/authErrors';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput as RNTextInput,
  View,
} from 'react-native';
import { Button, Text, TextInput } from 'react-native-paper';

interface RegisterScreenProps {
  onSwitchToSignIn?: () => void;
}

export const RegisterScreen = ({ onSwitchToSignIn }: RegisterScreenProps) => {
  const { registerWithEmail, signInWithGoogle, signInWithApple, authBusy } = useAuth();
  const { theme, isDark } = useTheme();
  const { isOnline } = useOfflineSync();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailRef = useRef<RNTextInput>(null);
  const passwordRef = useRef<RNTextInput>(null);

  useEffect(() => {
    if (Platform.OS === 'ios') void AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  const canSubmit =
    Boolean(displayName && email && password) &&
    isOnline &&
    !loading &&
    !googleLoading &&
    !appleLoading &&
    !authBusy;

  const clearError = () => {
    if (error) setError(null);
  };

  const handleRegister = async () => {
    if (!canSubmit) return;
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await registerWithEmail(displayName.trim(), email.trim(), password);
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
      setError(friendlyAuthError(err, 'google'));
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleApple = async () => {
    // Synchronous reentrancy guard: the button's own pointerEvents disable
    // needs a state update + re-render + native bridge round trip to take
    // effect, which a fast double-tap can beat — this check is immediate.
    if (appleLoading) return;
    setError(null);
    setAppleLoading(true);
    try {
      await signInWithApple();
    } catch (err) {
      setError(friendlyAuthError(err, 'apple'));
    } finally {
      setAppleLoading(false);
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
              Create your {APP_NAME} account
            </Text>
            <AppTextInput
              label="Name"
              value={displayName}
              onChangeText={(next) => {
                setDisplayName(next);
                clearError();
              }}
              autoComplete="name"
              textContentType="name"
              returnKeyType="next"
              onSubmitEditing={() => emailRef.current?.focus()}
              containerStyle={styles.field}
            />
            <AppTextInput
              ref={emailRef}
              label="Email"
              value={email}
              onChangeText={(next) => {
                setEmail(next);
                clearError();
              }}
              keyboardType="email-address"
              autoCapitalize="none"
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
                clearError();
              }}
              secureTextEntry={!showPassword}
              autoComplete="new-password"
              textContentType="newPassword"
              returnKeyType="go"
              onSubmitEditing={handleRegister}
              right={
                <TextInput.Icon
                  icon={showPassword ? 'eye-off' : 'eye'}
                  onPress={() => setShowPassword((prev) => !prev)}
                  forceTextInputFocus={false}
                />
              }
              containerStyle={styles.field}
            />
            <Text style={{ color: theme.colors.muted, fontSize: 13 }}>
              At least 6 characters.
            </Text>
            {error ? (
              <Text style={{ color: theme.colors.danger, textAlign: 'center' }}>{error}</Text>
            ) : null}
            {!isOnline ? (
              <Text style={{ color: theme.colors.muted, textAlign: 'center' }}>
                You're offline — creating an account needs an internet connection.
              </Text>
            ) : null}
            <Button
              mode="contained"
              onPress={handleRegister}
              loading={loading}
              disabled={!canSubmit}
            >
              Create account
            </Button>
            <Button
              mode="outlined"
              onPress={handleGoogle}
              loading={googleLoading}
              disabled={!isOnline || loading || googleLoading || appleLoading || authBusy}
              icon="google"
            >
              Continue with Google
            </Button>
            {Platform.OS === 'ios' && appleAvailable && (
              <View
                pointerEvents={!isOnline || loading || googleLoading || appleLoading || authBusy ? 'none' : 'auto'}
                style={[styles.appleButtonWrap, { opacity: appleLoading ? 0.6 : 1 }]}
              >
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP}
                  buttonStyle={
                    isDark
                      ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE_OUTLINE
                      : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                  }
                  cornerRadius={8}
                  style={styles.appleButton}
                  onPress={handleApple}
                />
              </View>
            )}
            <Button compact onPress={onSwitchToSignIn} style={styles.link}>
              Already joined? Sign in
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
  appleButtonWrap: {
    height: 44,
    marginTop: 8,
  },
  appleButton: {
    height: 44,
  },
  link: {
    marginTop: 8,
  },
});
