// Blocks the app behind a full-screen "waiting for confirmation" panel while
// THIS device's own pairing is pending_confirmation — doc 31 §3.4 point 6,
// closing the "paired but blind" gap the adversarial critique found (a newly
// redeemed companion receiving pushes/fan-out before it's actually trusted,
// with no UI explaining why nothing is decryptable/visible yet). Mirrors
// AppLockGate's mounting pattern (App.tsx, absolute sibling of AppNavigator).

import { GlassCard } from '@/components/ui';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import {
  getCurrentDeviceId,
  revokeDevice,
  subscribeToOwnPairedDevice,
  type PairedDevice,
} from '@/services/pairingService';
import { errorHaptic } from '@/utils/haptics';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-paper';

export const PendingPairingGate = () => {
  const { user, signOutUser } = useAuth();
  const { theme } = useTheme();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [ownRecord, setOwnRecord] = useState<PairedDevice | null | undefined>(undefined);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getCurrentDeviceId().then((id) => {
      if (!cancelled) setDeviceId(id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user || !deviceId) {
      setOwnRecord(undefined);
      return;
    }

    return subscribeToOwnPairedDevice(user.userId, deviceId, (device) => {
      setOwnRecord(device);
    });
  }, [user, deviceId]);

  const isPending = ownRecord?.pairingStatus === 'pending_confirmation';
  // A record that existed and is now GONE means denied/revoked — sign out.
  // `ownRecord === null` alone is NOT sufficient evidence of that: on a fresh
  // sign-in the pairedDevices row doesn't exist yet (it's created
  // asynchronously by syncNotificationDeviceRecord), so the subscription's
  // first emission is legitimately null and treating it as a denial signed
  // brand-new devices straight back out. Only a null that FOLLOWS a record we
  // actually saw is a revocation.
  const [everSawRecord, setEverSawRecord] = useState(false);
  useEffect(() => {
    if (ownRecord) setEverSawRecord(true);
  }, [ownRecord]);
  const wasDeniedOrRevoked = ownRecord === null && deviceId !== null && everSawRecord;

  useEffect(() => {
    if (!wasDeniedOrRevoked || signingOut) return;
    setSigningOut(true);
    errorHaptic();
    void signOutUser().finally(() => setSigningOut(false));
  }, [wasDeniedOrRevoked, signingOut]);

  if (!isPending) {
    return null;
  }

  const expiresAt = ownRecord?.confirmationExpiresAt ?? null;
  const expired = typeof expiresAt === 'number' && Date.now() > expiresAt;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="auto">
      <LiquidBackground>
        <View style={styles.center}>
          <GlassCard style={styles.card} contentStyle={styles.cardContent}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
              {expired ? 'Confirmation expired' : 'Waiting for confirmation'}
            </Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
              {expired
                ? "This device's pairing request wasn't confirmed in time. Try linking this device again."
                : ownRecord?.confirmationCode
                  ? "Open SplitCircle on your other device to confirm this one. Make sure the code below matches what's shown there."
                  // Self-registered device (signed in directly rather than
                  // through the pairing flow): there is no shared pairing
                  // session, so there is no code to match — approval is an
                  // explicit decision in Settings on a device you already use.
                  : 'Approve this device from Settings → Linked devices on a device you already use.'}
            </Text>
            {!expired && ownRecord?.confirmationCode ? (
              <Text variant="displaySmall" style={[styles.code, { color: theme.colors.primary }]}>
                {ownRecord.confirmationCode}
              </Text>
            ) : null}
            <Button
              mode="text"
              loading={signingOut}
              onPress={() => {
                if (deviceId) void revokeDevice(deviceId).catch(() => {});
                setSigningOut(true);
                void signOutUser().finally(() => setSigningOut(false));
              }}
            >
              Cancel
            </Button>
          </GlassCard>
        </View>
      </LiquidBackground>
    </View>
  );
};

const styles = StyleSheet.create({
  center: {
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
    textAlign: 'center',
  },
  code: {
    fontWeight: '800',
    letterSpacing: 4,
  },
});
