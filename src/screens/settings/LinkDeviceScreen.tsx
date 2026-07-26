// Main device side of pairing (doc 31 §3.4). Biometric-gated code generation
// (requestPairingCode already does the Face ID/Touch ID prompt before
// returning a code — see pairingService.ts), QR + manual-code display, and
// the mandatory confirmation step once a companion redeems it.

import { GlassCard } from '@/components/ui';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/context/ThemeContext';
import {
  authorizeScannedDevice,
  confirmPairing,
  getCurrentDeviceId,
  parseDeviceOffer,
  requestPairingCode,
  subscribeToPairedDevices,
  type PairedDevice,
} from '@/services/pairingService';
import { appAlert } from '@/utils/appAlert';
import { errorHaptic, successHaptic } from '@/utils/haptics';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import { useEffect, useRef, useState } from 'react';
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
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const [state, setState] = useState<ScreenState>({ kind: 'requesting' });
  const [ownDeviceId, setOwnDeviceId] = useState<string | null>(null);
  const [pendingDevices, setPendingDevices] = useState<PairedDevice[]>([]);
  /** Which device AND which action is resolving — see handleConfirm. */
  const [resolving, setResolving] = useState<{ deviceId: string; confirm: boolean } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();

  /**
   * Reverse pairing: authorize the device whose code we just scanned.
   *
   * Gated behind an explicit confirmation that NAMES the device — see the
   * reasoning at the call site for why the earlier "scanning is itself the
   * consent" argument was wrong.
   */
  /**
   * REFS, NOT STATE — the same fix ScanPairingCodeScreen already needed, which
   * this screen was missing.
   *
   * `onBarcodeScanned` fires once per camera FRAME (~30/s). `if (linking)`
   * reads React state, which had not applied yet when the next frames arrived,
   * so every one of them got through. Once a confirmation dialog was added in
   * front of the authorize call, that turned into an endless stack of
   * identical "Link this device?" alerts that only stopped when the camera was
   * pointed away — exactly what was reported.
   *
   * A ref updates synchronously, so the very next frame is already locked out,
   * and remembering codes we have already prompted for means holding the
   * camera on the same QR never re-asks.
   */
  const scanBusyRef = useRef(false);
  const promptedRef = useRef<Set<string>>(new Set());

  const handleScannedOffer = (result: BarcodeScanningResult) => {
    if (scanBusyRef.current || promptedRef.current.has(result.data)) return;
    const offer = parseDeviceOffer(result.data);
    if (!offer) {
      // Remembered too: an unrecognisable QR in frame would otherwise re-set
      // this error 30 times a second.
      promptedRef.current.add(result.data);
      setLinkError("That doesn't look like a SplitCircle device code.");
      return;
    }
    promptedRef.current.add(result.data);
    scanBusyRef.current = true;
    // CONFIRM BEFORE AUTHORIZING — this is not ceremony, and an earlier
    // version of this comment arguing that it was got the threat model wrong.
    //
    // The forward flow is safe because the secret ORIGINATES on the trusted
    // device: nothing an attacker displays can be a valid code. The reverse
    // flow inverts that — whatever QR the camera happens to see names the
    // device to admit, and `autoConfirm` means it skips the approval step
    // every other path requires. A QR pasted into a chat, printed, or shown on
    // someone else's screen is visually indistinguishable from your own
    // tablet's, so without this the whole attack is "get them to scan a
    // picture" and the reward is a fully-confirmed device on the account.
    //
    // `preauthorizedDeviceId` does not help here: it binds the code to the
    // ATTACKER's device id, which is exactly what their QR contains. It stops
    // a third party stealing someone else's code, not the person who made it.
    //
    // Naming the device is what makes the difference — it is the one moment
    // the user can notice the code says "Pixel 7" while they are holding an
    // iPad.
    const label = offer.deviceName ?? offer.modelName ?? 'this device';
    appAlert(
      `Link ${label}?`,
      `${label}${offer.modelName && offer.deviceName ? ` (${offer.modelName})` : ''} will be added to your account and can read your messages and history. Only continue if this is your own device and you are looking at its screen right now.`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
          // Released so a DIFFERENT device can still be scanned after
          // declining; the code just declined stays in promptedRef, so
          // pointing at it again does not re-prompt.
          onPress: () => {
            scanBusyRef.current = false;
          },
        },
        {
          text: 'Link device',
          onPress: () => {
            setLinking(true);
            setLinkError(null);
            void authorizeScannedDevice(offer)
              .then(() => {
                successHaptic();
                setScanning(false);
              })
              .catch((error) => {
                errorHaptic();
                setLinkError(errorMessage(error));
              })
              .finally(() => {
                setLinking(false);
                scanBusyRef.current = false;
              });
          },
        },
      ],
    );
  };

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
    // Track WHICH action is in flight, not just which device. Keying both
    // buttons off the device id alone spun BOTH of them on either tap, so the
    // user could not tell whether they had approved or denied — the single
    // most consequential choice on this screen.
    setResolving({ deviceId, confirm });
    try {
      await confirmPairing(deviceId, confirm);
      confirm ? successHaptic() : errorHaptic();
    } catch (error) {
      errorHaptic();
    } finally {
      setResolving(null);
    }
  };

  return (
    <LiquidBackground>
      <ScrollView contentContainerStyle={[styles.container, { paddingTop: headerHeight + 16, paddingBottom: insets.bottom + 32 }]} showsVerticalScrollIndicator={false}>
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

          {/* Reverse pairing: scan the NEW device's code with this one. Asked
              for 2026-07-25 alongside the existing direction, not instead of
              it — this way round is easier when the new phone is the one
              already in your hand. */}
          {state.kind === 'ready' && !scanning ? (
            <Button mode="outlined" onPress={() => setScanning(true)}>
              Scan a device&apos;s code instead
            </Button>
          ) : null}

          {scanning ? (
            <>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                On the new device, choose &quot;Show a code for my other device to scan&quot;, then
                point this camera at it.
              </Text>
              <View style={styles.qrWrap}>
                {!permission?.granted ? (
                  <Button mode="contained" onPress={() => void requestPermission()}>
                    Allow camera
                  </Button>
                ) : (
                  <CameraView
                    style={styles.camera}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={handleScannedOffer}
                  />
                )}
              </View>
              {linkError ? (
                <Text variant="bodyMedium" style={{ color: theme.colors.danger, textAlign: 'center' }}>
                  {linkError}
                </Text>
              ) : null}
              {linking ? <ActivityIndicator size="small" color={theme.colors.primary} /> : null}
              <Button compact onPress={() => { setScanning(false); setLinkError(null); }}>
                Show my code instead
              </Button>
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
                    loading={resolving?.deviceId === device.deviceId && resolving.confirm === false}
                    // Both disable while either runs, so a second tap can't
                    // fire the opposite action mid-flight.
                    disabled={resolving?.deviceId === device.deviceId}
                    onPress={() => handleConfirm(device.deviceId, false)}
                  >
                    Deny
                  </Button>
                  <Button
                    mode="contained"
                    loading={resolving?.deviceId === device.deviceId && resolving.confirm === true}
                    disabled={resolving?.deviceId === device.deviceId}
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
    // DELIBERATE solid white, not a liquid-glass miss (DESIGN.md's self-audit
    // greps for exactly this literal). A QR code needs a high-contrast opaque
    // quiet zone to be scannable at all — glass behind the modules would put a
    // moving, translucent backdrop under the very thing a camera must resolve.
    // Same class of exception as the roulette hub.
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
  },
  camera: {
    width: 240,
    height: 240,
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
