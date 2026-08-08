import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { MugguMark } from '@/components/brand';
import { APP_NAME } from '@/constants/appInfo';
import { useNotificationContext } from '@/context/NotificationContext';
import { useTheme } from '@/context/ThemeContext';
import { clearCallDebugLedger, formatCallDebugEntries, getCallDebugEntries } from '@/services/callDebugLedger';
import { lightHaptic, selectionHaptic } from '@/utils/haptics';
import { SETTING_IDS } from '@/constants/settingsRegistry';
import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  getRingOnThisDevice,
  setRingOnThisDevice,
} from '@/services/devicePreferencesService';
import { Animated, ScrollView, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Button, List, Switch, Text } from 'react-native-paper';
import { Divider, TRANSPARENT_HEADER_CLEARANCE } from '@/components/ui';
import { useNavigation, useRoute } from '@react-navigation/native';
import { SCREEN_TITLES } from '@/navigation/screenTitles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { appAlert } from '@/utils/appAlert';

const formatTimestamp = (value: number | null): string => {
  if (!value) {
    return 'Not yet';
  }

  return new Date(value).toLocaleString();
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim();
    }
  }

  return 'Something went wrong while updating notifications.';
};

const StatusPill = ({
  label,
  value,
  color,
  textColor,
}: {
  label: string;
  value: string;
  color: string;
  textColor: string;
}) => (
  <View style={[styles.statusPill, { borderColor: `${color}66`, backgroundColor: `${color}14` }]}>
    <Text variant="labelSmall" style={[styles.statusPillLabel, { color }]}>
      {label}
    </Text>
    <Text variant="bodySmall" style={[styles.statusPillValue, { color: textColor }]}>
      {value}
    </Text>
  </View>
);

type ToggleRowProps = {
  title: string;
  description: string;
  value: boolean;
  icon: string;
  iconColor: string;
  disabled?: boolean;
  onValueChange: (value: boolean) => void | Promise<void>;
};

const ToggleRow = ({
  title,
  description,
  value,
  icon,
  iconColor,
  disabled,
  onValueChange,
}: ToggleRowProps) => (
  <List.Item
    title={title}
    description={description}
    titleStyle={disabled ? styles.disabledText : undefined}
    descriptionStyle={disabled ? styles.disabledText : undefined}
    left={() => <List.Icon icon={icon} color={disabled ? '#6B7280' : iconColor} />}
    right={() => (
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={(nextValue) => {
          void onValueChange(nextValue);
        }}
      />
    )}
  />
);

export const NotificationSettingsScreen = () => {
  const navigation = useNavigation();
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const {
    preferences,
    pushToken,
    permission,
    currentDevice,
    refreshRegistration,
    openSystemSettings,
    updatePreference,
    sendLocalTestNotification,
    sendRemoteTestNotification,
  } = useNotificationContext();

  const { user } = useAuth();
  /** Per-device ringing (doc 31 #13). Local scope — no other device to hear
   *  from, so a one-shot read on mount is the complete story. */
  const [ringHere, setRingHere] = useState(true);
  useEffect(() => {
    if (!user?.userId) return;
    void getRingOnThisDevice(user.userId).then(setRingHere);
  }, [user?.userId]);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSendingRemoteTest, setIsSendingRemoteTest] = useState(false);
  const [isSendingLocalTest, setIsSendingLocalTest] = useState(false);
  // Persistent call-debug ledger viewer. null = collapsed (not loaded yet).
  const [callDebugText, setCallDebugText] = useState<string | null>(null);
  const [callDebugCount, setCallDebugCount] = useState(0);
  const [isLoadingCallDebug, setIsLoadingCallDebug] = useState(false);
  const scrollY = useRef(new Animated.Value(0)).current;
  const route = useRoute<any>();
  const scrollRef = useRef<any>(null);

  // Deep-link highlight: search results into a specific setting arrive with a
  // `highlight` param (the registry id). We scroll that row into view and pulse
  // a tinted overlay so the user can see exactly which setting they landed on.
  const anchorRefs = useRef<Record<string, View | null>>({});
  const highlightOpacity = useRef(new Animated.Value(0)).current;
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // Scroll a registered anchor into view, measured relative to the scroll view
  // so nested cards/sections are handled correctly. Best-effort — if the row
  // isn't mounted it simply no-ops.
  const scrollToAnchor = (id: string) => {
    const node = anchorRefs.current[id];
    const scroll = scrollRef.current;
    if (!node || !scroll) return;
    const scrollNode =
      typeof scroll.getScrollableNode === 'function' ? scroll.getScrollableNode() : scroll;
    try {
      node.measureLayout(
        scrollNode,
        (_x: number, y: number) => scroll.scrollTo({ y: Math.max(0, y - 90), animated: true }),
        () => { /* measure failed — leave the scroll position as-is */ },
      );
    } catch { /* measureLayout unavailable — non-fatal */ }
  };

  // React to a `highlight` deep-link param: scroll to and pulse the target row.
  // The param is consumed *inside* the timeout (after the pulse starts) so the
  // resulting re-render doesn't cancel the pending timer via effect cleanup.
  useEffect(() => {
    const target = route.params?.highlight as string | undefined;
    if (!target) return;
    const timer = setTimeout(() => {
      setHighlightId(target);
      scrollToAnchor(target);
      highlightOpacity.setValue(0.18);
      Animated.timing(highlightOpacity, {
        toValue: 0,
        duration: 1600,
        delay: 400,
        useNativeDriver: false,
      }).start(({ finished }) => {
        if (finished) setHighlightId(null);
      });
      (navigation as any).setParams({ highlight: undefined });
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.highlight]);

  // Wraps a row so it can be scrolled to and briefly tinted. Written as a plain
  // render helper (not a component) so wrapping never remounts the row's
  // ToggleRow / Switch subtree on re-render.
  const wrapAnchor = (id: string, node: ReactNode) => (
    <View
      ref={(r) => {
        anchorRefs.current[id] = r;
      }}
    >
      {node}
      {highlightId === id ? (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: theme.colors.primary, borderRadius: 12, opacity: highlightOpacity },
          ]}
        />
      ) : null}
    </View>
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title: SCREEN_TITLES.notifications,
      headerTitle: '',
      headerTransparent: true,
    });
  }, [navigation]);

  // Transform slide-in, not opacity — fractional alpha on an ancestor kills
  // UIVisualEffectView glass materials (see StickyHeaderPill).
  const headerTranslate = scrollY.interpolate({
    inputRange: [0, 60],
    outputRange: [-160, 0],
    extrapolate: 'clamp',
  });

  const osStatusLabel = useMemo(() => {
    switch (permission.state) {
      case 'granted':
        return 'Allowed';
      case 'provisional':
        return 'Deliver Quietly';
      case 'ephemeral':
        return 'Temporary';
      case 'denied':
        return 'Blocked';
      default:
        return 'Not Decided';
    }
  }, [permission.state]);

  const appStatusLabel = preferences.pushEnabled ? 'Enabled' : 'Off in ManaSplit';
  const deliveryStatusLabel = useMemo(() => {
    switch (currentDevice?.registrationStatus) {
      case 'active':
        return 'Registered';
      case 'invalid_token':
        return 'Token Invalid';
      case 'permission_blocked':
        return 'Waiting on iPhone';
      case 'signed_out':
        return 'Signed Out';
      case 'token_missing':
        return 'Not Registered';
      case 'error':
        return 'Registration Error';
      default:
        return 'Checking';
    }
  }, [currentDevice?.registrationStatus]);

  const pushReady =
    preferences.pushEnabled &&
    permission.granted &&
    currentDevice?.registrationStatus === 'active' &&
    Boolean(pushToken);

  const remoteTestBlockedReason = useMemo(() => {
    if (permission.state === 'denied') {
      return 'iPhone settings are currently blocking notifications for ManaSplit.';
    }

    if (!preferences.pushEnabled) {
      return 'Enable notifications in ManaSplit before running a remote test.';
    }

    if (!currentDevice) {
      return 'This device has not synced its registration record yet.';
    }

    if (!pushToken || currentDevice.registrationStatus !== 'active') {
      return currentDevice.lastRegistrationError
        ?? 'This device does not have an active Expo push token yet. Refresh this device first.';
    }

    return null;
  }, [
    currentDevice,
    permission.state,
    preferences.pushEnabled,
    pushToken,
  ]);

  const statusCard = useMemo(() => {
    if (permission.state === 'denied') {
      return {
        title: 'Notifications are blocked by iPhone settings',
        description:
          'ManaSplit cannot deliver push notifications until notifications are allowed in Settings for this device.',
        accent: '#EF4444',
      };
    }

    if (!preferences.pushEnabled) {
      return {
        title: 'Notifications are off in ManaSplit',
        description:
          'iPhone permission may already be available, but this account is currently opted out inside the app.',
        accent: '#F59E0B',
      };
    }

    if (currentDevice?.registrationStatus === 'invalid_token') {
      return {
        title: 'This device needs to refresh its push token',
        description:
          'Delivery failed after registration. Refreshing registration should replace the invalid token on the server.',
        accent: '#F97316',
      };
    }

    if (permission.state === 'provisional' || permission.state === 'ephemeral') {
      return {
        title: 'Notifications can arrive quietly',
        description:
          'Push is allowed, but iOS may deliver without the full alert experience until the permission is promoted.',
        accent: '#38BDF8',
      };
    }

    if (pushReady) {
      return {
        title: 'This device is ready for remote push delivery',
        description:
          'OS permission, app preference, token registration, and Expo handoff are all aligned for this device.',
        accent: '#10B981',
      };
    }

    return {
      title: 'ManaSplit is still registering this device',
      description:
        'The app is allowed to notify you, but this device has not finished registration with the backend yet.',
      accent: '#60A5FA',
    };
  }, [
    currentDevice?.registrationStatus,
    permission.granted,
    permission.state,
    preferences.pushEnabled,
    pushReady,
  ]);

  const categoryControlsDisabled = !preferences.pushEnabled || !permission.granted;
  const primaryTextColor = theme.colors.onSurface;
  const secondaryTextColor = isDark ? '#D1D5DB' : '#334155';
  const tertiaryTextColor = isDark ? '#9CA3AF' : '#64748B';
  const noticeColor = isDark ? '#FBBF24' : '#B45309';
  const categoryDisabledReason = permission.state === 'denied'
    ? 'Turn notifications on in iPhone Settings before category toggles can take effect.'
    : !preferences.pushEnabled
      ? 'Enable notifications in ManaSplit before choosing categories.'
      : null;

  const handleRefreshRegistration = async (requestPermission = false) => {
    setIsRefreshing(true);
    try {
      await refreshRegistration({ requestPermission });
    } catch (error) {
      appAlert('Registration refresh failed', getErrorMessage(error));
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleMasterToggle = async (enabled: boolean) => {
    selectionHaptic();

    if (!enabled) {
      await updatePreference('pushEnabled', false);
      return;
    }

    if (!permission.granted) {
      await handleRefreshRegistration(true);
    }

    if (!permission.granted && permission.state === 'denied') {
      appAlert(
        'Notifications are blocked',
        'Enable notifications for ManaSplit in iPhone Settings, then return here to finish setup.',
        [
          { text: 'Not Now', style: 'cancel' },
          {
            text: 'Open Settings',
            onPress: () => {
              void openSystemSettings();
            },
          },
        ],
      );
      return;
    }

    await updatePreference('pushEnabled', true);
    await handleRefreshRegistration(false);
  };

  const handleRemoteTest = async () => {
    lightHaptic();

    if (remoteTestBlockedReason) {
      appAlert('Remote test unavailable', remoteTestBlockedReason);
      return;
    }

    setIsSendingRemoteTest(true);

    try {
      const result = await sendRemoteTestNotification();
      appAlert(
        'Remote test queued',
        `Delivery ${result.deliveryId} was queued for ${result.acceptedCount} device${result.acceptedCount === 1 ? '' : 's'}. Check this iPhone for the live push alert.`,
      );
    } catch (error) {
      appAlert('Remote test failed', getErrorMessage(error));
    } finally {
      setIsSendingRemoteTest(false);
    }
  };

  const handleLocalTest = async () => {
    lightHaptic();
    setIsSendingLocalTest(true);

    try {
      await sendLocalTestNotification();
    } catch (error) {
      appAlert('Local test failed', getErrorMessage(error));
    } finally {
      setIsSendingLocalTest(false);
    }
  };

  const handleLoadCallDebug = async () => {
    lightHaptic();
    setIsLoadingCallDebug(true);
    try {
      const entries = await getCallDebugEntries();
      setCallDebugCount(entries.length);
      setCallDebugText(formatCallDebugEntries(entries));
    } catch (error) {
      appAlert('Call debug log', getErrorMessage(error));
    } finally {
      setIsLoadingCallDebug(false);
    }
  };

  const handleCopyCallDebug = async () => {
    if (!callDebugText) {
      return;
    }
    lightHaptic();
    try {
      await Clipboard.setStringAsync(callDebugText);
      appAlert('Copied', 'The call debug log was copied to your clipboard.');
    } catch (error) {
      appAlert('Copy failed', getErrorMessage(error));
    }
  };

  const handleClearCallDebug = async () => {
    lightHaptic();
    try {
      await clearCallDebugLedger();
      setCallDebugText(null);
      setCallDebugCount(0);
    } catch (error) {
      appAlert('Clear failed', getErrorMessage(error));
    }
  };

  const runtimeLabel = currentDevice
    ? currentDevice.isPhysicalDevice
      ? 'Physical device'
      : 'Simulator or non-device runtime reported by Expo'
    : 'Waiting for device diagnostics';

  return (
    <LiquidBackground>
      <Animated.View
        style={[
          styles.stickyHeader,
          { transform: [{ translateY: headerTranslate }], paddingTop: insets.top + 8 },
        ]}
        pointerEvents="none"
      >
        <GlassView role="floating" style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={{ fontWeight: 'bold', color: primaryTextColor }}>
            {SCREEN_TITLES.notifications}
          </Text>
        </GlassView>
      </Animated.View>

      <Animated.ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.container,
          {
            paddingTop: insets.top + TRANSPARENT_HEADER_CLEARANCE,
            paddingBottom: insets.bottom + 32,
          },
        ]}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true },
        )}
        scrollEventThrottle={16}
      >
        <View style={styles.titleContainer}>
          <Text variant="displaySmall" style={[styles.screenTitle, { color: primaryTextColor }]}>
            {SCREEN_TITLES.notifications}
          </Text>
        </View>
        <GlassView
          style={[
            styles.heroCard,
            {
              borderColor: `${statusCard.accent}66`,
              backgroundColor: isDark ? 'rgba(17, 24, 39, 0.34)' : 'rgba(255, 255, 255, 0.22)',
            },
          ]}
          contentStyle={styles.heroContent}
          intensity={38}
        >
          <View style={styles.heroBrandRow}>
            <View
              style={[
                styles.heroMarkShell,
                { backgroundColor: isDark ? 'rgba(42, 11, 64, 0.72)' : 'rgba(251, 247, 240, 0.74)' },
              ]}
            >
              <MugguMark
                size={40}
                variant={isDark ? 'reversed' : 'primary'}
                accessibilityLabel={`${APP_NAME} notification logo`}
              />
            </View>
            <View style={styles.heroBrandCopy}>
              <Text variant="labelLarge" style={[styles.eyebrow, { color: statusCard.accent }]}>
                {APP_NAME} notifications
              </Text>
              <Text variant="bodySmall" style={{ color: tertiaryTextColor }}>
                This {currentDevice?.platform === 'android' ? 'Android device' : 'iPhone'}
              </Text>
            </View>
          </View>
          <Text variant="headlineSmall" style={[styles.heroTitle, { color: primaryTextColor }]}>
            {statusCard.title}
          </Text>
          <Text variant="bodyMedium" style={[styles.heroDescription, { color: secondaryTextColor }]}>
            {statusCard.description}
          </Text>

          <View style={styles.statusPillRow}>
            <StatusPill
              label="OS"
              value={osStatusLabel}
              color={statusCard.accent}
              textColor={primaryTextColor}
            />
            <StatusPill
              label="App"
              value={appStatusLabel}
              color={preferences.pushEnabled ? '#10B981' : '#F59E0B'}
              textColor={primaryTextColor}
            />
            <StatusPill
              label="Delivery"
              value={deliveryStatusLabel}
              color={pushReady ? '#10B981' : '#60A5FA'}
              textColor={primaryTextColor}
            />
          </View>

          <View style={styles.heroActions}>
            <Button
              mode="contained"
              onPress={() => {
                if (permission.state === 'denied') {
                  void openSystemSettings();
                } else {
                  void handleRefreshRegistration(permission.state === 'undetermined');
                }
              }}
              loading={isRefreshing}
              disabled={isRefreshing}
            >
              {permission.state === 'denied' ? 'Open iPhone Settings' : 'Refresh This Device'}
            </Button>
            <Button
              mode="outlined"
              onPress={() => {
                void handleRemoteTest();
              }}
              loading={isSendingRemoteTest}
              disabled={isSendingRemoteTest || Boolean(remoteTestBlockedReason)}
            >
              Send Remote Test
            </Button>
          </View>
          {remoteTestBlockedReason ? (
            <Text variant="bodySmall" style={[styles.inlineNotice, { color: noticeColor }]}>
              {remoteTestBlockedReason}
            </Text>
          ) : null}
        </GlassView>

        <GlassView style={styles.sectionCard} contentStyle={styles.sectionContent}>
          <Text variant="titleMedium" style={[styles.sectionTitle, { color: primaryTextColor }]}>
            Notification Access
          </Text>
          <Text variant="bodySmall" style={[styles.sectionDescription, { color: tertiaryTextColor }]}>
            ManaSplit only delivers remote push when both iOS and your in-app preference allow it.
          </Text>

          {wrapAnchor(SETTING_IDS.notifMaster, (
            <ToggleRow
              title="Allow notifications in ManaSplit"
              description={
                permission.state === 'denied'
                  ? 'Blocked by iPhone. Open Settings to allow notifications for this app.'
                  : preferences.pushEnabled
                    ? 'Remote push is enabled for your account.'
                    : 'Turn this on to let ManaSplit deliver remote push on your registered devices.'
              }
              value={preferences.pushEnabled}
              icon={preferences.pushEnabled ? 'bell-ring-outline' : 'bell-off-outline'}
              iconColor={preferences.pushEnabled ? theme.colors.primary : '#F59E0B'}
              onValueChange={handleMasterToggle}
            />
          ))}

          <Divider />

          <List.Item
            title="iPhone permission"
            description={
              permission.state === 'denied'
                ? 'Notifications are currently blocked by iOS.'
                : permission.state === 'provisional'
                  ? 'Allowed quietly by iOS.'
                  : permission.state === 'undetermined'
                    ? 'ManaSplit has not asked for permission yet.'
                    : 'iOS is allowing notifications for this app.'
            }
            left={() => (
              <List.Icon
                icon={permission.state === 'denied' ? 'apple-keyboard-command' : 'cellphone-cog'}
                color={permission.state === 'denied' ? '#EF4444' : theme.colors.primary}
              />
            )}
            right={() => (
              <Button compact onPress={() => void openSystemSettings()}>
                Settings
              </Button>
            )}
          />
        </GlassView>

        <GlassView
          style={[styles.sectionCard, categoryControlsDisabled && styles.disabledSection]}
          contentStyle={styles.sectionContent}
        >
          <Text variant="titleMedium" style={[styles.sectionTitle, { color: primaryTextColor }]}>
            Categories
          </Text>
          <Text variant="bodySmall" style={[styles.sectionDescription, { color: tertiaryTextColor }]}>
            Keep account-wide categories in sync while OS permission remains device-specific.
          </Text>
          {categoryDisabledReason ? (
            <Text variant="bodySmall" style={[styles.inlineNotice, { color: noticeColor }]}>
              {categoryDisabledReason}
            </Text>
          ) : null}

          {wrapAnchor(SETTING_IDS.notifMessages, (
            <ToggleRow
              title="Messages"
              description="New chat messages from groups and direct chats"
              value={preferences.messages !== false}
              icon="chat-outline"
              iconColor={theme.colors.primary}
              disabled={categoryControlsDisabled}
              onValueChange={(value) => updatePreference('messages', value)}
            />
          ))}
          <Divider />
          {/* Per-device, not per-account (doc 31 decision #13): the registry
              scopes this 'local' because "should THIS phone ring?" has a
              different right answer on a bedside iPad than on the phone in
              your pocket. */}
          <ToggleRow
            title="Ring on this device"
            description="Turn off to stop calls ringing here. Your other devices still ring."
            value={ringHere}
            icon="bell-ring-outline"
            iconColor="#EF4444"
            onValueChange={async (value) => {
              if (!user?.userId) return;
              setRingHere(value);
              await setRingOnThisDevice(user.userId, value);
            }}
          />
          <Divider />
          {wrapAnchor(SETTING_IDS.notifExpenses, (
            <ToggleRow
              title="Expenses"
              description="New expenses and split requests"
              value={preferences.expenses !== false}
              icon="currency-usd"
              iconColor="#10B981"
              disabled={categoryControlsDisabled}
              onValueChange={(value) => updatePreference('expenses', value)}
            />
          ))}
          <Divider />
          {wrapAnchor(SETTING_IDS.notifSettlements, (
            <ToggleRow
              title="Settlements"
              description="Payment settlements and confirmations"
              value={preferences.settlements !== false}
              icon="handshake-outline"
              iconColor="#F59E0B"
              disabled={categoryControlsDisabled}
              onValueChange={(value) => updatePreference('settlements', value)}
            />
          ))}
          <Divider />
          {wrapAnchor(SETTING_IDS.notifGroup, (
            <ToggleRow
              title="Group Updates"
              description="Members joining or leaving groups"
              value={preferences.groupUpdates !== false}
              icon="account-group-outline"
              iconColor="#8B5CF6"
              disabled={categoryControlsDisabled}
              onValueChange={(value) => updatePreference('groupUpdates', value)}
            />
          ))}
          <Divider />
          {wrapAnchor(SETTING_IDS.notifCalls, (
            <ToggleRow
              title="Calls"
              description="Incoming voice and video call alerts"
              value={preferences.calls !== false}
              icon="phone-ring-outline"
              iconColor="#EF4444"
              disabled={categoryControlsDisabled}
              onValueChange={(value) => updatePreference('calls', value)}
            />
          ))}
        </GlassView>

        <GlassView
          style={[styles.sectionCard, !preferences.pushEnabled && styles.disabledSection]}
          contentStyle={styles.sectionContent}
        >
          <Text variant="titleMedium" style={[styles.sectionTitle, { color: primaryTextColor }]}>
            Sound and Haptics
          </Text>
          <Text variant="bodySmall" style={[styles.sectionDescription, { color: tertiaryTextColor }]}>
            These preferences only apply when notifications are enabled in ManaSplit.
          </Text>

          {wrapAnchor(SETTING_IDS.notifSounds, (
            <ToggleRow
              title="Notification sounds"
              description="Play sounds for incoming notifications"
              value={preferences.sounds !== false}
              icon="volume-high"
              iconColor={theme.colors.primary}
              disabled={!preferences.pushEnabled}
              onValueChange={(value) => updatePreference('sounds', value)}
            />
          ))}
          <Divider />
          {wrapAnchor(SETTING_IDS.notifVibration, (
            <ToggleRow
              title="Vibration"
              description="Vibrate when notifications arrive"
              value={preferences.vibration !== false}
              icon="vibrate"
              iconColor={theme.colors.primary}
              disabled={!preferences.pushEnabled}
              onValueChange={(value) => updatePreference('vibration', value)}
            />
          ))}
        </GlassView>

        <GlassView style={styles.sectionCard} contentStyle={styles.sectionContent}>
          <Text variant="titleMedium" style={[styles.sectionTitle, { color: primaryTextColor }]}>
            Diagnostics
          </Text>
          <Text variant="bodySmall" style={[styles.sectionDescription, { color: tertiaryTextColor }]}>
            Remote tests use the backend, Expo Push Service, and receipt tracking. Local tests only preview on-device presentation.
          </Text>

          <View style={styles.buttonRow}>
            <Button
              mode="contained"
              onPress={() => {
                void handleRemoteTest();
              }}
              loading={isSendingRemoteTest}
              disabled={isSendingRemoteTest || Boolean(remoteTestBlockedReason)}
            >
              Remote Test
            </Button>
            <Button
              mode="outlined"
              onPress={() => {
                void handleLocalTest();
              }}
              loading={isSendingLocalTest}
              disabled={isSendingLocalTest}
            >
              Local Preview
            </Button>
          </View>

          <Divider style={styles.diagnosticsDivider} />

          <List.Item
            title="Push service"
            description="Expo Push Service with APNs on iOS and FCM on Android"
            left={() => <List.Icon icon="cloud-outline" color={theme.colors.primary} />}
          />
          <Divider />
          <List.Item
            title="Registration status"
            description={deliveryStatusLabel}
            left={() => <List.Icon icon="radar" color={theme.colors.primary} />}
          />
          <Divider />
          <List.Item
            title="Device runtime"
            description={runtimeLabel}
            left={() => <List.Icon icon="cellphone-information" color={theme.colors.primary} />}
          />
          <Divider />
          <List.Item
            title="Push token"
            description={pushToken ? `${pushToken.slice(0, 48)}${pushToken.length > 48 ? '…' : ''}` : 'No Expo push token registered yet'}
            left={() => <List.Icon icon="key-outline" color={theme.colors.primary} />}
          />
          <Divider />
          <List.Item
            title="Last registration sync"
            description={formatTimestamp(currentDevice?.lastRegisteredAt ?? null)}
            left={() => <List.Icon icon="refresh" color={theme.colors.primary} />}
          />
          <Divider />
          <List.Item
            title="Last delivery receipt"
            description={
              currentDevice?.lastReceiptStatus
                ? `${currentDevice.lastReceiptStatus.toUpperCase()} · ${formatTimestamp(currentDevice.lastReceiptAt)}`
                : 'No Expo receipt has been recorded for this device yet'
            }
            left={() => <List.Icon icon="message-badge-outline" color={theme.colors.primary} />}
          />
          {currentDevice?.lastReceiptError ? (
            <>
              <Divider />
              <List.Item
                title="Last receipt error"
                description={currentDevice.lastReceiptError}
                left={() => <List.Icon icon="alert-circle-outline" color="#EF4444" />}
              />
            </>
          ) : null}
          {currentDevice?.lastRegistrationError ? (
            <>
              <Divider />
              <List.Item
                title="Last registration error"
                description={currentDevice.lastRegistrationError}
                left={() => <List.Icon icon="alert-outline" color="#F97316" />}
              />
            </>
          ) : null}

          <Divider style={styles.diagnosticsDivider} />
          <List.Item
            title="Call debug log"
            description={
              callDebugText === null
                ? 'Persistent breadcrumbs from the Recents redial / CallKit pipeline.'
                : `${callDebugCount} entr${callDebugCount === 1 ? 'y' : 'ies'} recorded (newest first).`
            }
            left={() => <List.Icon icon="phone-log" color={theme.colors.primary} />}
          />
          <View style={styles.buttonRow}>
            <Button
              mode="contained"
              onPress={() => {
                void handleLoadCallDebug();
              }}
              loading={isLoadingCallDebug}
            >
              {callDebugText === null ? 'View log' : 'Refresh'}
            </Button>
            <Button
              mode="outlined"
              onPress={() => {
                void handleCopyCallDebug();
              }}
              disabled={!callDebugText}
            >
              Copy all
            </Button>
            <Button
              mode="text"
              onPress={() => {
                void handleClearCallDebug();
              }}
            >
              Clear
            </Button>
          </View>
          {callDebugText !== null ? (
            <ScrollView style={styles.callDebugLogBox} nestedScrollEnabled>
              <Text
                variant="bodySmall"
                selectable
                style={[styles.callDebugLogText, { color: secondaryTextColor }]}
              >
                {callDebugText}
              </Text>
            </ScrollView>
          ) : null}
        </GlassView>
      </Animated.ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    // Tightened 16 -> 8 (2026-08-07, compact density pass).
    gap: 8,
  },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingHorizontal: 16,
    paddingBottom: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stickyHeaderGlass: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
  },
  titleContainer: {
    paddingBottom: 8,
  },
  screenTitle: {
    fontWeight: 'bold',
  },
  heroCard: {
    borderRadius: 28,
    borderWidth: 1.2,
  },
  heroContent: {
    padding: 20,
    gap: 14,
  },
  heroBrandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  heroMarkShell: {
    width: 52,
    height: 52,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroBrandCopy: {
    flex: 1,
    gap: 2,
  },
  eyebrow: {
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  heroTitle: {
    fontWeight: '700',
  },
  heroDescription: {
    lineHeight: 22,
  },
  statusPillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  statusPill: {
    minWidth: 92,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  statusPillLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statusPillValue: {
    fontWeight: '600',
  },
  heroActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  sectionCard: {
    borderRadius: 24,
  },
  sectionContent: {
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  sectionTitle: {
    fontWeight: '700',
    paddingHorizontal: 8,
  },
  sectionDescription: {
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 8,
    lineHeight: 20,
  },
  inlineNotice: {
    paddingHorizontal: 8,
    paddingBottom: 8,
    lineHeight: 20,
  },
  disabledSection: {
    opacity: 0.62,
  },
  disabledText: {
    color: '#6B7280',
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 8,
    paddingTop: 4,
  },
  diagnosticsDivider: {
    marginTop: 12,
  },
  callDebugLogBox: {
    maxHeight: 260,
    marginHorizontal: 8,
    marginTop: 8,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(148, 163, 184, 0.4)',
    backgroundColor: 'rgba(15, 23, 42, 0.28)',
    padding: 10,
  },
  callDebugLogText: {
    fontFamily: 'Courier',
    lineHeight: 18,
  },
});
