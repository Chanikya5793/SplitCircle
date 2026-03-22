import { GlassView } from '@/components/GlassView';
import { LiquidBackground } from '@/components/LiquidBackground';
import { useNotificationContext } from '@/context/NotificationContext';
import { useTheme } from '@/context/ThemeContext';
import { getNotificationPermissionStatus } from '@/utils/notifications';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Linking,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { Button, Divider, List, Switch, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { lightHaptic, selectionHaptic } from '@/utils/haptics';

export const NotificationSettingsScreen = () => {
  const navigation = useNavigation();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const scrollY = useRef(new Animated.Value(0)).current;
  const {
    preferences,
    permissionGranted,
    pushToken,
    updatePreference,
    sendTestNotification,
  } = useNotificationContext();

  const [osPermission, setOsPermission] = useState<string>('undetermined');

  useLayoutEffect(() => {
    navigation.setOptions({
      title: 'Notifications',
      headerBackTitle: 'Settings',
    });
  }, [navigation]);

  useEffect(() => {
    const checkPermission = async () => {
      const status = await getNotificationPermissionStatus();
      setOsPermission(status);
    };
    void checkPermission();
  }, []);

  const headerOpacity = scrollY.interpolate({
    inputRange: [0, 40],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });

  const handleMasterToggle = async (enabled: boolean) => {
    selectionHaptic();
    if (enabled && osPermission !== 'granted') {
      Alert.alert(
        'Enable Notifications',
        'You need to allow notifications in your device settings to receive push notifications.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open Settings',
            onPress: () => {
              if (Platform.OS === 'ios') {
                void Linking.openURL('app-settings:');
              } else {
                void Linking.openSettings();
              }
            },
          },
        ],
      );
      return;
    }
    await updatePreference('pushEnabled', enabled);
  };

  const handleCategoryToggle = async (
    key: 'messages' | 'expenses' | 'settlements' | 'groupUpdates' | 'calls',
    value: boolean,
  ) => {
    selectionHaptic();
    await updatePreference(key, value);
  };

  const handleSoundToggle = async (value: boolean) => {
    selectionHaptic();
    await updatePreference('sounds', value);
  };

  const handleVibrationToggle = async (value: boolean) => {
    selectionHaptic();
    await updatePreference('vibration', value);
  };

  const handleTestNotification = async () => {
    lightHaptic();
    await sendTestNotification();
  };

  const isPushEnabled = preferences.pushEnabled && permissionGranted;

  return (
    <LiquidBackground>
      <Animated.View style={[styles.stickyHeader, { opacity: headerOpacity }]}>
        <GlassView style={styles.stickyHeaderGlass}>
          <Text variant="titleMedium" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
            Notifications
          </Text>
        </GlassView>
      </Animated.View>

      <Animated.ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 32 }]}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true },
        )}
        scrollEventThrottle={16}
      >
        <View style={styles.headerContainer}>
          <Text variant="displaySmall" style={{ fontWeight: 'bold', color: theme.colors.onSurface }}>
            Notifications
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.secondary, marginTop: 4 }}
          >
            Control how SplitCircle keeps you updated
          </Text>
        </View>

        {/* Status Banner */}
        {!permissionGranted && (
          <GlassView style={[styles.statusBanner, { borderColor: '#EF4444' }]}>
            <View style={styles.statusBannerContent}>
              <List.Icon icon="bell-off-outline" color="#EF4444" />
              <View style={{ flex: 1 }}>
                <Text variant="titleSmall" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                  Notifications Blocked
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.secondary, marginTop: 2 }}>
                  Enable in device settings to receive push notifications
                </Text>
              </View>
            </View>
            <Button
              mode="contained"
              compact
              style={{ marginTop: 8, alignSelf: 'flex-end' }}
              onPress={() => {
                if (Platform.OS === 'ios') {
                  void Linking.openURL('app-settings:');
                } else {
                  void Linking.openSettings();
                }
              }}
            >
              Open Settings
            </Button>
          </GlassView>
        )}

        {/* Master Toggle */}
        <GlassView style={styles.settingsList}>
          <List.Section>
            <List.Item
              title="Push Notifications"
              description={isPushEnabled ? 'Enabled' : 'Disabled'}
              left={() => (
                <List.Icon
                  icon={isPushEnabled ? 'bell-ring' : 'bell-off'}
                  color={isPushEnabled ? theme.colors.primary : theme.colors.secondary}
                />
              )}
              right={() => (
                <Switch
                  value={preferences.pushEnabled}
                  onValueChange={handleMasterToggle}
                />
              )}
            />
          </List.Section>
        </GlassView>

        {/* Category Toggles */}
        <GlassView style={[styles.settingsList, !isPushEnabled && styles.disabledSection]}>
          <List.Section>
            <List.Subheader>Notification Categories</List.Subheader>

            <List.Item
              title="Messages"
              description="New chat messages from groups and direct chats"
              left={() => <List.Icon icon="chat" color={theme.colors.primary} />}
              right={() => (
                <Switch
                  value={preferences.messages !== false}
                  onValueChange={(v) => handleCategoryToggle('messages', v)}
                  disabled={!isPushEnabled}
                />
              )}
            />
            <Divider />

            <List.Item
              title="Expenses"
              description="New expenses and split requests"
              left={() => <List.Icon icon="currency-usd" color="#10B981" />}
              right={() => (
                <Switch
                  value={preferences.expenses !== false}
                  onValueChange={(v) => handleCategoryToggle('expenses', v)}
                  disabled={!isPushEnabled}
                />
              )}
            />
            <Divider />

            <List.Item
              title="Settlements"
              description="Payment settlements and confirmations"
              left={() => <List.Icon icon="handshake" color="#F59E0B" />}
              right={() => (
                <Switch
                  value={preferences.settlements !== false}
                  onValueChange={(v) => handleCategoryToggle('settlements', v)}
                  disabled={!isPushEnabled}
                />
              )}
            />
            <Divider />

            <List.Item
              title="Group Updates"
              description="Members joining or leaving groups"
              left={() => <List.Icon icon="account-group" color="#8B5CF6" />}
              right={() => (
                <Switch
                  value={preferences.groupUpdates !== false}
                  onValueChange={(v) => handleCategoryToggle('groupUpdates', v)}
                  disabled={!isPushEnabled}
                />
              )}
            />
            <Divider />

            <List.Item
              title="Calls"
              description="Incoming voice and video calls"
              left={() => <List.Icon icon="phone-ring" color="#EF4444" />}
              right={() => (
                <Switch
                  value={preferences.calls !== false}
                  onValueChange={(v) => handleCategoryToggle('calls', v)}
                  disabled={!isPushEnabled}
                />
              )}
            />
          </List.Section>
        </GlassView>

        {/* Sound & Vibration */}
        <GlassView style={[styles.settingsList, !isPushEnabled && styles.disabledSection]}>
          <List.Section>
            <List.Subheader>Sound & Haptics</List.Subheader>

            <List.Item
              title="Notification Sounds"
              description="Play sounds for incoming notifications"
              left={() => <List.Icon icon="volume-high" />}
              right={() => (
                <Switch
                  value={preferences.sounds !== false}
                  onValueChange={handleSoundToggle}
                  disabled={!isPushEnabled}
                />
              )}
            />
            <Divider />

            <List.Item
              title="Vibration"
              description="Vibrate on notification arrival"
              left={() => <List.Icon icon="vibrate" />}
              right={() => (
                <Switch
                  value={preferences.vibration !== false}
                  onValueChange={handleVibrationToggle}
                  disabled={!isPushEnabled}
                />
              )}
            />
          </List.Section>
        </GlassView>

        {/* Test & Debug */}
        <GlassView style={styles.settingsList}>
          <List.Section>
            <List.Subheader>Testing</List.Subheader>
            <List.Item
              title="Send Test Notification"
              description="Verify notifications are working"
              left={() => <List.Icon icon="send" color={theme.colors.primary} />}
              onPress={handleTestNotification}
            />
            {pushToken && (
              <>
                <Divider />
                <List.Item
                  title="Push Token"
                  description={pushToken.length > 40 ? `${pushToken.slice(0, 40)}…` : pushToken}
                  left={() => <List.Icon icon="key-variant" />}
                />
              </>
            )}
          </List.Section>
        </GlassView>
      </Animated.ScrollView>
    </LiquidBackground>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: 16,
    paddingTop: 60,
  },
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingTop: 50,
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
  headerContainer: {
    paddingHorizontal: 8,
    paddingBottom: 16,
  },
  statusBanner: {
    borderRadius: 20,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
  },
  statusBannerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  settingsList: {
    borderRadius: 24,
    overflow: 'hidden',
    marginBottom: 16,
  },
  disabledSection: {
    opacity: 0.5,
  },
});
