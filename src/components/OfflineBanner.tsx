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
import { StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const OfflineBanner = () => {
  const { isOnline } = useOfflineSync();
  const { isDark } = useTheme();
  const insets = useSafeAreaInsets();

  if (isOnline) {
    return null;
  }

  const bg = isDark ? 'rgba(60,40,10,0.92)' : 'rgba(255,244,224,0.96)';
  const fg = isDark ? '#FFE0A3' : '#7A4F00';

  return (
    <View style={[styles.strip, { paddingTop: insets.top + 6, backgroundColor: bg }]}>
      <Icon source="wifi-off" size={15} color={fg} />
      <Text variant="labelMedium" style={[styles.label, { color: fg }]}>
        Offline — showing saved data. Edits will sync when you reconnect.
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
