// Linked Devices settings screen (doc 31 §3.4) — lists pairedDevices, lets
// the user link a new one (main device only) or remove an existing one.
// A companion device can remove itself; only the main device can remove a
// DIFFERENT device (enforced server-side in pairing.ts's revokeDevice).

import { GlassCard } from '@/components/ui';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import { ROUTES } from '@/constants/routes';
import { SCREEN_TITLES } from '@/navigation/screenTitles';
import {
  getCurrentDeviceId,
  revokeDevice,
  subscribeToPairedDevices,
  type PairedDevice,
} from '@/services/pairingService';
import { appAlert } from '@/utils/appAlert';
import { errorHaptic, lightHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Divider, List, Text } from 'react-native-paper';

const MAX_DEVICES = 4; // doc 31 decision #21

export const LinkedDevicesScreen = () => {
  const navigation = useNavigation();
  const { user } = useAuth();
  const { theme } = useTheme();
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [ownDeviceId, setOwnDeviceId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    void getCurrentDeviceId().then(setOwnDeviceId);
  }, []);

  useEffect(() => {
    if (!user) return;
    return subscribeToPairedDevices(user.userId, setDevices, () => setDevices([]));
  }, [user]);

  const confirmedCount = (devices ?? []).filter((d) => d.pairingStatus === 'confirmed').length;
  const ownDevice = devices?.find((d) => d.deviceId === ownDeviceId);
  const isMainDevice = ownDevice?.isMainDevice === true;

  const handleRemove = (device: PairedDevice) => {
    const isSelf = device.deviceId === ownDeviceId;
    appAlert(
      isSelf ? 'Sign out this device?' : `Remove ${device.deviceName ?? 'this device'}?`,
      isSelf
        ? 'This device will be signed out and unlinked from your account.'
        : 'This device will lose access to your account immediately. Its chat history stays on that device but stops syncing.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: isSelf ? 'Sign out' : 'Remove',
          style: 'destructive',
          onPress: async () => {
            setRemovingId(device.deviceId);
            try {
              await revokeDevice(device.deviceId);
              lightHaptic();
            } catch (error) {
              errorHaptic();
              appAlert('Could not remove device', 'Please try again.');
            } finally {
              setRemovingId(null);
            }
          },
        },
      ],
    );
  };

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          {devices === null ? (
            <ActivityIndicator size="large" color={theme.colors.primary} style={styles.loading} />
          ) : (
            <>
              {devices.map((device, index) => (
                <View key={device.deviceId}>
                  <List.Item
                    title={device.deviceName ?? (device.isMainDevice ? 'This device' : 'Unnamed device')}
                    description={[
                      device.modelName,
                      device.isMainDevice ? 'Main device' : device.pairingStatus === 'pending_confirmation' ? 'Awaiting confirmation' : 'Companion',
                      device.deviceId === ownDeviceId ? '(this device)' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    left={() => (
                      <List.Icon icon={device.isMainDevice ? 'cellphone' : 'tablet-cellphone'} color={theme.colors.primary} />
                    )}
                    right={() =>
                      removingId === device.deviceId ? (
                        <ActivityIndicator size="small" color={theme.colors.primary} />
                      ) : (
                        <Button compact textColor={theme.colors.danger} onPress={() => handleRemove(device)}>
                          {device.deviceId === ownDeviceId ? 'Sign out' : 'Remove'}
                        </Button>
                      )
                    }
                  />
                  {index < devices.length - 1 ? <Divider /> : null}
                </View>
              ))}

              {devices.length === 0 ? (
                <Text style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', padding: 16 }}>
                  No devices found.
                </Text>
              ) : null}

              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', marginTop: 8 }}>
                {confirmedCount}/{MAX_DEVICES} devices linked
              </Text>

              {isMainDevice ? (
                <Button
                  mode="contained"
                  icon="qrcode-scan"
                  disabled={confirmedCount >= MAX_DEVICES}
                  onPress={() => {
                    lightHaptic();
                    (navigation as any).navigate(ROUTES.APP.LINK_DEVICE, {
                      backTitle: SCREEN_TITLES.linkedDevices,
                    });
                  }}
                  style={styles.linkButton}
                >
                  Link a device
                </Button>
              ) : (
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                  Only your main device can link new devices.
                </Text>
              )}
            </>
          )}
        </GlassCard>
      </ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    padding: 24,
  },
  card: {
    borderRadius: 20,
  },
  cardContent: {
    padding: 8,
    gap: 4,
  },
  loading: {
    padding: 32,
  },
  linkButton: {
    marginHorizontal: 16,
    marginVertical: 12,
  },
});

export default LinkedDevicesScreen;
