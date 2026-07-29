import { GlassCard } from '@/components/ui';
import { APP_NAME } from '@/constants/appInfo';
import { useTheme } from '@/context/ThemeContext';
import { useNearbyMessaging } from '@/hooks/useNearbyMessaging';
import { restartNearbyMessagingDiscovery } from '@/services/nearbyMessageService';
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
  const [sheetHeight, setSheetHeight] = useState(680);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>();
  const [showSetup, setShowSetup] = useState(false);
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
  const isConnected = snapshot.status === 'connected';
  const messageEvent = snapshot.lastMessageEvent?.chatId === undefined
    || snapshot.lastMessageEvent.chatId === chatId
    ? snapshot.lastMessageEvent
    : undefined;

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
          <GlassCard
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
                  Connect iPhones directly. No hotspot, router, or internet is required.
                </Text>
              </View>
              <Pressable
                onPress={dismiss}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={styles.closeButton}
              >
                <GlassCard radius={17} contentStyle={styles.closeButtonContent}>
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

              <View style={[styles.directCallout, { backgroundColor: theme.colors.successContainer }]}>
                <Ionicons name="flash-outline" size={20} color={theme.colors.success} />
                <View style={styles.directCalloutCopy}>
                  <Text style={[styles.directCalloutTitle, { color: theme.colors.onSuccessContainer }]}>
                    No Personal Hotspot needed
                  </Text>
                  <Text style={[styles.directCalloutDetail, { color: theme.colors.onSuccessContainer }]}>
                    {APP_NAME} uses Apple peer-to-peer Wi-Fi to create a direct local link between nearby iPhones.
                  </Text>
                </View>
              </View>

              <GlassCard radius="md" contentStyle={styles.requirementsCard}>
                <Text style={[styles.requirementsTitle, { color: theme.colors.onSurface }]}>
                  Connection requirements
                </Text>
                <View style={styles.requirementRail}>
                  {[
                    { icon: 'wifi-outline' as const, label: 'Wi-Fi on' },
                    { icon: 'bluetooth-outline' as const, label: 'Bluetooth on' },
                    { icon: 'phone-portrait-outline' as const, label: 'Apps open' },
                  ].map((item) => (
                    <View key={item.label} style={styles.requirement}>
                      <View
                        style={[
                          styles.requirementIcon,
                          {
                            backgroundColor: isConnected
                              ? theme.colors.successContainer
                              : theme.colors.primaryContainer,
                          },
                        ]}
                      >
                        <Ionicons
                          name={isConnected ? 'checkmark' : item.icon}
                          size={16}
                          color={isConnected ? theme.colors.success : theme.colors.primary}
                        />
                      </View>
                      <Text style={[styles.requirementLabel, { color: theme.colors.onSurface }]}>
                        {item.label}
                      </Text>
                    </View>
                  ))}
                </View>
                <Text style={[styles.requirementsHint, { color: theme.colors.onSurfaceVariant }]}>
                  {isConnected
                    ? 'The active direct link confirms these requirements are available.'
                    : 'iOS does not let apps read every radio or permission state directly, so these remain user-verified until a phone connects.'}
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
                    title="Keep the phones nearby"
                    detail="Open the same cached conversation. Discovery and encryption are automatic."
                  />
                </GlassCard>
              )}

              <GlassCard radius="md" contentStyle={styles.infoCard}>
                <Ionicons name="lock-closed-outline" size={20} color={theme.colors.primary} />
                <View style={styles.infoCopy}>
                  <Text style={[styles.infoTitle, { color: theme.colors.onSurface }]}>
                    Local Network access is required
                  </Text>
                  <Text style={[styles.infoDetail, { color: theme.colors.onSurfaceVariant }]}>
                    iOS asks the first time {APP_NAME} searches nearby. If it was denied, enable Local Network in {APP_NAME}’s iPhone settings.
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
    marginTop: 11,
    textAlign: 'center',
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
