// New-device side of pairing (doc 31 §3.4). Lives in the AUTH stack — a
// brand-new companion device isn't signed in yet, redeeming a code IS how it
// signs in (via the custom token pairing.ts mints). Once redeemPairingCode
// succeeds, AuthContext's onAuthStateChanged listener flips `user` truthy and
// AppNavigator swaps to the App stack; the actual "waiting for the main
// device to confirm" UI then takes over via PendingPairingGate (mounted at
// the App.tsx root, not here) since this screen unmounts at that point.
//
// No existing camera-preview pattern exists anywhere in this codebase
// (expo-camera is only ever used for permission checks elsewhere) — this is
// the first live CameraView usage, built from Expo's own barcode-scanning
// API rather than an in-repo example.

import { GlassCard } from '@/components/ui';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useTheme } from '@/context/ThemeContext';
import { redeemPairingCode } from '@/services/pairingService';
import { errorHaptic, successHaptic } from '@/utils/haptics';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Text, TextInput } from 'react-native-paper';

interface ScanPairingCodeScreenProps {
  onBack?: () => void;
}

const PAIRING_ERROR_MESSAGES: Record<string, string> = {
  'not-found': 'That code was not found. Double-check and try again.',
  'failed-precondition': 'This code has already been used.',
  'deadline-exceeded': 'This code has expired. Ask your other device for a new one.',
  'resource-exhausted': "You've reached the maximum number of linked devices.",
};

const errorMessage = (error: unknown): string => {
  const code = (error as { code?: string } | null)?.code;
  if (code) {
    const key = code.split('/').pop() ?? code;
    if (PAIRING_ERROR_MESSAGES[key]) return PAIRING_ERROR_MESSAGES[key];
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Could not link this device. Please try again.';
};

export const ScanPairingCodeScreen = ({ onBack }: ScanPairingCodeScreenProps) => {
  const { theme } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<'scan' | 'manual'>('scan');
  const [manualCode, setManualCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [scannedOnce, setScannedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitCode = async (code: string) => {
    if (redeeming) return;
    setRedeeming(true);
    setError(null);
    try {
      await redeemPairingCode(code);
      successHaptic();
      // No explicit navigation needed — signInWithCustomToken flips `user`
      // truthy, AppNavigator swaps stacks on its own.
    } catch (err) {
      errorHaptic();
      setError(errorMessage(err));
      setScannedOnce(false);
      setRedeeming(false);
    }
  };

  const handleScan = (result: BarcodeScanningResult) => {
    if (scannedOnce || redeeming) return;
    setScannedOnce(true);
    void submitCode(result.data);
  };

  return (
    <LiquidBackground>
      <View style={styles.container}>
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
            Link this device
          </Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
            On your other device, go to Settings → Linked Devices → Link a device to get a code.
          </Text>

          {mode === 'scan' ? (
            <View style={styles.cameraWrap}>
              {!permission ? (
                <ActivityIndicator size="large" color={theme.colors.primary} />
              ) : !permission.granted ? (
                <View style={styles.permissionPrompt}>
                  <Text style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                    Camera access is needed to scan the code.
                  </Text>
                  <Button mode="contained" onPress={() => void requestPermission()}>
                    Allow camera
                  </Button>
                </View>
              ) : (
                <CameraView
                  style={styles.camera}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={handleScan}
                />
              )}
              {redeeming ? (
                <View style={[styles.cameraOverlay, { backgroundColor: theme.colors.appBackground + 'CC' }]}>
                  <ActivityIndicator size="large" color={theme.colors.primary} />
                </View>
              ) : null}
            </View>
          ) : (
            <TextInput
              mode="outlined"
              label="8-character code"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={8}
              value={manualCode}
              onChangeText={(next) => setManualCode(next.toUpperCase())}
              style={styles.manualInput}
            />
          )}

          {error ? (
            <Text variant="bodyMedium" style={{ color: theme.colors.danger, textAlign: 'center' }}>
              {error}
            </Text>
          ) : null}

          {mode === 'manual' ? (
            <Button
              mode="contained"
              loading={redeeming}
              disabled={manualCode.trim().length !== 8}
              onPress={() => void submitCode(manualCode)}
            >
              Link device
            </Button>
          ) : null}

          <Button
            compact
            onPress={() => {
              setMode(mode === 'scan' ? 'manual' : 'scan');
              setError(null);
            }}
          >
            {mode === 'scan' ? 'Enter code manually instead' : 'Scan a QR code instead'}
          </Button>
          <Button compact onPress={onBack}>
            Back to sign in
          </Button>
        </GlassCard>
      </View>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    borderRadius: 20,
  },
  cardContent: {
    padding: 24,
    gap: 14,
    alignItems: 'center',
  },
  title: {
    fontWeight: '700',
  },
  cameraWrap: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 16,
    overflow: 'hidden',
  },
  camera: {
    flex: 1,
  },
  cameraOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permissionPrompt: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  manualInput: {
    width: '100%',
  },
});

export default ScanPairingCodeScreen;
