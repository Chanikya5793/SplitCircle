/**
 * OfflineBanner — slim, safe-area-aware strip shown at the top of every screen
 * when the device loses connectivity. SplitCircle hydrates groups from the
 * on-device cache (services/groupCache) and the on-device AI keeps working, so
 * the message reassures rather than alarms: saved data is shown and edits queue.
 *
 * Kept deliberately thin and translucent so it doesn't fight the liquid-glass
 * background (the app's DNA). Renders nothing while online.
 */

import { useTheme } from '@/context/ThemeContext';
import { useOfflineSync } from '@/hooks/useOfflineSync';
import { useNearbyMessaging } from '@/hooks/useNearbyMessaging';
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
    <View style={[styles.strip, { paddingTop: insets.top + 6, backgroundColor }]}>
      <Icon source={connected ? 'access-point-network' : 'wifi-off'} size={15} color={foregroundColor} />
      <Text variant="labelMedium" style={[styles.label, { color: foregroundColor }]}>
        {label}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingBottom: 8,
    paddingHorizontal: 16,
  },
  label: { textAlign: 'center', flexShrink: 1 },
});
