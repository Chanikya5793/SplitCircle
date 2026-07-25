// Main device side of pairing (doc 31 §3.4). Biometric-gated code generation
// (requestPairingCode already does the Face ID/Touch ID prompt before
// returning a code — see pairingService.ts), QR + manual-code display, and
// the mandatory confirmation step once a companion redeems it.

import { GlassCard } from '@/components/ui';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import {
  confirmPairing,
  getCurrentDeviceId,
  requestPairingCode,
  subscribeToPairedDevices,
  type PairedDevice,
} from '@/services/pairingService';
import { errorHaptic, successHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-paper';
import QRCode from 'react-native-qrcode-svg';

type ScreenState =
  | { kind: 'requesting' }
  | { kind: 'denied_biometric' }
  | { kind: 'ready'; code: string; expiresAt: number }
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Something went wrong. Please try again.';
};

export const LinkDeviceScreen = () => {
  const navigation = useNavigation();
  const { user } = useAuth();
  const { theme } = useTheme();
  const [state, setState] = useState<ScreenState>({ kind: 'requesting' });
  const [ownDeviceId, setOwnDeviceId] = useState<string | null>(null);
  const [pendingDevices, setPendingDevices] = useState<PairedDevice[]>([]);
  const [resolvingDeviceId, setResolvingDeviceId] = useState<string | null>(null);

  useEffect(() => {
    void getCurrentDeviceId().then(setOwnDeviceId);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await requestPairingCode();
        if (cancelled) return;
        if (!result) {
          setState({ kind: 'denied_biometric' });
          return;
        }
        setState({ kind: 'ready', code: result.code, expiresAt: result.expiresAt });
      } catch (error) {
        if (!cancelled) setState({ kind: 'error', message: errorMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    const timer = setTimeout(() => {
      setState((current) => (current.kind === 'ready' ? { kind: 'expired' } : current));
    }, Math.max(0, state.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    if (!user) return;
    return subscribeToPairedDevices(user.userId, (devices) => {
      setPendingDevices(devices.filter((d) => d.pairingStatus === 'pending_confirmation' && !d.isMainDevice));
    });
  }, [user]);

  const handleConfirm = async (deviceId: string, confirm: boolean) => {
    setResolvingDeviceId(deviceId);
    try {
      await confirmPairing(deviceId, confirm);
      confirm ? successHaptic() : errorHaptic();
    } catch (error) {
      errorHaptic();
    } finally {
      setResolvingDeviceId(null);
    }
  };

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
            Link a device
          </Text>

          {state.kind === 'requesting' ? (
            <View style={styles.centerBlock}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
            </View>
          ) : null}

          {state.kind === 'denied_biometric' ? (
            <>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                Face ID / Touch ID confirmation is required to link a new device.
              </Text>
              <Button mode="contained" onPress={() => navigation.goBack()}>
                Close
              </Button>
            </>
          ) : null}

          {state.kind === 'error' ? (
            <>
              <Text variant="bodyMedium" style={{ color: theme.colors.danger, textAlign: 'center' }}>
                {state.message}
              </Text>
              <Button mode="contained" onPress={() => navigation.goBack()}>
                Close
              </Button>
            </>
          ) : null}

          {state.kind === 'expired' ? (
            <>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                This code expired. Go back and try again.
              </Text>
              <Button mode="contained" onPress={() => navigation.goBack()}>
                Close
              </Button>
            </>
          ) : null}

          {state.kind === 'ready' ? (
            <>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                On your other device, open SplitCircle and scan this code — or enter it manually.
              </Text>
              <View style={styles.qrWrap}>
                <QRCode value={state.code} size={220} />
              </View>
              <Text variant="displaySmall" style={[styles.manualCode, { color: theme.colors.primary }]}>
                {state.code}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                Expires in a few minutes.
              </Text>
            </>
          ) : null}

          {pendingDevices
            .filter((device) => device.deviceId !== ownDeviceId)
            .map((device) => (
              <View key={device.deviceId} style={[styles.confirmRow, { borderColor: theme.colors.outline }]}>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                  {device.deviceName ?? 'A device'} wants to link
                </Text>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  {device.modelName ?? device.platform}
                </Text>
                {device.confirmationCode ? (
                  <Text variant="displaySmall" style={[styles.manualCode, { color: theme.colors.primary }]}>
                    {device.confirmationCode}
                  </Text>
                ) : null}
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                  Only confirm if this code matches what's shown on that device.
                </Text>
                <View style={styles.confirmActions}>
                  <Button
                    mode="outlined"
                    loading={resolvingDeviceId === device.deviceId}
                    onPress={() => handleConfirm(device.deviceId, false)}
                  >
                    Deny
                  </Button>
                  <Button
                    mode="contained"
                    loading={resolvingDeviceId === device.deviceId}
                    onPress={() => handleConfirm(device.deviceId, true)}
                  >
                    Confirm
                  </Button>
                </View>
              </View>
            ))}
        </GlassCard>
      </ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
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
    gap: 16,
    alignItems: 'center',
  },
  title: {
    fontWeight: '700',
  },
  centerBlock: {
    paddingVertical: 32,
  },
  qrWrap: {
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
  },
  manualCode: {
    fontWeight: '800',
    letterSpacing: 4,
  },
  confirmRow: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 8,
    alignItems: 'center',
  },
  confirmActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
});

export default LinkDeviceScreen;
