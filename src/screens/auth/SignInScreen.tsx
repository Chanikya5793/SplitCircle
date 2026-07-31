import { GlassCard } from '@/components/ui';
import { AppTextInput } from '@/components/ui/AppTextInput';
import { LiquidBackground } from '@/components/LiquidBackground';
import { MugguMark } from '@/components/brand';
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

interface SignInScreenProps {
  onSwitchToRegister?: () => void;
  onForgotPassword?: () => void;
  onLinkDevice?: () => void;
}

export const SignInScreen = ({ onSwitchToRegister, onForgotPassword, onLinkDevice }: SignInScreenProps) => {
  const { signInWithEmail, signInWithGoogle, signInWithApple, authBusy } = useAuth();
  const { theme, isDark } = useTheme();
  const { isOnline } = useOfflineSync();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<RNTextInput>(null);

  useEffect(() => {
    if (Platform.OS === 'ios') void AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  const canSubmit =
    Boolean(email && password) && isOnline && !loading && !googleLoading && !appleLoading && !authBusy;

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
            <View style={styles.brandMark}>
              <MugguMark
                size={68}
                variant={isDark ? 'reversed' : 'primary'}
                accessibilityLabel={`${APP_NAME} logo`}
              />
            </View>
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
              disabled={!isOnline || loading || googleLoading || appleLoading || authBusy}
              icon="google"
            >
              Continue with Google
            </Button>
            {Platform.OS === 'ios' && appleAvailable && (
              <View
                pointerEvents={!isOnline || loading || googleLoading || appleLoading || authBusy ? 'none' : 'auto'}
                style={[styles.field, styles.appleButtonWrap, { opacity: appleLoading ? 0.6 : 1 }]}
              >
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
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
            <View style={styles.links}>
              <Button compact onPress={onForgotPassword}>
                Forgot password?
              </Button>
              <Button compact onPress={onSwitchToRegister}>
                Create account
              </Button>
            </View>
            <Button compact onPress={onLinkDevice} icon="qrcode-scan">
              Have a code? Link this device
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
  brandMark: {
    alignItems: 'center',
    marginBottom: 2,
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
  appleButtonWrap: {
    height: 44,
  },
  appleButton: {
    height: 44,
  },
  links: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
