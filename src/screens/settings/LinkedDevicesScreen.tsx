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
  confirmPairing,
  getCurrentDeviceId,
  revokeDevice,
  subscribeToPairedDevices,
  type PairedDevice,
} from '@/services/pairingService';
import { resetEncryptionIdentity } from '@/services/signalCryptoService';
import { appAlert } from '@/utils/appAlert';
import { errorHaptic, lightHaptic } from '@/utils/haptics';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Button, Divider, List, Text } from 'react-native-paper';

const MAX_DEVICES = 4; // doc 31 decision #21

export const LinkedDevicesScreen = () => {
  const navigation = useNavigation();
  const { user } = useAuth();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [ownDeviceId, setOwnDeviceId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  /** Which action is in flight, so only that button shows a spinner. */
  const [pendingAction, setPendingAction] = useState<'approve' | 'remove' | null>(null);
  const [resetting, setResetting] = useState(false);

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

  // Approving a device grants it full access to the account's messages and
  // history, so it is deliberately a confirm-first destructive-weight action
  // naming the device — not a one-tap toggle.
  const handleApprove = (device: PairedDevice) => {
    appAlert(
      `Approve ${device.deviceName ?? 'this device'}?`,
      'This device signed in to your account and is waiting for approval. Only approve it if it is yours and you are expecting it — once approved it can read your messages and history.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve',
          onPress: async () => {
            setRemovingId(device.deviceId);
            setPendingAction('approve');
            try {
              // confirmPairing resolves the caller's own device id internally.
              await confirmPairing(device.deviceId, true);
              lightHaptic();
            } catch {
              errorHaptic();
              appAlert('Could not approve device', 'Please try again.');
            } finally {
              setRemovingId(null);
              setPendingAction(null);
            }
          },
        },
      ],
    );
  };

  /**
   * Last-resort repair when messages won't decrypt.
   *
   * Deliberately says what it CANNOT do. Messages already waiting for this
   * device were encrypted to the identity being discarded and will never open
   * — promising a clean fix and then leaving unreadable bubbles behind would
   * be worse than the bug.
   */
  const handleResetEncryption = () => {
    if (!user) return;
    appAlert(
      'Reset encryption on this device?',
      "Use this if messages won't decrypt. This device gets a fresh encryption identity and your other devices re-establish with it automatically.\n\nMessages already waiting for this device can't be recovered — they were encrypted to the old identity. New messages will work.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            setResetting(true);
            try {
              await resetEncryptionIdentity(user.userId);
              lightHaptic();
              appAlert(
                'Encryption reset',
                'Send a message from each device to finish re-establishing.',
              );
            } catch {
              errorHaptic();
              appAlert('Could not reset encryption', 'Please try again.');
            } finally {
              setResetting(false);
            }
          },
        },
      ],
    );
  };

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
            setPendingAction('remove');
            try {
              await revokeDevice(device.deviceId);
              lightHaptic();
            } catch (error) {
              errorHaptic();
              appAlert('Could not remove device', 'Please try again.');
            } finally {
              setRemovingId(null);
              setPendingAction(null);
            }
          },
        },
      ],
    );
  };

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={[styles.container, { paddingTop: headerHeight + 16, paddingBottom: insets.bottom + 32 }]} showsVerticalScrollIndicator={false}>
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
                    right={() => (
                        // Per-action loading, not one spinner for the whole
                        // row: replacing both buttons with a single indicator
                        // leaves the user unable to tell whether they approved
                        // or denied.
                        <View style={styles.rowActions}>
                          {/* A device that registered itself by signing in
                              directly (rather than through the QR flow) has no
                              pairing session and therefore no confirmation
                              code, so this is the ONLY place it can be
                              approved. Without it such a device would sit
                              blocked behind PendingPairingGate forever. Never
                              offered for our own device: self-approval would
                              defeat the entire gate. */}
                          {device.pairingStatus === 'pending_confirmation' &&
                          device.deviceId !== ownDeviceId ? (
                            <Button
                              compact
                              loading={removingId === device.deviceId && pendingAction === 'approve'}
                              disabled={confirmedCount >= MAX_DEVICES || removingId === device.deviceId}
                              onPress={() => handleApprove(device)}
                            >
                              Approve
                            </Button>
                          ) : null}
                          {/* Removing a device that ISN'T this one is a
                              main-device power. A companion offering "Remove"
                              next to the main device was a dead button: the
                              server refuses it (revokeDevice requires the
                              caller to be main), so the only thing it could
                              produce was an error. Worse, it implied a
                              companion could orphan the account by cutting off
                              the only device allowed to approve, back up, or
                              retire anything. Signing THIS device out stays
                              available to everyone — that's self-revocation,
                              not a power over another device. */}
                          {device.deviceId === ownDeviceId || isMainDevice ? (
                            <Button
                              compact
                              textColor={theme.colors.danger}
                              loading={removingId === device.deviceId && pendingAction === 'remove'}
                              disabled={removingId === device.deviceId}
                              onPress={() => handleRemove(device)}
                            >
                              {device.deviceId === ownDeviceId
                                ? 'Sign out'
                                : device.pairingStatus === 'pending_confirmation'
                                  ? 'Deny'
                                  : 'Remove'}
                            </Button>
                          ) : null}
                        </View>
                    )}
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

        {/* Separate card, below the device list: this is troubleshooting, not
            device management, and putting it beside "Remove" would invite
            mistaking one destructive-looking action for the other. */}
        <GlassCard style={styles.card} contentStyle={styles.cardContent}>
          <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
            Messages not decrypting?
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            If messages show as unreadable, resetting this device&apos;s encryption identity makes
            your devices re-establish a secure session with each other.
          </Text>
          <Button
            mode="outlined"
            icon="lock-reset"
            loading={resetting}
            disabled={resetting}
            onPress={handleResetEncryption}
          >
            Reset encryption on this device
          </Button>
        </GlassCard>
      </ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  rowActions: { flexDirection: 'row', alignItems: 'center' },
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
