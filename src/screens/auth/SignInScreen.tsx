import { colors } from '@/constants';
import { useAuth } from '@/context/AuthContext';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { Button, Text, TextInput } from 'react-native-paper';

interface SignInScreenProps {
  onSwitchToRegister?: () => void;
  onForgotPassword?: () => void;
}

export const SignInScreen = ({ onSwitchToRegister, onForgotPassword }: SignInScreenProps) => {
  const { signInWithEmail, signInWithGoogle } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    setLoading(true);
    try {
      await signInWithEmail(email.trim(), password);
    } catch (error: any) {
      Alert.alert('Sign In Failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.card}>
        <Text variant="headlineMedium" style={styles.title}>
          Welcome back
        </Text>
        <TextInput label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" style={styles.field} />
        <TextInput label="Password" value={password} onChangeText={setPassword} secureTextEntry style={styles.field} />
        <Button mode="contained" onPress={handleSignIn} loading={loading} disabled={!email || !password}>
          Sign in
        </Button>
        <Button mode="outlined" style={styles.field} onPress={signInWithGoogle} icon="google">
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
      </View>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: colors.background,
  },
  card: {
    borderRadius: 20,
    backgroundColor: colors.surface,
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
  links: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
