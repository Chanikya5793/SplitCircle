/**
 * OfflineBanner — slim, safe-area-aware strip shown at the top of every screen
 * when the device loses connectivity. SplitCircle hydrates groups from the
 * on-device cache (services/groupCache) and the on-device AI keeps working, so
 * the message reassures rather than alarms: saved data is shown and edits queue.
 *
 * The visible strip overlays the status-bar safe area while a spacer reserves
 * only the strip's content row. Screens continue to own their safe-area inset,
 * preventing the top inset from being counted twice across the app.
 */

import { useTheme } from '@/context/ThemeContext';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import { useNearbyMessaging } from '@/hooks/useNearbyMessaging';
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const OFFLINE_BANNER_ROW_HEIGHT = 34;

export const OfflineBanner = () => {
  const { isOnline } = useOfflineSync();
  const { theme } = useTheme();
  const { snapshot } = useNearbyMessaging();
  const insets = useSafeAreaInsets();

  if (isOnline) {
    return null;
  }

  const connected = snapshot.status === 'connected';
  const needsAttention = snapshot.status === 'error' || snapshot.status === 'unavailable';
  const label = connected
    ? `Offline · Nearby connected to ${snapshot.connectedPeerCount} ${snapshot.connectedPeerCount === 1 ? 'phone' : 'phones'}`
    : needsAttention
      ? 'Offline · Nearby needs attention. Open a chat for help.'
      : 'Offline · Nearby is searching. Open a chat for connection help.';
  const backgroundColor = connected
    ? theme.colors.successContainer
    : theme.colors.warningContainer;
  const foregroundColor = connected
    ? theme.colors.onSuccessContainer
    : theme.colors.onWarningContainer;

  return (
    <>
      <View
        pointerEvents="none"
        style={[
          styles.strip,
          {
            height: insets.top + OFFLINE_BANNER_ROW_HEIGHT,
            paddingTop: insets.top,
            backgroundColor,
          },
        ]}
      >
        <Icon source={connected ? 'access-point-network' : 'wifi-off'} size={15} color={foregroundColor} />
        <Text variant="labelMedium" style={[styles.label, { color: foregroundColor }]}>
          {label}
        </Text>
      </View>
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.spacer}
      />
    </>
  );
};

const styles = StyleSheet.create({
  strip: {
    position: 'absolute',
    zIndex: 100,
    elevation: 100,
    top: 0,
    right: 0,
    left: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  spacer: {
    height: OFFLINE_BANNER_ROW_HEIGHT,
  },
  label: { textAlign: 'center', flexShrink: 1 },
});
