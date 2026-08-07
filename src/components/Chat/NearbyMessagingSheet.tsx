import { GlassCard } from '@/components/ui';
import { APP_NAME } from '@/constants/appInfo';
import { useTheme } from '@/context/ThemeContext';
import { useNearbyMessaging } from '@/hooks/useNearbyMessaging';
import { useNearbyPairing } from '@/hooks/useNearbyPairing';
import { reachableNodeIds } from '@/services/nearbyMessagingState';
import { describeRoutes } from '@/services/mesh/routeStatus';
import {
  getMeshDiagnostics,
  restartNearbyMessagingDiscovery,
} from '@/services/nearbyMessageService';
import type { MeshDiagnostics } from '@/services/mesh/diagnostics';
import {
  cancelNearbyPairing,
  formatNearbyPairingCode,
  normalizeNearbyPairingCode,
  startNearbyPairingHost,
  startNearbyPairingJoin,
} from '@/services/nearbyPairingService';
import { lightHaptic } from '@/utils/haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { NearbyDiscoveryArena } from './NearbyDiscoveryArena';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface NearbyMessagingSheetProps {
  visible: boolean;
  chatId: string;
  chatType: 'direct' | 'group';
  onClose: () => void;
}

/** Icon per route. Kept in the view; `describeRoutes` stays free of RN types. */
const ROUTE_ICON: Record<string, React.ComponentProps<typeof Ionicons>['name']> = {
  mpc: 'phone-portrait-outline',
  lan: 'wifi-outline',
  ble: 'bluetooth-outline',
};

const Step = ({
  number,
  title,
  detail,
}: {
  number: number;
  title: string;
  detail: string;
}) => {
  const { theme } = useTheme();
  return (
    <View style={styles.step}>
      <View style={[styles.stepNumber, { backgroundColor: theme.colors.primaryContainer }]}>
        <Text style={[styles.stepNumberText, { color: theme.colors.onPrimaryContainer }]}>
          {number}
        </Text>
      </View>
      <View style={styles.stepCopy}>
        <Text style={[styles.stepTitle, { color: theme.colors.onSurface }]}>{title}</Text>
        <Text style={[styles.stepDetail, { color: theme.colors.onSurfaceVariant }]}>
          {detail}
        </Text>
      </View>
    </View>
  );
};

export const NearbyMessagingSheet = ({
  visible,
  chatId,
  chatType,
  onClose,
}: NearbyMessagingSheetProps) => {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { snapshot } = useNearbyMessaging();
  const pairing = useNearbyPairing();
  const [sheetHeight, setSheetHeight] = useState(680);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>();
  const [showSetup, setShowSetup] = useState(false);

  /**
   * Polled only while the sheet is open, and only for hardware availability —
   * the connected/not-connected answer comes from `snapshot.transportPeers`,
   * which is pushed. 3s is slow enough not to matter and fast enough that
   * flipping a radio in Settings and coming back shows the truth.
   */
  const [diagnostics, setDiagnostics] = useState<MeshDiagnostics | null>(null);
  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    const read = () => {
      void getMeshDiagnostics().then((next) => {
        if (!cancelled) setDiagnostics(next);
      }).catch(() => undefined);
    };
    read();
    const timer = setInterval(read, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible]);

  // Derivation lives in `mesh/routeStatus` so the wording and the precedence
  // between "connected", "not in this build" and "radio off" are testable
  // without rendering this sheet.
  const routeRows = useMemo(
    () => describeRoutes(snapshot.transportPeers, diagnostics, Platform.OS === 'ios'),
    [snapshot.transportPeers, diagnostics],
  );
  const [showPairing, setShowPairing] = useState(false);
  const [pairingEntry, setPairingEntry] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingUiError, setPairingUiError] = useState<string>();
  const translateY = useRef(new Animated.Value(760)).current;
  const closingRef = useRef(false);

  const dismiss = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.timing(translateY, {
      toValue: sheetHeight + 60,
      duration: 220,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      closingRef.current = false;
      onClose();
    });
  };

  useEffect(() => {
    if (!visible) return;
    closingRef.current = false;
    translateY.setValue(sheetHeight + 60);
    Animated.timing(translateY, {
      toValue: 0,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, sheetHeight, translateY]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          gesture.dy > 7 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_, gesture) => {
          translateY.setValue(Math.max(0, gesture.dy));
        },
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy > 110 || gesture.vy > 0.85) {
            dismiss();
            return;
          }
          Animated.spring(translateY, {
            toValue: 0,
            speed: 24,
            bounciness: 4,
            useNativeDriver: true,
          }).start();
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateY, {
            toValue: 0,
            speed: 24,
            bounciness: 4,
            useNativeDriver: true,
          }).start();
        },
      }),
    [sheetHeight, translateY],
  );

  const hasError = snapshot.status === 'error';
  // Reachability across all transports, not the MPC-only status field — on
  // Android that field never leaves its initial value however many BLE or LAN
  // peers are live, so this whole sheet rendered its disconnected state during
  // a working session.
  const isConnected = reachableNodeIds(snapshot).length > 0 || snapshot.status === 'connected';
  const messageEvent = snapshot.lastMessageEvent?.chatId === undefined
    || snapshot.lastMessageEvent.chatId === chatId
    ? snapshot.lastMessageEvent
    : undefined;
  const pairingActive = pairing.phase !== 'idle';

  const runPairingAction = async (action: () => Promise<void>) => {
    setPairingBusy(true);
    setPairingUiError(undefined);
    try {
      await action();
    } catch (error) {
      setPairingUiError(
        error instanceof Error ? error.message : 'Pairing could not start.',
      );
    } finally {
      setPairingBusy(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={dismiss}
    >
      <View style={styles.overlay} accessibilityViewIsModal>
        <Pressable
          style={styles.backdrop}
          onPress={dismiss}
          accessibilityRole="button"
          accessibilityLabel="Close nearby messaging"
        />
        <Animated.View
          onLayout={(event) => setSheetHeight(event.nativeEvent.layout.height)}
          style={[
            styles.sheetWrap,
            {
              paddingBottom: Math.max(insets.bottom, theme.spacing.sm),
              transform: [{ translateY }],
            },
          ]}
        >
          <GlassCard role="floating"
            radius="xl"
            style={styles.sheetCard}
            contentStyle={styles.sheetContent}
          >
            <View style={styles.dragZone} {...panResponder.panHandlers}>
              <View style={[styles.grabber, { backgroundColor: theme.colors.outline }]} />
            </View>

            <View style={styles.header}>
              <View style={styles.headerCopy}>
                <Text style={[styles.eyebrow, { color: theme.colors.primary }]}>
                  WITHOUT INTERNET
                </Text>
                <Text variant="headlineSmall" style={[styles.title, { color: theme.colors.onSurface }]}>
                  Nearby messaging
                </Text>
                <Text style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}>
                  Connect privately to known conversation members. No hotspot, router, or internet is required.
                </Text>
              </View>
              <Pressable
                onPress={dismiss}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={styles.closeButton}
              >
                <GlassCard role="floating" radius={17} contentStyle={styles.closeButtonContent}>
                  <Ionicons name="close" size={20} color={theme.colors.onSurfaceVariant} />
                </GlassCard>
              </Pressable>
            </View>

            <ScrollView
              style={styles.scroll}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.scrollContent}
            >
              <NearbyDiscoveryArena
                active={visible}
                snapshot={snapshot}
                selectedDeviceId={selectedDeviceId}
                onSelectDevice={setSelectedDeviceId}
                onScanAgain={restartNearbyMessagingDiscovery}
              />

              <GlassCard radius="md" contentStyle={styles.pairingCard}>
                <View style={styles.pairingHeader}>
                  <View
                    style={[
                      styles.pairingIcon,
                      { backgroundColor: theme.colors.primaryContainer },
                    ]}
                  >
                    <Ionicons
                      name={pairing.phase === 'paired' ? 'checkmark' : 'link-outline'}
                      size={19}
                      color={theme.colors.primary}
                    />
                  </View>
                  <View style={styles.pairingHeaderCopy}>
                    <Text style={[styles.pairingTitle, { color: theme.colors.onSurface }]}>
                      {pairing.phase === 'paired'
                        ? `${pairing.pairedPeer?.label ?? 'Phone'} paired`
                        : 'Pair a phone privately'}
                    </Text>
                    <Text style={[styles.pairingDetail, { color: theme.colors.onSurfaceVariant }]}>
                      {pairing.phase === 'paired'
                        ? 'Both phones now remember the signed device identity for 30 days.'
                        : 'Use a one-time code when a friend is shown as unknown. Names stay hidden until the code and signed identities match.'}
                    </Text>
                  </View>
                </View>

                {!showPairing && !pairingActive && (
                  <TouchableOpacity
                    onPress={() => {
                      lightHaptic();
                      setShowPairing(true);
                      setPairingEntry(false);
                      setPairingUiError(undefined);
                    }}
                    activeOpacity={0.75}
                    accessibilityRole="button"
                    style={[styles.pairingPrimaryButton, { backgroundColor: theme.colors.primary }]}
                  >
                    <Ionicons name="people-outline" size={17} color={theme.colors.onPrimary} />
                    <Text style={[styles.pairingPrimaryLabel, { color: theme.colors.onPrimary }]}>
                      Pair a nearby phone
                    </Text>
                  </TouchableOpacity>
                )}

                {showPairing && !pairingActive && !pairingEntry && (
                  <View style={styles.pairingChoices}>
                    <TouchableOpacity
                      onPress={() => {
                        lightHaptic();
                        void runPairingAction(startNearbyPairingHost);
                      }}
                      disabled={pairingBusy}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      style={[styles.pairingChoice, { borderColor: theme.colors.outline }]}
                    >
                      <Ionicons name="key-outline" size={19} color={theme.colors.primary} />
                      <Text style={[styles.pairingChoiceTitle, { color: theme.colors.onSurface }]}>
                        Show a code
                      </Text>
                      <Text style={[styles.pairingChoiceDetail, { color: theme.colors.onSurfaceVariant }]}>
                        The other person enters it.
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        lightHaptic();
                        setPairingEntry(true);
                      }}
                      disabled={pairingBusy}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      style={[styles.pairingChoice, { borderColor: theme.colors.outline }]}
                    >
                      <Ionicons name="keypad-outline" size={19} color={theme.colors.primary} />
                      <Text style={[styles.pairingChoiceTitle, { color: theme.colors.onSurface }]}>
                        Enter their code
                      </Text>
                      <Text style={[styles.pairingChoiceDetail, { color: theme.colors.onSurfaceVariant }]}>
                        Pair with the code they show.
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}

                {showPairing && !pairingActive && pairingEntry && (
                  <View style={styles.pairingEntry}>
                    <TextInput
                      value={formatNearbyPairingCode(pairingCode)}
                      onChangeText={(value) => {
                        setPairingCode(normalizeNearbyPairingCode(value));
                        setPairingUiError(undefined);
                      }}
                      placeholder="ABCD EFGH"
                      placeholderTextColor={theme.colors.onSurfaceVariant}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      maxLength={9}
                      returnKeyType="done"
                      accessibilityLabel="Nearby pairing code"
                      style={[
                        styles.pairingCodeInput,
                        {
                          color: theme.colors.onSurface,
                          borderColor: theme.colors.outline,
                          backgroundColor: theme.colors.surfaceVariant,
                        },
                      ]}
                    />
                    <TouchableOpacity
                      onPress={() => {
                        lightHaptic();
                        void runPairingAction(() => startNearbyPairingJoin(pairingCode));
                      }}
                      disabled={pairingBusy || pairingCode.length !== 8}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      style={[
                        styles.pairingPrimaryButton,
                        {
                          backgroundColor: theme.colors.primary,
                          opacity: pairingBusy || pairingCode.length !== 8 ? 0.5 : 1,
                        },
                      ]}
                    >
                      <Ionicons name="shield-checkmark-outline" size={17} color={theme.colors.onPrimary} />
                      <Text style={[styles.pairingPrimaryLabel, { color: theme.colors.onPrimary }]}>
                        Find and verify phone
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}

                {pairing.role === 'host' && pairing.code && pairing.phase !== 'paired' && (
                  <View
                    style={[
                      styles.pairingCodePanel,
                      { backgroundColor: theme.colors.primaryContainer },
                    ]}
                  >
                    <Text style={[styles.pairingCodeEyebrow, { color: theme.colors.onPrimaryContainer }]}>
                      ONE-TIME PAIRING CODE
                    </Text>
                    <Text style={[styles.pairingCode, { color: theme.colors.onPrimaryContainer }]}>
                      {formatNearbyPairingCode(pairing.code)}
                    </Text>
                    <Text style={[styles.pairingCodeHint, { color: theme.colors.onPrimaryContainer }]}>
                      Open Pair a phone on the other iPhone and enter this code. It expires in five minutes.
                    </Text>
                  </View>
                )}

                {pairingActive && pairing.phase !== 'paired' && (
                  <View style={styles.pairingStatus}>
                    <Ionicons
                      name={pairing.phase === 'error' ? 'alert-circle-outline' : 'radio-outline'}
                      size={18}
                      color={pairing.phase === 'error' ? theme.colors.error : theme.colors.primary}
                    />
                    <Text
                      style={[
                        styles.pairingStatusText,
                        {
                          color: pairing.phase === 'error'
                            ? theme.colors.error
                            : theme.colors.onSurfaceVariant,
                        },
                      ]}
                    >
                      {pairing.errorMessage
                        ?? (pairing.phase === 'verifying'
                          ? 'Phone found. Verifying the code and both signed identities…'
                          : 'Looking for the other phone. Keep this screen open on both devices.')}
                    </Text>
                  </View>
                )}

                {(showPairing || pairingActive) && (
                  <TouchableOpacity
                    onPress={() => {
                      lightHaptic();
                      cancelNearbyPairing();
                      setShowPairing(false);
                      setPairingEntry(false);
                      setPairingCode('');
                      setPairingUiError(undefined);
                    }}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    style={styles.pairingCancel}
                  >
                    <Text style={[styles.pairingCancelLabel, { color: theme.colors.primary }]}>
                      {pairing.phase === 'paired' ? 'Done' : 'Cancel pairing'}
                    </Text>
                  </TouchableOpacity>
                )}

                {(pairingUiError || pairing.errorMessage) && pairing.phase === 'idle' && (
                  <Text style={[styles.pairingError, { color: theme.colors.error }]}>
                    {pairingUiError ?? pairing.errorMessage}
                  </Text>
                )}
              </GlassCard>

              <View style={[styles.directCallout, { backgroundColor: theme.colors.successContainer }]}>
                <Ionicons name="shield-checkmark-outline" size={20} color={theme.colors.success} />
                <View style={styles.directCalloutCopy}>
                  <Text style={[styles.directCalloutTitle, { color: theme.colors.onSuccessContainer }]}>
                    Names stay private
                  </Text>
                  <Text style={[styles.directCalloutDetail, { color: theme.colors.onSuccessContainer }]}>
                    {APP_NAME} never broadcasts your profile name while scanning. A name appears only after a cached conversation match or a pairing code succeeds. Unknown installations stay blocked outside the five-minute pairing window.
                  </Text>
                </View>
              </View>

              <GlassCard radius="md" contentStyle={styles.requirementsCard}>
                <Text style={[styles.requirementsTitle, { color: theme.colors.onSurface }]}>
                  Routes
                </Text>
                {/* REAL per-route state, replacing a static "Wi-Fi on / Bluetooth
                    on / Apps open" checklist that was user-verified and only
                    turned green once something connected. That checklist could
                    not distinguish the case that actually happens — one radio
                    working and another off — so when nothing connected, both
                    phones showed an identical, unactionable screen. */}
                <View style={styles.routeList}>
                  {routeRows.map((route) => (
                    <View key={route.id} style={styles.routeRow}>
                      <View
                        style={[
                          styles.requirementIcon,
                          {
                            backgroundColor: route.tone === 'success'
                              ? theme.colors.successContainer
                              : route.tone === 'warning'
                                ? theme.colors.errorContainer
                                : theme.colors.primaryContainer,
                          },
                        ]}
                      >
                        <Ionicons
                          name={route.connected ? 'checkmark' : ROUTE_ICON[route.id]}
                          size={16}
                          color={route.tone === 'success'
                            ? theme.colors.success
                            : route.tone === 'warning'
                              ? theme.colors.error
                              : theme.colors.primary}
                        />
                      </View>
                      <View style={styles.routeCopy}>
                        <Text style={[styles.routeName, { color: theme.colors.onSurface }]}>
                          {route.name}
                        </Text>
                        <Text style={[styles.routeDetail, { color: theme.colors.onSurfaceVariant }]}>
                          {route.detail}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
                <Text style={[styles.requirementsHint, { color: theme.colors.onSurfaceVariant }]}>
                  {isConnected
                    ? 'Messages in this chat go straight to the other phone. Nothing touches the internet.'
                    : 'A route has to be On here AND on the other phone. Both apps need to be open.'}
                </Text>
              </GlassCard>

              <Pressable
                onPress={() => {
                  lightHaptic();
                  setShowSetup((current) => !current);
                }}
                accessibilityRole="button"
                accessibilityLabel="How nearby discovery works"
                accessibilityState={{ expanded: showSetup }}
              >
                <GlassCard radius="md" contentStyle={styles.disclosureHeader}>
                  <View style={styles.disclosureTitleWrap}>
                    <Ionicons name="help-circle-outline" size={20} color={theme.colors.primary} />
                    <Text style={[styles.disclosureTitle, { color: theme.colors.onSurface }]}>
                      How to connect
                    </Text>
                  </View>
                  <Ionicons
                    name={showSetup ? 'chevron-up' : 'chevron-down'}
                    size={19}
                    color={theme.colors.onSurfaceVariant}
                  />
                </GlassCard>
              </Pressable>

              {showSetup && (
                <GlassCard radius="md" contentStyle={styles.stepsCard}>
                  <Step
                    number={1}
                    title={`Open ${APP_NAME} on both phones`}
                    detail="Sign in online once beforehand, then keep both apps in the foreground."
                  />
                  <Step
                    number={2}
                    title="Keep Wi-Fi and Bluetooth on"
                    detail="No network join is needed. In Airplane Mode, turn both radios back on."
                  />
                  <Step
                    number={3}
                    title="Connect automatically or pair once"
                    detail="Cached conversation identities connect automatically. If one phone lacks the cache, open Pair a phone on both and verify the one-time code."
                  />
                </GlassCard>
              )}

              <GlassCard radius="md" contentStyle={styles.infoCard}>
                <Ionicons name="lock-closed-outline" size={20} color={theme.colors.primary} />
                <View style={styles.infoCopy}>
                  <Text style={[styles.infoTitle, { color: theme.colors.onSurface }]}>
                    Private local-network access
                  </Text>
                  <Text style={[styles.infoDetail, { color: theme.colors.onSurfaceVariant }]}>
                    iOS asks the first time {APP_NAME} searches nearby. Discovery exposes no profile name; only cached conversation devices are invited.
                  </Text>
                  {Platform.OS === 'ios' && (
                    <TouchableOpacity
                      onPress={() => {
                        lightHaptic();
                        void Linking.openSettings();
                      }}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      style={styles.settingsButton}
                    >
                      <Text style={[styles.settingsLabel, { color: theme.colors.primary }]}>
                        Open {APP_NAME} Settings
                      </Text>
                      <Ionicons name="open-outline" size={15} color={theme.colors.primary} />
                    </TouchableOpacity>
                  )}
                </View>
              </GlassCard>

              <View style={[styles.deliveryNote, { borderColor: theme.colors.outline }]}>
                <Ionicons
                  name={chatType === 'group' ? 'people-outline' : 'person-outline'}
                  size={19}
                  color={theme.colors.onSurfaceVariant}
                />
                <Text style={[styles.deliveryText, { color: theme.colors.onSurfaceVariant }]}>
                  {chatType === 'group'
                    ? 'Group messages reach connected members nearby and the sender uploads them to the cloud when internet returns.'
                    : 'Direct messages sent nearby remain local to the connected phones and are not uploaded to the cloud.'}
                </Text>
              </View>
            </ScrollView>

            <View style={[styles.footer, { borderTopColor: theme.colors.outline }]}>
              <View style={styles.footerCopy}>
                <Text style={[styles.footerTitle, { color: theme.colors.onSurface }]}>
                  {isConnected ? 'Phone link ready' : hasError ? 'Discovery paused' : 'Discovery runs automatically'}
                </Text>
                <Text style={[styles.footerDetail, { color: theme.colors.onSurfaceVariant }]}>
                  {messageEvent?.detail ?? 'Link tests transport only. Messages are separately signed and decrypted.'}
                </Text>
              </View>
              {snapshot.status !== 'unavailable' && (
                <TouchableOpacity
                  onPress={() => {
                    lightHaptic();
                    if (isConnected) {
                      dismiss();
                    } else {
                      restartNearbyMessagingDiscovery();
                    }
                  }}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityLabel={isConnected ? 'Close nearby discovery' : 'Scan for phones again'}
                  style={[styles.retryButton, { backgroundColor: theme.colors.primary }]}
                >
                  <Ionicons
                    name={isConnected ? 'checkmark' : 'refresh'}
                    size={17}
                    color={theme.colors.onPrimary}
                  />
                  <Text style={[styles.retryLabel, { color: theme.colors.onPrimary }]}>
                    {isConnected ? 'Done' : 'Scan again'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </GlassCard>
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.44)',
  },
  sheetWrap: {
    maxHeight: '91%',
    paddingHorizontal: 8,
  },
  sheetCard: {
    overflow: 'hidden',
  },
  sheetContent: {
    maxHeight: '100%',
  },
  dragZone: {
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grabber: {
    width: 38,
    height: 4,
    borderRadius: 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 18,
    paddingBottom: 14,
  },
  headerCopy: {
    flex: 1,
    paddingRight: 12,
  },
  eyebrow: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  title: {
    fontWeight: '700',
    marginTop: 2,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 3,
  },
  closeButton: {
    width: 34,
    height: 34,
  },
  closeButtonContent: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 14,
  },
  scroll: {
    flexShrink: 1,
  },
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 18,
    padding: 14,
  },
  directCallout: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: 18,
    padding: 14,
  },
  pairingCard: {
    padding: 14,
  },
  pairingHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  pairingIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pairingHeaderCopy: {
    flex: 1,
    marginLeft: 11,
  },
  pairingTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  pairingDetail: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  pairingPrimaryButton: {
    minHeight: 44,
    borderRadius: 22,
    marginTop: 13,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  pairingPrimaryLabel: {
    fontSize: 13,
    fontWeight: '800',
  },
  pairingChoices: {
    flexDirection: 'row',
    gap: 9,
    marginTop: 13,
  },
  pairingChoice: {
    flex: 1,
    minHeight: 104,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 12,
  },
  pairingChoiceTitle: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    marginTop: 8,
  },
  pairingChoiceDetail: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
  },
  pairingEntry: {
    marginTop: 13,
  },
  pairingCodeInput: {
    height: 54,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: 16,
    textAlign: 'center',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 2.5,
  },
  pairingCodePanel: {
    borderRadius: 18,
    padding: 16,
    marginTop: 13,
    alignItems: 'center',
  },
  pairingCodeEyebrow: {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '800',
    letterSpacing: 1,
  },
  pairingCode: {
    fontSize: 28,
    lineHeight: 38,
    fontWeight: '800',
    letterSpacing: 3,
    marginTop: 3,
  },
  pairingCodeHint: {
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: 4,
  },
  pairingStatus: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 12,
  },
  pairingStatusText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
  },
  pairingCancel: {
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingTop: 13,
    paddingBottom: 2,
  },
  pairingCancelLabel: {
    fontSize: 13,
    fontWeight: '700',
  },
  pairingError: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 9,
    textAlign: 'center',
  },
  directCalloutCopy: {
    flex: 1,
    marginLeft: 11,
  },
  directCalloutTitle: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
  },
  directCalloutDetail: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  requirementsCard: {
    padding: 14,
  },
  requirementsTitle: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
  },
  routeList: {
    marginTop: 10,
    gap: 10,
  },
  routeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  routeCopy: {
    flex: 1,
  },
  routeName: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  routeDetail: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 1,
  },
  requirementRail: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
    gap: 8,
  },
  requirement: {
    flex: 1,
    alignItems: 'center',
  },
  requirementIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  requirementLabel: {
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '700',
    marginTop: 5,
  },
  requirementsHint: {
    fontSize: 11,
    lineHeight: 16,
    marginTop: 12,
  },
  disclosureHeader: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
  },
  disclosureTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  disclosureTitle: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
  },
  statusIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusCopy: {
    flex: 1,
    marginLeft: 12,
  },
  statusTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
  },
  statusDetail: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '700',
    marginTop: 2,
  },
  stepsCard: {
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  step: {
    flexDirection: 'row',
    paddingVertical: 10,
  },
  stepNumber: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepNumberText: {
    fontSize: 12,
    fontWeight: '800',
  },
  stepCopy: {
    flex: 1,
    marginLeft: 11,
  },
  stepTitle: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
  },
  stepDetail: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  infoCard: {
    flexDirection: 'row',
    padding: 14,
  },
  infoCopy: {
    flex: 1,
    marginLeft: 11,
  },
  infoTitle: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '700',
  },
  infoDetail: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  settingsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingTop: 9,
    paddingBottom: 2,
  },
  settingsLabel: {
    fontSize: 13,
    fontWeight: '700',
  },
  deliveryNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    gap: 9,
  },
  fallbackNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    gap: 9,
  },
  fallbackText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
  },
  deliveryText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 70,
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerCopy: {
    flex: 1,
    paddingRight: 10,
  },
  footerTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  footerDetail: {
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
  },
  retryButton: {
    minHeight: 40,
    borderRadius: 20,
    paddingHorizontal: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  retryLabel: {
    fontSize: 13,
    fontWeight: '700',
  },
});

export default NearbyMessagingSheet;
