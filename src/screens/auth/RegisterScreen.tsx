import { FloatingLabelInput } from '@/components/FloatingLabelInput';
import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { Button, Text } from 'react-native-paper';

interface RegisterScreenProps {
  onSwitchToSignIn?: () => void;
}

export const RegisterScreen = ({ onSwitchToSignIn }: RegisterScreenProps) => {
  const { registerWithEmail } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegister = async () => {
    setLoading(true);
    try {
      await registerWithEmail(displayName.trim(), email.trim(), password);
    } catch (error: any) {
      Alert.alert('Registration Failed', error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <LiquidBackground>
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <GlassView style={styles.card}>
          <Text variant="headlineMedium" style={styles.title}>
            Create SplitCircle account
          </Text>
          <FloatingLabelInput 
            label="Name" 
            value={displayName} 
            onChangeText={setDisplayName} 
            style={styles.field}
          />
          <FloatingLabelInput
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            style={styles.field}
          />
          <FloatingLabelInput 
            label="Password" 
            value={password} 
            onChangeText={setPassword} 
            secureTextEntry 
            style={styles.field}
          />
          <Button
            mode="contained"
            onPress={handleRegister}
            loading={loading}
            disabled={!displayName || !email || !password}
          >
            Create account
          </Button>
          <Button compact onPress={onSwitchToSignIn} style={styles.link}>
            Already joined? Sign in
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
  title: {
    textAlign: 'center',
    marginBottom: 12,
  },
  field: {
    marginBottom: 8,
  },
  link: {
    marginTop: 8,
  },
});
